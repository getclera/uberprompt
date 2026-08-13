import type { ObjectId } from "mongodb";
import {
  evalRunsCol,
  lessonsCol,
  loadPrompt,
  proposalsCol,
  tracesCol,
  withTransaction,
  type EvalRunDoc,
  type EvalRunSummary,
  type LessonDoc,
  type ProposalDoc,
  type PromptDoc,
} from "@uberprompt/sdk";
import { authorCandidate } from "./author";
import { findCulprit } from "./diagnose";
import { collectCases, runEval } from "./evals";
import { targetPrompts, type TargetHit, type TargetRung } from "./targeting";
import type { Candidate, Culprit, EvalReport } from "./types";

export const MAX_ATTEMPTS = 2;

const OPEN_STATUSES = ["pending", "evaluating"] as const;

function fragmentText(doc: PromptDoc, key: string): string {
  const fragment = doc.fragments.find((f) => f.key === key);
  if (!fragment) throw new Error(`Prompt "${doc.name}" has no fragment "${key}"`);
  return fragment.text;
}

function siblingsOf(doc: PromptDoc, key: string): Array<{ key: string; text: string }> {
  return doc.fragments
    .filter((f) => f.key !== key && f.text.length > 0)
    .map((f) => ({ key: f.key, text: f.text }));
}

