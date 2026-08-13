import assert from "node:assert/strict";
import test from "node:test";
import type { EvalCase, PromptDoc } from "@uberprompt/sdk";
import { loadGolden, runEval, summarizeCases, type RunEvalArgs } from "./evals";
import { RUBRIC_AXES, WIN_AXES, type EvalCaseSpec } from "./types";

const doc: PromptDoc = {
  name: "billing-agent",
  version: 1,
  description: "test",
  fragments: [
    { key: "task", text: "old task text" },
    { key: "message", text: "" },
  ],
  template: "{{task}}\n\nCustomer message:\n{{message}}",
  updatedAt: new Date("2026-08-13T00:00:00Z"),
  updatedBy: "test",
};

function replaySpec(id: string): EvalCaseSpec {
  return {
    caseId: `replay:${id}`,
    kind: "replay",
    input: { ticketId: id, subject: "s", body: `body ${id}` },
    intent: "lesson",
  };
}

function goldenSpec(id: string): EvalCaseSpec {
  return {
    caseId: `golden:${id}`,
    kind: "golden",
    input: { ticketId: id, subject: "s", body: `body ${id}` },
    intent: `intent ${id}`,
  };
}

function rubricOf(score: number): Record<string, number> {
  return Object.fromEntries(RUBRIC_AXES.map((axis) => [axis, score]));
}

function stubScore(
  verdicts: Record<string, "win" | "tie" | "loss">,
): NonNullable<RunEvalArgs["score"]> {
  return (spec, baselineOutput, candidateOutput) => {
    const verdict = verdicts[spec.caseId];
    if (!verdict) return Promise.reject(new Error(`no verdict for ${spec.caseId}`));
    const candidateScore = verdict === "win" ? 4 : verdict === "loss" ? 2 : 3;
    const candidate = rubricOf(candidateScore);
    const baseline = rubricOf(3);
    const result: EvalCase = {
      caseId: spec.caseId,
      kind: spec.kind,
      input: spec.input,
      baselineOutput,
      candidateOutput,
      baseline,
      candidate,
      delta: (candidateScore - 3) * WIN_AXES.length,
      verdict,
      critique: "stub",
    };
    return Promise.resolve(result);
  };
}

const stubGen = (system: string, user: string): Promise<string> =>
  Promise.resolve(`gen(${system.includes("CANDIDATE") ? "candidate" : "baseline"}|${user})`);

function baseArgs(cases: EvalCaseSpec[]): RunEvalArgs {
  return {
    doc,
    fragmentKey: "task",
    candidateText: "CANDIDATE task text",
    lessonText: "lesson",
    cases,
    gen: stubGen,
  };
}

test("loadGolden loads the real billing-agent golden set from the repo root", async () => {
  const cases = await loadGolden("billing-agent");
  assert.equal(cases.length, 3);
  const ids = cases.map((c) => c.id);
  assert.ok(ids.includes("in-policy-refund-still-helps"));
  for (const goldenCase of cases) {
    assert.equal(typeof goldenCase.intent, "string");
    assert.ok(goldenCase.intent.length > 0);
    assert.equal(typeof goldenCase.input, "object");
  }
});

test("loadGolden returns [] for a prompt with no golden file", async () => {
  assert.deepEqual(await loadGolden("no-such-prompt"), []);
});

