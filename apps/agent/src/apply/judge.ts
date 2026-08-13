import type { EvalCase } from "@uberprompt/sdk";
import { callJson } from "../llm";
import {
  RUBRIC_AXES,
  winTotal,
  verdictFor,
  type EvalCaseSpec,
  type JudgeVerdict,
} from "./types";

export interface JudgeArgs {
  intent: string;
  input: Record<string, unknown>;
  outputA: string;
  outputB: string;
  lessonText: string;
}

const axisSchema = { type: "integer", minimum: 1, maximum: 5 };

const rubricSchema = {
  type: "object",
  properties: Object.fromEntries(RUBRIC_AXES.map((axis) => [axis, axisSchema])),
  required: [...RUBRIC_AXES],
  additionalProperties: false,
};

const verdictSchema = {
  type: "object",
  properties: {
    a: rubricSchema,
    b: rubricSchema,
    explanation: { type: "string" },
  },
  required: ["a", "b", "explanation"],
  additionalProperties: false,
};

export async function judgeCase(args: JudgeArgs): Promise<JudgeVerdict> {
  const prompt = [
    "You are an impartial judge evaluating two AI support responses, A and B, produced for the same case by two prompt variants.",
    "",
    `What a good response to this case must do:\n${args.intent}`,
    "",
    `Lesson under evaluation (one variant tries to incorporate it):\n${args.lessonText}`,
    "",
    `Case input:\n${JSON.stringify(args.input, null, 2)}`,
    "",
    `Response A:\n${args.outputA}`,
    "",
    `Response B:\n${args.outputB}`,
    "",
    "Score each response on each axis from 1 (bad) to 5 (excellent):",
    "- taskFit: accomplishes what this case requires for this input.",
    "- tone: appropriate, warm, professional voice.",
    "- specificity: concrete and grounded in this case, not generic filler.",
    "- lessonAdherence: respects the lesson without overcorrecting into unhelpfulness. Recorded for diagnostics only — following the lesson is not itself a quality win, so never let it raise or lower the other three axes.",
    "",
    "Score A and B independently against the case requirements, not against each other. Ties are legitimate: responses of equal quality must receive equal scores. Never reward length; extra words without extra substance should lower specificity. Explain the meaningful differences briefly.",
  ].join("\n");
  return callJson<JudgeVerdict>(prompt, verdictSchema);
}

export interface ScoreDeps {
  judge: (args: JudgeArgs) => Promise<JudgeVerdict>;
  candidateGoesFirst: () => boolean;
}

const defaultScoreDeps: ScoreDeps = {
  judge: judgeCase,
  candidateGoesFirst: () => Math.random() < 0.5,
};

export async function scoreCase(
  spec: EvalCaseSpec,
  baselineOutput: string,
  candidateOutput: string,
  lessonText: string,
  deps: ScoreDeps = defaultScoreDeps,
): Promise<EvalCase> {
  const candidateIsA = deps.candidateGoesFirst();
  const verdict = await deps.judge({
    intent: spec.intent,
    input: spec.input,
    outputA: candidateIsA ? candidateOutput : baselineOutput,
    outputB: candidateIsA ? baselineOutput : candidateOutput,
    lessonText,
  });
  const candidate = candidateIsA ? verdict.a : verdict.b;
  const baseline = candidateIsA ? verdict.b : verdict.a;
  const delta = winTotal(candidate) - winTotal(baseline);
  return {
    caseId: spec.caseId,
    kind: spec.kind,
    input: spec.input,
    baselineOutput,
    candidateOutput,
    baseline,
    candidate,
    delta,
    verdict: verdictFor(delta),
    critique: verdict.explanation,
  };
}