function critiqueFrom(report: EvalReport): string {
  const failures = report.cases.filter((c) => c.verdict === "loss");
  const losers = failures.length > 0 ? failures : report.cases.filter((c) => c.verdict === "tie");
  return losers.map((c) => `[${c.caseId}] ${c.critique}`).join("\n\n");
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function isDuplicateProposal(open: ProposalDoc[], newText: string): boolean {
  return open.some((p) => normalize(p.newText) === normalize(newText));
}

export function hasOpenProposalForLesson(open: ProposalDoc[], lessonId: ObjectId): boolean {
  return open.some((p) => p.source.ref?.equals(lessonId) === true);
}

async function openProposalsFor(prompt: string, fragment: string): Promise<ProposalDoc[]> {
  return proposalsCol()
    .find({ "target.prompt": prompt, "target.fragment": fragment, status: { $in: [...OPEN_STATUSES] } })
    .toArray();
}

async function loadLesson(lessonId: ObjectId): Promise<LessonDoc> {
  const lesson = await lessonsCol().findOne({ _id: lessonId });
  if (!lesson) throw new Error(`Lesson not found: ${lessonId.toHexString()}`);
  return lesson;
}

async function failingExamplesFor(traceIds: ObjectId[]): Promise<string[]> {
  if (traceIds.length === 0) return [];
  const traces = await tracesCol()
    .find({ _id: { $in: traceIds } })
    .limit(3)
    .toArray();
  return traces.map((t) =>
    [`input: ${JSON.stringify(t.input)}`, `output: ${t.output}`, t.error ? `failure: ${t.error}` : ""]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

export interface ProposalUpdate {
  newText: string;
  reason: string;
  status: "pending" | "rejected";
  evals: { runIds: ObjectId[]; passed: boolean; baselineAvg: number; candidateAvg: number };
}

export function proposalUpdate(
  candidate: Candidate,
  summary: EvalRunSummary,
  runIds: ObjectId[],
): ProposalUpdate {
  return {
    newText: candidate.newText,
    reason: summary.passed ? candidate.reason : `${candidate.reason} — rejected by eval gate`,
    status: summary.passed ? "pending" : "rejected",
    evals: {
      runIds,
      passed: summary.passed,
      baselineAvg: summary.baselineAvg,
      candidateAvg: summary.candidateAvg,
    },
  };
}

export interface PromptOutcome {
  prompt: string;
  rung?: TargetRung;
  status: "pending" | "rejected" | "skipped" | "failed";
  reason: string;
  proposalId?: ObjectId;
  culprit?: Culprit;
  reports: EvalReport[];
}

export interface ApplyResult {
  lessonId: ObjectId;
  targets: TargetHit[];
  outcomes: PromptOutcome[];
}

export async function applyLessonToPrompt(
  lesson: LessonDoc,
  promptName: string,
): Promise<PromptOutcome> {
  const lessonId = lesson._id;
  if (!lessonId) throw new Error("Lesson has no _id");
  const doc = await loadPrompt(promptName);
  const culprit = await findCulprit(lesson, doc);
  const baselineText = fragmentText(doc, culprit.fragment);

  const openBefore = await openProposalsFor(promptName, culprit.fragment);
  if (hasOpenProposalForLesson(openBefore, lessonId)) {
    return {
      prompt: promptName,
      status: "skipped",
      reason: `an open proposal for ${promptName}.${culprit.fragment} from this lesson already exists`,
      culprit,
      reports: [],
    };
  }

  const seed: ProposalDoc = {
    target: { prompt: promptName, fragment: culprit.fragment },
    oldText: baselineText,
    newText: "",
    reason: culprit.rationale,
    source: { type: "lesson", ref: lessonId },
    status: "evaluating",
    ts: new Date(),
    culprit: {
      fragment: culprit.fragment,
      span: culprit.span,
      traceIds: culprit.traceIds,
      sharedWith: culprit.sharedWith,
    },
  };
  const inserted = await proposalsCol().insertOne(seed);
  const proposalId = inserted.insertedId;

  const cases = await collectCases(lesson, promptName);
  if (cases.length === 0) {
    await proposalsCol().deleteOne({ _id: proposalId });
    return {
      prompt: promptName,
      status: "skipped",
      reason: `no evaluable cases for ${promptName} — it has no failing traces from this lesson and no golden set, so the gate cannot judge a candidate`,
      culprit,
      reports: [],
    };
  }
  const examples = await failingExamplesFor(culprit.traceIds);

  const runIds: ObjectId[] = [];
  const reports: EvalReport[] = [];
  let candidate: Candidate | undefined;
  let critique: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    candidate = await authorCandidate({
      lessonText: lesson.text,
      promptName,
      culprit,
      baselineText,
      siblingFragments: siblingsOf(doc, culprit.fragment),
      failingExamples: examples,
      ...(critique ? { critique, previousAttempt: candidate?.newText } : {}),
    });

    if (isDuplicateProposal(openBefore, candidate.newText)) {
      await proposalsCol().deleteOne({ _id: proposalId });
      return {
        prompt: promptName,
        status: "skipped",
        reason: `identical text is already proposed for ${promptName}.${culprit.fragment}`,
        culprit,
        reports,
      };
    }

    const report = await runEval({
      doc,
      fragmentKey: culprit.fragment,
      candidateText: candidate.newText,
      lessonText: lesson.text,
      cases,
    });
    reports.push(report);

    const run: EvalRunDoc = {
      proposalId,
      lessonId,
      target: { prompt: promptName, fragment: culprit.fragment },
      attempt,
      candidateText: candidate.newText,
      cases: report.cases,
      summary: report.summary,
      judgeModel: report.judgeModel,
      genModel: report.genModel,
      ts: new Date(),
    };

    const update = proposalUpdate(candidate, report.summary, runIds);
    const runId = await withTransaction(async (session) => {
      const saved = await evalRunsCol().insertOne(run, { session });
      await proposalsCol().updateOne(
        { _id: proposalId },
        { $set: { ...update, evals: { ...update.evals, runIds: [...runIds, saved.insertedId] } } },
        { session },
      );
      return saved.insertedId;
    });
    runIds.push(runId);

    if (report.summary.passed) break;
    critique = critiqueFrom(report);
  }

  const last = reports[reports.length - 1];
  if (!last || !candidate) throw new Error(`Eval produced no report for ${promptName}`);

  return {
    prompt: promptName,
    status: last.summary.passed ? "pending" : "rejected",
    reason: candidate.reason,
    proposalId,
    culprit,
    reports,
  };
}

export async function applyLesson(
  lessonId: ObjectId,
  opts: { only?: string } = {},
): Promise<ApplyResult> {
  const lesson = await loadLesson(lessonId);
  const targets = opts.only
    ? [{ prompt: opts.only, rung: "lineage" as const, reason: "explicitly requested" }]
    : await targetPrompts(lesson);

  const outcomes: PromptOutcome[] = [];
  for (const target of targets) {
    try {
      const outcome = await applyLessonToPrompt(lesson, target.prompt);
      outcomes.push({ ...outcome, rung: target.rung });
    } catch (error) {
      outcomes.push({
        prompt: target.prompt,
        rung: target.rung,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        reports: [],
      });
    }
  }

  await lessonsCol().updateOne({ _id: lessonId }, { $set: { processedAt: new Date() } });
  return { lessonId, targets, outcomes };
}