test("runEval renders baseline and candidate systems from the swapped fragment", async () => {
  const systems: string[] = [];
  const args = baseArgs([replaySpec("r1")]);
  args.gen = (system, user) => {
    systems.push(system);
    return stubGen(system, user);
  };
  args.score = stubScore({ "replay:r1": "win" });
  const report = await runEval(args);
  assert.equal(systems.length, 2);
  assert.ok(systems.some((s) => s.includes("old task text")));
  assert.ok(systems.some((s) => s.includes("CANDIDATE task text")));
  for (const system of systems) {
    assert.doesNotMatch(system, /\{\{/);
    assert.ok(system.includes("body r1"));
  }
  assert.equal(report.cases[0]?.baselineOutput.includes("baseline"), true);
  assert.equal(report.cases[0]?.candidateOutput.includes("candidate"), true);
});

test("runEval passes when replays win and golden ties", async () => {
  const args = baseArgs([replaySpec("r1"), replaySpec("r2"), goldenSpec("g1")]);
  args.score = stubScore({ "replay:r1": "win", "replay:r2": "win", "golden:g1": "tie" });
  const report = await runEval(args);
  assert.equal(report.summary.replayWins, 2);
  assert.equal(report.summary.replayLosses, 0);
  assert.equal(report.summary.goldenRegressions, 0);
  assert.equal(report.summary.passed, true);
  assert.equal(report.summary.candidateAvg > report.summary.baselineAvg, true);
});

test("runEval fails when a golden case regresses despite replay wins", async () => {
  const args = baseArgs([replaySpec("r1"), replaySpec("r2"), goldenSpec("g1")]);
  args.score = stubScore({ "replay:r1": "win", "replay:r2": "win", "golden:g1": "loss" });
  const report = await runEval(args);
  assert.equal(report.summary.goldenRegressions, 1);
  assert.equal(report.summary.passed, false);
});

test("with no replay cases, a golden win carries the candidate", async () => {
  const args = baseArgs([goldenSpec("g1"), goldenSpec("g2")]);
  args.score = stubScore({ "golden:g1": "tie", "golden:g2": "win" });
  const report = await runEval(args);
  assert.equal(report.summary.replayWins, 0);
  assert.equal(report.summary.goldenRegressions, 0);
  assert.equal(report.summary.passed, true);
});

test("with no replay cases and no golden win, nothing carries the candidate", async () => {
  const args = baseArgs([goldenSpec("g1"), goldenSpec("g2")]);
  args.score = stubScore({ "golden:g1": "tie", "golden:g2": "tie" });
  const report = await runEval(args);
  assert.equal(report.summary.passed, false);
});

test("runEval fails when wins are under the majority threshold", async () => {
  const args = baseArgs([replaySpec("r1"), replaySpec("r2"), replaySpec("r3")]);
  args.score = stubScore({ "replay:r1": "win", "replay:r2": "tie", "replay:r3": "tie" });
  const report = await runEval(args);
  assert.equal(report.summary.replayWins, 1);
  assert.equal(report.summary.passed, false);
});

test("runEval fails on any replay loss", async () => {
  const args = baseArgs([replaySpec("r1"), replaySpec("r2")]);
  args.score = stubScore({ "replay:r1": "win", "replay:r2": "loss" });
  const report = await runEval(args);
  assert.equal(report.summary.replayLosses, 1);
  assert.equal(report.summary.passed, false);
});

test("an unjudgeable case counts as a tie, not as evidence against the candidate", async () => {
  const winScore = stubScore({ "replay:r1": "win", "replay:r2": "win" });
  const args = baseArgs([replaySpec("r1"), replaySpec("r2"), replaySpec("r3")]);
  args.score = (spec, baselineOutput, candidateOutput, lessonText) =>
    spec.caseId === "replay:r3"
      ? Promise.reject(new Error("judge exploded"))
      : winScore(spec, baselineOutput, candidateOutput, lessonText);
  const report = await runEval(args);
  const failed = report.cases.find((c) => c.caseId === "replay:r3");
  assert.ok(failed);
  assert.equal(failed.verdict, "tie");
  assert.match(failed.critique, /judge exploded/);
  assert.equal(report.summary.replayLosses, 0);
  assert.equal(report.summary.passed, true);
});

test("an unjudged case does not drag the reported averages", async () => {
  const winScore = stubScore({ "replay:r1": "win", "replay:r2": "win" });
  const args = baseArgs([replaySpec("r1"), replaySpec("r2"), replaySpec("r3")]);
  args.score = (spec, baselineOutput, candidateOutput, lessonText) =>
    spec.caseId === "replay:r3"
      ? Promise.reject(new Error("judge exploded"))
      : winScore(spec, baselineOutput, candidateOutput, lessonText);
  const report = await runEval(args);
  assert.equal(report.summary.baselineAvg, 3 * RUBRIC_AXES.length);
  assert.equal(report.summary.candidateAvg, 4 * RUBRIC_AXES.length);
});

test("a transient judge error is retried once before the case is written off", async () => {
  const winScore = stubScore({ "replay:r1": "win" });
  const args = baseArgs([replaySpec("r1")]);
  let calls = 0;
  args.score = (spec, baselineOutput, candidateOutput, lessonText) => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("transient"))
      : winScore(spec, baselineOutput, candidateOutput, lessonText);
  };
  const report = await runEval(args);
  assert.equal(calls, 2);
  assert.equal(report.cases[0]?.verdict, "win");
});

