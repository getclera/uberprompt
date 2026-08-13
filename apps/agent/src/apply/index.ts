import type { ObjectId } from "mongodb";
import {
  evalRunsCol,
  lessonsCol,
  loadPrompt,
  proposalsCol,
  tracesCol,
  type EvalRunDoc,
  type EvalRunSummary,
  type LessonDoc,
  type ProposalDoc,
  type PromptDoc,
} from "@uberprompt/sdk";
import { authorCandidate } from "./author";
import { findCulprit } from "./diagnose";
import { collectCases, runEval } from "./evals";
import type { Candidate, Culprit, EvalReport } from "./types";

export const MAX_ATTEMPTS = 2;

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
  return losers
    .map((c) => `[${c.caseId}] ${c.critique}`)
    .join("\n\n");
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

export interface ApplyResult {
  proposal: ProposalDoc;
  culprit: Culprit;
  reports: EvalReport[];
}

export async function applyLesson(lessonId: ObjectId, promptName: string): Promise<ApplyResult> {
  const lesson = await loadLesson(lessonId);
  const doc = await loadPrompt(promptName);
  const culprit = await findCulprit(lesson, doc);
  const baselineText = fragmentText(doc, culprit.fragment);

  const now = new Date();
  const seed: ProposalDoc = {
    target: { prompt: promptName, fragment: culprit.fragment },
    oldText: baselineText,
    newText: "",
    reason: culprit.rationale,
    source: { type: "lesson", ref: lessonId },
    status: "evaluating",
    ts: now,
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
    const savedRun = await evalRunsCol().insertOne(run);
    runIds.push(savedRun.insertedId);

    if (report.summary.passed) break;
    critique = critiqueFrom(report);
  }

  const last = reports[reports.length - 1];
  if (!last || !candidate) throw new Error("Eval produced no report");

  const update = proposalUpdate(candidate, last.summary, runIds);
  await proposalsCol().updateOne({ _id: proposalId }, { $set: update });
  await lessonsCol().updateOne({ _id: lessonId }, { $set: { processedAt: new Date() } });

  return { proposal: { ...seed, ...update, _id: proposalId }, culprit, reports };
}
