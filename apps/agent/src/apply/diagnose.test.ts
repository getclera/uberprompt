import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { FragmentHit, LessonDoc, PromptDoc, TraceDoc } from "@uberprompt/sdk";
import { findCulprit, type DiagnoseDeps, type RelatedRow, normalizeFragmentKey } from "./diagnose";

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
    traceId: `trace-${id.toHexString()}`,
    service: "demo",
    operation: "ai.generateText",
    spanCount: 1,
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
  radius: Partial<Pick<DiagnoseDeps, "fetchRelated" | "fetchSimilar" | "fetchLiteral">> = {},
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
    fetchRelated: radius.fetchRelated ?? (async () => []),
    fetchSimilar: radius.fetchSimilar ?? (async () => []),
    fetchLiteral: radius.fetchLiteral ?? (async () => []),
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

const SPAN = "NEVER promise a specific refund amount";
const POLICY_RESPONSE = { fragment: "refund-policy", span: SPAN, rationale: "r" };

function relatedRow(name: string, fragments: RelatedRow["fragments"], score: number): RelatedRow {
  return { name, fragments, score };
}

function fragmentHit(prompt: string, fragment: string, score: number): FragmentHit {
  return { prompt, fragment, text: "restated rule", score };
}

test("undeclared via the fused path excludes the diagnosed prompt and declared sharedWith", async () => {
  const { deps, traceIds } = makeDeps(
    [POLICY_RESPONSE],
    ["escalation-writer"],
    {
      fetchRelated: async () => [
        relatedRow("billing-agent", [{ key: "refund-policy", text: POLICY_TEXT }], 0.99),
        relatedRow("escalation-writer", [{ key: "context", text: `${SPAN} restated` }], 0.9),
        relatedRow(
          "triage-router",
          [
            { key: "task", text: "Route each ticket to the right queue." },
            { key: "routing-rules", text: `Rules: ${SPAN} before checking anything.` },
          ],
          0.8,
        ),
        relatedRow(
          "tone-guide",
          [{ key: "voice", text: "A refund promise needs a checked amount, never a guess." }],
          0.6,
        ),
      ],
    },
  );
  const culprit = await findCulprit(makeLesson(traceIds), makeDoc(), deps);
  assert.deepEqual(culprit.undeclared, [
    { prompt: "triage-router", fragment: "routing-rules", score: 0.8, kind: "literal" },
    { prompt: "tone-guide", fragment: "voice", score: 0.6, kind: "semantic" },
  ]);
});

test("rankFusion version gate falls back to merged vector+literal results", async () => {
  const { deps, traceIds } = makeDeps(
    [POLICY_RESPONSE],
    [],
    {
      fetchRelated: async () => {
        throw new Error(
          "findRelatedFragments requires MongoDB 8.1+ for $rankFusion; connected server reports 8.0.4.",
        );
      },
      fetchLiteral: async () => [fragmentHit("triage-router", "routing-rules", 2.5)],
      fetchSimilar: async () => [
        fragmentHit("triage-router", "routing-rules", 0.91),
        fragmentHit("escalation-writer", "context", 0.87),
      ],
    },
  );
  const culprit = await findCulprit(makeLesson(traceIds), makeDoc(), deps);
  assert.deepEqual(culprit.undeclared, [
    { prompt: "triage-router", fragment: "routing-rules", score: 2.5, kind: "literal" },
    { prompt: "escalation-writer", fragment: "context", score: 0.87, kind: "semantic" },
  ]);
});

test("fallback path still drops prompts covered by declared sharedWith", async () => {
  const { deps, traceIds } = makeDeps(
    [POLICY_RESPONSE],
    ["escalation-writer"],
    {
      fetchRelated: async () => {
        throw new Error("findRelatedFragments requires MongoDB 8.1+ for $rankFusion");
      },
      fetchLiteral: async () => [fragmentHit("billing-agent", "refund-policy", 3)],
      fetchSimilar: async () => [fragmentHit("escalation-writer", "context", 0.9)],
    },
  );
  const culprit = await findCulprit(makeLesson(traceIds), makeDoc(), deps);
  assert.deepEqual(culprit.undeclared, []);
});

test("a non-version error from the fused query propagates", async () => {
  const { deps, traceIds } = makeDeps(
    [POLICY_RESPONSE],
    [],
    {
      fetchRelated: async () => {
        throw new Error("connection reset by peer");
      },
      fetchLiteral: async () => [fragmentHit("triage-router", "routing-rules", 1)],
    },
  );
  await assert.rejects(
    findCulprit(makeLesson(traceIds), makeDoc(), deps),
    /connection reset by peer/,
  );
});

test("diagnosis succeeds with an empty undeclared radius", async () => {
  const { deps, traceIds } = makeDeps([POLICY_RESPONSE]);
  const culprit = await findCulprit(makeLesson(traceIds), makeDoc(), deps);
  assert.equal(culprit.fragment, "refund-policy");
  assert.equal(culprit.span, SPAN);
  assert.deepEqual(culprit.undeclared, []);
});

test("a fragment key echoed back with the prompt's [brackets] is normalized, not rejected", () => {
  assert.equal(normalizeFragmentKey("[task]"), "task");
  assert.equal(normalizeFragmentKey("  [refund-policy]  "), "refund-policy");
  assert.equal(normalizeFragmentKey("task"), "task");
  assert.equal(normalizeFragmentKey("[[brand-voice]]"), "brand-voice");
});