test("baseline outputs are reused across attempts so the judge compares against a fixed baseline", async () => {
  const cases = [replaySpec("r1"), replaySpec("r2")];
  const first = baseArgs(cases);
  first.score = stubScore({ "replay:r1": "win", "replay:r2": "win" });
  const firstReport = await runEval(first);

  const systems: string[] = [];
  const second = baseArgs(cases);
  second.score = stubScore({ "replay:r1": "win", "replay:r2": "win" });
  second.baselineOutputs = firstReport.baselineOutputs;
  second.gen = (system, user) => {
    systems.push(system);
    return stubGen(system, user);
  };
  const secondReport = await runEval(second);

  assert.equal(systems.length, cases.length);
  assert.ok(systems.every((s) => s.includes("CANDIDATE")));
  assert.deepEqual(secondReport.baselineOutputs, firstReport.baselineOutputs);
});

test("runEval aborts when two judge calls fail", async () => {
  const args = baseArgs([replaySpec("r1"), replaySpec("r2"), replaySpec("r3")]);
  args.score = () => Promise.reject(new Error("judge exploded"));
  await assert.rejects(() => runEval(args), /aborted/);
});

function judged(caseId: string, kind: "replay" | "golden", verdict: "win" | "tie" | "loss"): EvalCase {
  const score = verdict === "win" ? 5 : verdict === "loss" ? 1 : 3;
  const rubric = Object.fromEntries(RUBRIC_AXES.map((a) => [a, 3]));
  return {
    caseId,
    kind,
    input: {},
    baselineOutput: "b",
    candidateOutput: "c",
    baseline: rubric,
    candidate: Object.fromEntries(RUBRIC_AXES.map((a) => [a, score])),
    delta: (score - 3) * WIN_AXES.length,
    verdict,
    critique: "x",
  };
}

test("a catalog-targeted prompt passes on golden evidence when it has no replay cases", () => {
  const cases = [
    judged("golden:a", "golden", "win"),
    judged("golden:b", "golden", "win"),
  ];
  assert.equal(summarizeCases(cases).passed, true);
});

test("golden ties alone are not enough to pass without replay evidence", () => {
  const cases = [judged("golden:a", "golden", "tie"), judged("golden:b", "golden", "tie")];
  assert.equal(summarizeCases(cases).passed, false);
});

test("a single golden win among many ties does not carry a replay-less prompt", () => {
  const cases = [
    judged("golden:a", "golden", "win"),
    judged("golden:b", "golden", "tie"),
    judged("golden:c", "golden", "tie"),
    judged("golden:d", "golden", "tie"),
  ];
  assert.equal(summarizeCases(cases).passed, false);
});

test("a golden majority carries a replay-less prompt", () => {
  const cases = [
    judged("golden:a", "golden", "win"),
    judged("golden:b", "golden", "win"),
    judged("golden:c", "golden", "tie"),
  ];
  assert.equal(summarizeCases(cases).passed, true);
});

test("a golden regression still fails a replay-less prompt", () => {
  const cases = [judged("golden:a", "golden", "win"), judged("golden:b", "golden", "loss")];
  assert.equal(summarizeCases(cases).passed, false);
});

test("no cases at all still fails closed", () => {
  assert.equal(summarizeCases([]).passed, false);
});
