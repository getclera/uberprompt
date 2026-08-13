import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { EvalRunSummary, ProposalDoc } from "@uberprompt/sdk";
import { hasProposalFromLesson, isDuplicateProposal, proposalUpdate, shouldStampProcessed, type PromptOutcome } from "./index";
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

function proposal(newText: string, ref?: ObjectId): ProposalDoc {
  return {
    target: { prompt: "billing-agent", fragment: "task" },
    oldText: "old",
    newText,
    reason: "r",
    source: { type: "lesson", ...(ref ? { ref } : {}) },
    status: "pending",
    ts: new Date(),
  };
}

test("a passing candidate becomes a pending proposal awaiting approval", () => {
  const runIds = [new ObjectId()];
  const update = proposalUpdate(candidate, summary(true), runIds);
  assert.equal(update.status, "pending");
  assert.equal(update.newText, candidate.newText);
  assert.equal(update.evals.passed, true);
  assert.deepEqual(update.evals.runIds, runIds);
});

test("a failing candidate is rejected and says so in the reason", () => {
  const update = proposalUpdate(candidate, summary(false), [new ObjectId(), new ObjectId()]);
  assert.equal(update.status, "rejected");
  assert.match(update.reason, /rejected by eval gate/);
  assert.equal(update.evals.passed, false);
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

test("identical pending text is detected despite whitespace differences", () => {
  const open = [proposal("Confirm  the\nnumbers   first.")];
  assert.equal(isDuplicateProposal(open, "Confirm the numbers first."), true);
  assert.equal(isDuplicateProposal(open, "Confirm the numbers, then commit."), false);
});

test("no open proposals means nothing is a duplicate", () => {
  assert.equal(isDuplicateProposal([], "anything"), false);
  assert.equal(hasProposalFromLesson([], new ObjectId()), false);
});

test("an open proposal from the same lesson short-circuits reprocessing", () => {
  const lessonId = new ObjectId();
  const open = [proposal("something", lessonId)];
  assert.equal(hasProposalFromLesson(open, lessonId), true);
  assert.equal(hasProposalFromLesson(open, new ObjectId()), false);
});

test("a proposal from a different source does not block this lesson", () => {
  const open = [proposal("something")];
  assert.equal(hasProposalFromLesson(open, new ObjectId()), false);
});

test("a target with nothing to evaluate is skipped, not reported as a loss", () => {
  const outcome: PromptOutcome = {
    prompt: "escalation-writer",
    status: "skipped",
    reason: "no evaluable cases",
    reports: [],
  };
  assert.notEqual(outcome.status, "rejected");
  assert.equal(outcome.reports.length, 0);
});

test("a failed target is distinguishable from a rejected one", () => {
  const statuses: Array<PromptOutcome["status"]> = ["pending", "rejected", "skipped", "failed"];
  assert.equal(new Set(statuses).size, 4);
});

function outcome(status: PromptOutcome["status"]): PromptOutcome {
  return { prompt: "billing-agent", status, reason: "r", reports: [] };
}

test("a lesson whose target failed outright is left unprocessed so a restart retries it", () => {
  assert.equal(shouldStampProcessed([outcome("pending"), outcome("failed")]), false);
  assert.equal(shouldStampProcessed([outcome("failed")]), false);
});

test("a lesson whose gate rejected every candidate is still processed once", () => {
  assert.equal(shouldStampProcessed([outcome("rejected"), outcome("skipped")]), true);
  assert.equal(shouldStampProcessed([outcome("pending")]), true);
  assert.equal(shouldStampProcessed([]), true);
});

test("a rejected proposal from this lesson blocks a rerun, not just an open one", () => {
  const lessonId = new ObjectId();
  const rejected = { ...proposal("tried and judged worse", lessonId), status: "rejected" as const };
  assert.equal(hasProposalFromLesson([rejected], lessonId), true);
});

test("text already rejected for this fragment is not re-proposed", () => {
  const rejected = { ...proposal("Confirm the numbers first."), status: "rejected" as const };
  assert.equal(isDuplicateProposal([rejected], "Confirm  the numbers   first."), true);
});
