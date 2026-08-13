import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { EvalRunSummary } from "@uberprompt/sdk";
import { proposalUpdate } from "./index";
import type { Candidate } from "./types";

const candidate: Candidate = { newText: "confirm the amount first", reason: "lesson L-1" };

function summary(passed: boolean): EvalRunSummary {
  return {
    replayWins: passed ? 2 : 0,
    replayLosses: passed ? 0 : 1,
    goldenRegressions: 0,
    baselineAvg: 11,
    candidateAvg: passed ? 17 : 9,
    passed,
  };
}

test("a passing candidate becomes a pending proposal awaiting approval", () => {
  const runIds = [new ObjectId()];
  const update = proposalUpdate(candidate, summary(true), runIds);
  assert.equal(update.status, "pending");
  assert.equal(update.newText, candidate.newText);
  assert.equal(update.reason, "lesson L-1");
  assert.equal(update.evals.passed, true);
  assert.deepEqual(update.evals.runIds, runIds);
});

test("a failing candidate is rejected and says so in the reason", () => {
  const update = proposalUpdate(candidate, summary(false), [new ObjectId(), new ObjectId()]);
  assert.equal(update.status, "rejected");
  assert.match(update.reason, /rejected by eval gate/);
  assert.equal(update.evals.passed, false);
  assert.equal(update.evals.runIds.length, 2);
});

test("a rejected proposal still carries its candidate text and scores as evidence", () => {
  const update = proposalUpdate(candidate, summary(false), [new ObjectId()]);
  assert.equal(update.newText, candidate.newText);
  assert.equal(update.evals.baselineAvg, 11);
  assert.equal(update.evals.candidateAvg, 9);
});

test("status is never applied — stage 3 does not write prompts", () => {
  for (const passed of [true, false]) {
    const update = proposalUpdate(candidate, summary(passed), []);
    assert.notEqual(update.status, "applied");
    assert.notEqual(update.status, "evaluating");
  }
});
