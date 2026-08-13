import { readFile } from "node:fs/promises";
import {
  renderPromptDoc,
  tracesCol,
  type EvalCase,
  type EvalRunSummary,
  type LessonDoc,
  type PromptDoc,
  type Rubric,
} from "@uberprompt/sdk";
import { GENERATION_MODEL, REASONING_MODEL, generate } from "../llm";
import { scoreCase } from "./judge";
import { composeInput, fillInputs, withFragment, withOpenSlots } from "./render";
import {
  RUBRIC_AXES,
  WIN_THRESHOLD,
  type EvalCaseSpec,
  type EvalReport,
  type GoldenCase,
} from "./types";

const CONCURRENCY = 6;
const REPLAY_SCORE_CEILING = 0.5;
const REPLAY_CASE_CAP = 3;

export async function loadGolden(promptName: string): Promise<GoldenCase[]> {
  const url = new URL(`../../../demo/golden/${promptName}.json`, import.meta.url);
  let raw: string;
  try {
    raw = await readFile(url, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return JSON.parse(raw) as GoldenCase[];
}

export async function collectCases(
  lesson: LessonDoc,
  promptName: string,
): Promise<EvalCaseSpec[]> {
  const traces = await tracesCol()
    .find({
      _id: { $in: lesson.sourceTraceIds },
      promptName,
      $or: [{ score: { $lt: REPLAY_SCORE_CEILING } }, { error: { $exists: true } }],
    })
    .toArray();

  const specs: EvalCaseSpec[] = [];
  const seen = new Set<string>();
  for (const trace of traces) {
    if (specs.length >= REPLAY_CASE_CAP) break;
    const input = trace.input as Record<string, unknown>;
    const fingerprint = JSON.stringify(input);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    specs.push({
      caseId: `replay:${String(trace._id)}`,
      kind: "replay",
      input,
      intent: lesson.text,
    });
  }

  const golden = await loadGolden(promptName);
  for (const goldenCase of golden) {
    specs.push({
      caseId: `golden:${goldenCase.id}`,
      kind: "golden",
      input: goldenCase.input,
      intent: goldenCase.intent,
    });
  }
  return specs;
}

export interface RunEvalArgs {
  doc: PromptDoc;
  fragmentKey: string;
  candidateText: string;
  lessonText: string;
  cases: EvalCaseSpec[];
  gen?: (system: string, user: string) => Promise<string>;
  score?: (
    spec: EvalCaseSpec,
    baselineOutput: string,
    candidateOutput: string,
    lessonText: string,
  ) => Promise<EvalCase>;
}

function failedCase(
  spec: EvalCaseSpec,
  baselineOutput: string,
  candidateOutput: string,
  error: unknown,
): EvalCase {
  const zeroRubric = (): Rubric => Object.fromEntries(RUBRIC_AXES.map((axis) => [axis, 0]));
  return {
    caseId: spec.caseId,
    kind: spec.kind,
    input: spec.input,
    baselineOutput,
    candidateOutput,
    baseline: zeroRubric(),
    candidate: zeroRubric(),
    delta: -WIN_THRESHOLD,
    verdict: "loss",
    critique: `Judge call failed: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function summarize(cases: EvalCase[]): EvalRunSummary {
  const replays = cases.filter((c) => c.kind === "replay");
  const replayWins = replays.filter((c) => c.verdict === "win").length;
  const replayLosses = replays.filter((c) => c.verdict === "loss").length;
  const goldenRegressions = cases.filter(
    (c) => c.kind === "golden" && c.verdict === "loss",
  ).length;
  const avg = (pick: (c: EvalCase) => Rubric): number =>
    cases.length === 0
      ? 0
      : cases.reduce(
          (sum, c) => sum + RUBRIC_AXES.reduce((s, axis) => s + (pick(c)[axis] ?? 0), 0),
          0,
        ) / cases.length;
  const passed =
    goldenRegressions === 0 &&
    replayLosses === 0 &&
    replayWins >= Math.ceil(replays.length / 2) &&
    replayWins >= 1;
  return {
    replayWins,
    replayLosses,
    goldenRegressions,
    baselineAvg: avg((c) => c.baseline),
    candidateAvg: avg((c) => c.candidate),
    passed,
  };
}

export async function runEval(args: RunEvalArgs): Promise<EvalReport> {
  const gen = args.gen ?? generate;
  const score = args.score ?? scoreCase;
  const baselineSystem = renderPromptDoc(withOpenSlots(args.doc));
  const candidateSystem = renderPromptDoc(
    withOpenSlots(withFragment(args.doc, args.fragmentKey, args.candidateText)),
  );
  const results: EvalCase[] = [];
  let judgeFailures = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < args.cases.length) {
      const index = next;
      next += 1;
      const spec = args.cases[index];
      if (!spec) break;
      const user = composeInput(spec.input);
      const [baselineOutput, candidateOutput] = await Promise.all([
        gen(fillInputs(baselineSystem, spec.input), user),
        gen(fillInputs(candidateSystem, spec.input), user),
      ]);
      try {
        results[index] = await score(spec, baselineOutput, candidateOutput, args.lessonText);
      } catch (error) {
        judgeFailures += 1;
        if (judgeFailures > 1) {
          throw new Error(
            `Eval attempt aborted: ${judgeFailures} judge calls failed, latest on ${spec.caseId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        results[index] = failedCase(spec, baselineOutput, candidateOutput, error);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, args.cases.length) }, () => worker()),
  );
  return {
    cases: results,
    summary: summarize(results),
    judgeModel: REASONING_MODEL,
    genModel: GENERATION_MODEL,
  };
}
