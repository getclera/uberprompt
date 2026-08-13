import { test } from "node:test";
import assert from "node:assert/strict";
import type { Culprit } from "./types";
import { authorCandidate, type AuthorArgs, type AuthorCall } from "./author";

const BASELINE =
  "You are the billing agent for Acme Cloud. Process refunds only when they fit policy, and explain charges clearly.";

function makeCulprit(): Culprit {
  return {
    fragment: "task",
    span: "Process refunds only when they fit policy",
    traceIds: [],
    sharedWith: [],
    rationale: "No confirm-first guard before promising refund amounts.",
  };
}

function makeArgs(overrides: Partial<AuthorArgs> = {}): AuthorArgs {
  return {
    lessonText: "Never promise a specific refund amount before checking the account.",
    promptName: "billing-agent",
    culprit: makeCulprit(),
    baselineText: BASELINE,
    siblingFragments: [
      { key: "refund-policy", text: "Refunds within 30 days." },
      { key: "message", text: "" },
    ],
    failingExamples: ["Promised $800 before checking the account."],
    ...overrides,
  };
}

function makeCall(newText: string, reason = "added confirm-first guard") {
  const prompts: string[] = [];
  const call: AuthorCall = async <T>(prompt: string) => {
    prompts.push(prompt);
    return { newText, reason } as T;
  };
  return { call, prompts };
}

test("accepts a minimal edit within length bounds", async () => {
  const revised = `${BASELINE} Confirm the account numbers first, then commit.`;
  const { call } = makeCall(revised);
  const candidate = await authorCandidate(makeArgs(), call);
  assert.equal(candidate.newText, revised);
  assert.equal(candidate.reason, "added confirm-first guard");
});

test("rejects an unchanged candidate", async () => {
  const { call } = makeCall(BASELINE);
  await assert.rejects(authorCandidate(makeArgs(), call), /identical to the baseline/);
});

test("rejects an empty candidate", async () => {
  const { call } = makeCall("   \n  ");
  await assert.rejects(authorCandidate(makeArgs(), call), /empty after trimming/);
});

test("rejects a candidate three times the baseline length", async () => {
  const { call } = makeCall(BASELINE.repeat(3));
  await assert.rejects(authorCandidate(makeArgs(), call), /must stay within 0.5x-2x/);
});

test("rejects a candidate shorter than half the baseline length", async () => {
  const { call } = makeCall("Fit policy.");
  await assert.rejects(authorCandidate(makeArgs(), call), /must stay within 0.5x-2x/);
});

test("prompt demands a minimal edit and carries lesson, baseline, siblings, and examples", async () => {
  const { call, prompts } = makeCall(`${BASELINE} Confirm the numbers first.`);
  await authorCandidate(makeArgs(), call);
  const sent = prompts[0];
  assert.ok(sent);
  assert.ok(sent.includes("MINIMAL edit"));
  assert.ok(sent.includes(BASELINE));
  assert.ok(sent.includes("Never promise a specific refund amount"));
  assert.ok(sent.includes("[refund-policy]"));
  assert.ok(!sent.includes("[message]"));
  assert.ok(sent.includes("Promised $800 before checking the account."));
});

test("truncates failing examples to 600 chars and caps them at three", async () => {
  const long = "x".repeat(1000);
  const { call, prompts } = makeCall(`${BASELINE} Confirm first.`);
  await authorCandidate(
    makeArgs({ failingExamples: [long, "second", "third", "fourth"] }),
    call,
  );
  const sent = prompts[0];
  assert.ok(sent);
  assert.ok(sent.includes("x".repeat(600)));
  assert.ok(!sent.includes("x".repeat(601)));
  assert.ok(sent.includes("Failing example 3"));
  assert.ok(!sent.includes("fourth"));
});

test("retry prompt includes the critique and the previous attempt", async () => {
  const previousAttempt = `${BASELINE} Never issue refunds at all.`;
  const critique = "The rewrite forbids all refunds, regressing legitimate refund handling.";
  const { call, prompts } = makeCall(`${BASELINE} Confirm the account first, then commit.`);
  await authorCandidate(makeArgs({ critique, previousAttempt }), call);
  const sent = prompts[0];
  assert.ok(sent);
  assert.ok(sent.includes(previousAttempt));
  assert.ok(sent.includes(critique));
  assert.ok(sent.includes("fix the specific regressions"));
});
