import assert from "node:assert/strict";
import test from "node:test";
import { scoreCase, type JudgeArgs } from "./judge";
import { verdictFor, type EvalCaseSpec, type JudgeVerdict } from "./types";

const spec: EvalCaseSpec = {
  caseId: "replay:abc",
  kind: "replay",
  input: { ticketId: "AC-1", subject: "S", body: "B" },
  intent: "the lesson text",
};

const highRubric = { taskFit: 5, tone: 5, specificity: 4, lessonAdherence: 5 };
const lowRubric = { taskFit: 3, tone: 3, specificity: 3, lessonAdherence: 2 };

function contentAwareJudge(betterOutput: string) {
  return (args: JudgeArgs): Promise<JudgeVerdict> =>
    Promise.resolve({
      a: args.outputA === betterOutput ? highRubric : lowRubric,
      b: args.outputB === betterOutput ? highRubric : lowRubric,
      explanation: "content-aware stub",
    });
}

test("scoreCase: candidate wins regardless of being shown as A or B", async () => {
  for (const candidateGoesFirst of [true, false]) {
    const result = await scoreCase(spec, "baseline out", "candidate out", "lesson", {
      judge: contentAwareJudge("candidate out"),
      candidateGoesFirst: () => candidateGoesFirst,
    });
    assert.deepEqual(result.candidate, highRubric);
    assert.deepEqual(result.baseline, lowRubric);
    assert.equal(result.delta, 5);
    assert.equal(result.verdict, "win");
    assert.equal(result.baselineOutput, "baseline out");
    assert.equal(result.candidateOutput, "candidate out");
  }
});

test("scoreCase: baseline wins regardless of position", async () => {
  for (const candidateGoesFirst of [true, false]) {
    const result = await scoreCase(spec, "baseline out", "candidate out", "lesson", {
      judge: contentAwareJudge("baseline out"),
      candidateGoesFirst: () => candidateGoesFirst,
    });
    assert.deepEqual(result.candidate, lowRubric);
    assert.deepEqual(result.baseline, highRubric);
    assert.equal(result.delta, -5);
    assert.equal(result.verdict, "loss");
  }
});

test("scoreCase: a position-biased judge flips with the ordering, proving labels pass through", async () => {
  const positionBiasedJudge = (): Promise<JudgeVerdict> =>
    Promise.resolve({ a: highRubric, b: lowRubric, explanation: "A-biased stub" });
  const candidateFirst = await scoreCase(spec, "b-out", "c-out", "lesson", {
    judge: positionBiasedJudge,
    candidateGoesFirst: () => true,
  });
  assert.equal(candidateFirst.verdict, "win");
  const baselineFirst = await scoreCase(spec, "b-out", "c-out", "lesson", {
    judge: positionBiasedJudge,
    candidateGoesFirst: () => false,
  });
  assert.equal(baselineFirst.verdict, "loss");
});

test("scoreCase: forwards the case to the judge with correct outputs per slot", async () => {
  const calls: JudgeArgs[] = [];
  const recordingJudge = (args: JudgeArgs): Promise<JudgeVerdict> => {
    calls.push(args);
    return Promise.resolve({ a: highRubric, b: highRubric, explanation: "tie" });
  };
  const result = await scoreCase(spec, "b-out", "c-out", "the lesson", {
    judge: recordingJudge,
    candidateGoesFirst: () => false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.outputA, "b-out");
  assert.equal(calls[0]?.outputB, "c-out");
  assert.equal(calls[0]?.intent, spec.intent);
  assert.equal(calls[0]?.lessonText, "the lesson");
  assert.deepEqual(calls[0]?.input, spec.input);
  assert.equal(result.delta, 0);
  assert.equal(result.verdict, "tie");
  assert.equal(result.critique, "tie");
});

test("scoreCase: lesson adherence alone never wins the gate", async () => {
  const equalQuality = { taskFit: 4, tone: 4, specificity: 4 };
  const adherentJudge = (args: JudgeArgs): Promise<JudgeVerdict> =>
    Promise.resolve({
      a: { ...equalQuality, lessonAdherence: args.outputA === "c-out" ? 5 : 1 },
      b: { ...equalQuality, lessonAdherence: args.outputB === "c-out" ? 5 : 1 },
      explanation: "candidate parrots the lesson, quality is identical",
    });
  const result = await scoreCase(spec, "b-out", "c-out", "lesson", {
    judge: adherentJudge,
    candidateGoesFirst: () => true,
  });
  assert.equal(result.delta, 0);
  assert.equal(result.verdict, "tie");
  assert.equal(result.candidate.lessonAdherence, 5);
  assert.equal(result.baseline.lessonAdherence, 1);
});

test("verdictFor thresholds: small deltas are ties", () => {
  assert.equal(verdictFor(2), "win");
  assert.equal(verdictFor(1), "tie");
  assert.equal(verdictFor(0), "tie");
  assert.equal(verdictFor(-1), "tie");
  assert.equal(verdictFor(-2), "loss");
});
