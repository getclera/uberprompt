import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { LessonDoc, PromptDoc, TraceDoc } from "@uberprompt/sdk";
import { findCulprit, type DiagnoseDeps } from "./diagnose";

const TASK_TEXT =
  "You are the billing agent for Acme Cloud. Read the account context before answering, and process refunds only when they fit policy.";
const POLICY_TEXT =
  "NEVER promise a specific refund amount to a customer before checking the actual account, plan, and payment history.";

function makeDoc(): PromptDoc {
  return {
    name: "billing-agent",
    version: 1,
    description: "Handles billing tickets",
    fragments: [
      { key: "task", text: TASK_TEXT },
      { key: "refund-policy", text: POLICY_TEXT },
      { key: "message", text: "" },
    ],
    template: "{{task}}\n{{refund-policy}}\n{{message}}",
    updatedAt: new Date(),
    updatedBy: "test",
  };
}

function makeLesson(traceIds: ObjectId[]): LessonDoc {
  return {
    text: "Never promise a specific refund amount before checking the account.",
    reason: "Three billing traces promised wrong amounts and declared refunds issued.",
    embedding: [],
    sourceTraceIds: traceIds,
    appliesTo: ["billing-agent"],
    status: "active",
    ts: new Date(),
  };
}

function makeTrace(id: ObjectId): TraceDoc {
  return {
    _id: id,
    promptName: "billing-agent",
    promptVersion: 1,
    input: { subject: "Double charged" },
    output: "You'll get the full $800 back today, promise.",
    meta: { model: "claude-opus-5", latencyMs: 700 },
    error: "Promised $800 before checking the account.",
    ts: new Date(),
  };
}

interface FakeSetup {
  deps: DiagnoseDeps;
  prompts: string[];
  traceIds: ObjectId[];
}

function makeDeps(
  responses: { fragment: string; span: string; rationale: string }[],
  sharedWith: string[] = [],
): FakeSetup {
  const prompts: string[] = [];
  const traceIds = [new ObjectId(), new ObjectId()];
  const deps: DiagnoseDeps = {
    callJson: async <T>(prompt: string) => {
      prompts.push(prompt);
      const next = responses.shift();
      if (!next) throw new Error("no fake response left");
      return next as T;
    },
    fetchTraces: async (ids) => ids.map(makeTrace),
    fetchSharedWith: async () => sharedWith,
  };
  return { deps, prompts, traceIds };
}

test("accepts a verbatim span and fills traceIds from the fetched traces", async () => {
  const span = "process refunds only when they fit policy";
  const { deps, prompts, traceIds } = makeDeps([
    { fragment: "task", span, rationale: "task lacks a confirm-first guard" },
  ]);
  const culprit = await findCulprit(makeLesson(traceIds), makeDoc(), deps);
  assert.equal(culprit.fragment, "task");
  assert.equal(culprit.span, span);
  assert.equal(culprit.rationale, "task lacks a confirm-first guard");
  assert.deepEqual(culprit.traceIds, traceIds);
  assert.equal(prompts.length, 1);
});

test("skips empty runtime-slot fragments and includes lesson reason and trace error", async () => {
  const { deps, prompts, traceIds } = makeDeps([
    { fragment: "task", span: "fit policy", rationale: "r" },
  ]);
  await findCulprit(makeLesson(traceIds), makeDoc(), deps);
  const sent = prompts[0];
  assert.ok(sent);
  assert.ok(!sent.includes("[message]"));
  assert.ok(sent.includes("[task]"));
  assert.ok(sent.includes("Three billing traces promised wrong amounts"));
  assert.ok(sent.includes("Promised $800 before checking the account."));
});

test("hallucinated span retries exactly once with the failure echoed, then succeeds", async () => {
  const { deps, prompts, traceIds } = makeDeps([
    { fragment: "task", span: "always confirm the account first", rationale: "r" },
    { fragment: "task", span: "fit policy", rationale: "r2" },
  ]);
  const culprit = await findCulprit(makeLesson(traceIds), makeDoc(), deps);
  assert.equal(prompts.length, 2);
  const retryPrompt = prompts[1];
  assert.ok(retryPrompt);
  assert.ok(retryPrompt.includes("previous answer was rejected"));
  assert.ok(retryPrompt.includes('not a verbatim substring of fragment "task"'));
  assert.equal(culprit.span, "fit policy");
});

test("throws after a second unverifiable span", async () => {
  const { deps, prompts, traceIds } = makeDeps([
    { fragment: "task", span: "made up text one", rationale: "r" },
    { fragment: "task", span: "made up text two", rationale: "r" },
  ]);
  await assert.rejects(
    findCulprit(makeLesson(traceIds), makeDoc(), deps),
    /after retry: span is not a verbatim substring/,
  );
  assert.equal(prompts.length, 2);
});

test("rejects a span validated against the wrong fragment", async () => {
  const { deps, prompts, traceIds } = makeDeps([
    { fragment: "task", span: "NEVER promise a specific refund amount", rationale: "r" },
    { fragment: "refund-policy", span: "NEVER promise a specific refund amount", rationale: "r" },
  ]);
  const culprit = await findCulprit(makeLesson(traceIds), makeDoc(), deps);
  assert.equal(prompts.length, 2);
  assert.equal(culprit.fragment, "refund-policy");
});

test("throws when the named fragment does not exist, after one retry", async () => {
  const { deps, traceIds } = makeDeps([
    { fragment: "tone", span: "fit policy", rationale: "r" },
    { fragment: "tone", span: "fit policy", rationale: "r" },
  ]);
  await assert.rejects(
    findCulprit(makeLesson(traceIds), makeDoc(), deps),
    /fragment "tone" does not exist/,
  );
});

test("sharedWith resolves a shared fragment to the other prompts using it", async () => {
  const { deps, traceIds } = makeDeps(
    [{ fragment: "refund-policy", span: "NEVER promise a specific refund amount", rationale: "r" }],
    ["billing-agent", "escalation-writer", "tech-support-agent", "escalation-writer"],
  );
  const culprit = await findCulprit(makeLesson(traceIds), makeDoc(), deps);
  assert.deepEqual(culprit.sharedWith, ["escalation-writer", "tech-support-agent"]);
});

test("sharedWith is empty for a prompt-local fragment", async () => {
  const { deps, traceIds } = makeDeps(
    [{ fragment: "task", span: "fit policy", rationale: "r" }],
    [],
  );
  const culprit = await findCulprit(makeLesson(traceIds), makeDoc(), deps);
  assert.deepEqual(culprit.sharedWith, []);
});
