import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../src/graph.mjs";
import {
  modelFromMongo,
  diffFragments,
  dependentTargets,
  sharedFragmentKeys,
  pickSemanticHits,
  edgeEndpoints,
  hasEdgeBetween,
} from "../src/sync-check.mjs";

const prompts = [
  {
    name: "escalation-writer",
    version: 1,
    fragments: [
      { key: "context", text: "frame the escalation" },
      { key: "escalation-criteria", text: "legal threats escalate" },
      { key: "ticket", text: "" },
    ],
  },
  {
    name: "triage-router",
    version: 1,
    fragments: [{ key: "routing-rules", text: "route legal threats up" }],
  },
  {
    name: "tech-support-agent",
    version: 2,
    fragments: [{ key: "task", text: "new task text" }],
  },
];

const edges = [
  { from: { prompt: "escalation-writer" }, to: { fragment: "escalation-criteria" }, kind: "uses" },
  {
    from: { prompt: "triage-router", fragment: "routing-rules" },
    to: { fragment: "escalation-criteria" },
    kind: "semantic",
  },
  { from: { prompt: "escalation-writer" }, to: { fragment: "output-format" }, kind: "uses" },
];

test("modelFromMongo feeds buildGraph the shape it expects", () => {
  const graph = buildGraph(modelFromMongo(prompts, edges));
  assert.ok(graph.promptNames.has("triage-router"));
  assert.equal(graph.rev.get("escalation-criteria").length, 2);
});

test("diffFragments returns only changed non-empty fragments", () => {
  const snapshot = {
    fragments: [
      { key: "task", text: "old task text" },
      { key: "other", text: "same" },
    ],
  };
  const current = {
    fragments: [
      { key: "task", text: "new task text" },
      { key: "other", text: "same" },
      { key: "added", text: "brand new" },
    ],
  };
  assert.deepEqual(diffFragments(current, snapshot), [
    { key: "task", oldText: "old task text", newText: "new task text" },
  ]);
});

test("dependentTargets expands prompt-level dependents and skips the changed prompt", () => {
  const byName = new Map(prompts.map((p) => [p.name, p]));
  const graph = buildGraph(modelFromMongo(prompts, edges));
  const targets = dependentTargets(graph, byName, "escalation-writer", "escalation-criteria");
  const ids = targets.map((t) => `${t.prompt.name}.${t.fragment}`).sort();
  assert.deepEqual(ids, ["triage-router.routing-rules"]);
});

test("dependentTargets expands a dependent prompt into its non-empty fragments", () => {
  const byName = new Map(prompts.map((p) => [p.name, p]));
  const graph = buildGraph(modelFromMongo(prompts, edges));
  const targets = dependentTargets(graph, byName, "tech-support-agent", "escalation-criteria");
  const ids = targets.map((t) => `${t.prompt.name}.${t.fragment}`).sort();
  assert.deepEqual(ids, [
    "escalation-writer.context",
    "escalation-writer.escalation-criteria",
    "triage-router.routing-rules",
  ]);
});

test("sharedFragmentKeys collects fragment-only edge endpoints", () => {
  const keys = sharedFragmentKeys(edges, "/nonexistent");
  assert.ok(keys.has("escalation-criteria"));
  assert.ok(keys.has("output-format"));
  assert.ok(!keys.has("routing-rules"));
});

test("pickSemanticHits applies threshold, top-k, and same-prompt exclusion", () => {
  const rows = [
    {
      name: "escalation-writer",
      fragments: [{ key: "context", text: "x", embedding: [1, 0] }],
    },
    {
      name: "triage-router",
      fragments: [
        { key: "routing-rules", text: "x", embedding: [1, 0.1] },
        { key: "ticket", text: "", embedding: [1, 0] },
        { key: "output-format", text: "x", embedding: [0, 1] },
      ],
    },
    {
      name: "billing-agent",
      fragments: [{ key: "refund-policy", text: "x", embedding: [1, 0.05] }],
    },
  ];
  const hits = pickSemanticHits(rows, "escalation-writer", [1, 0], { threshold: 0.8, topK: 5 });
  assert.deepEqual(
    hits.map((h) => `${h.prompt}.${h.fragment}`),
    ["billing-agent.refund-policy", "triage-router.routing-rules"]
  );
  assert.ok(hits.every((h) => h.score >= 0.8));
  const capped = pickSemanticHits(rows, "escalation-writer", [1, 0], { threshold: 0.8, topK: 1 });
  assert.equal(capped.length, 1);
});

test("edgeEndpoints points a local fragment at a shared one, answer-key style", () => {
  const local = { prompt: "escalation-writer", fragment: "context" };
  const shared = { fragment: "refund-policy" };
  assert.deepEqual(edgeEndpoints(local, shared), { from: local, to: shared });
  const hitLocal = { prompt: "triage-router", fragment: "routing-rules" };
  const changedShared = { fragment: "escalation-criteria" };
  assert.deepEqual(edgeEndpoints(changedShared, hitLocal), {
    from: hitLocal,
    to: changedShared,
  });
});

test("hasEdgeBetween matches either direction", () => {
  const a = { prompt: "triage-router", fragment: "routing-rules" };
  const b = { fragment: "escalation-criteria" };
  assert.ok(hasEdgeBetween(edges, a, b));
  assert.ok(hasEdgeBetween(edges, b, a));
  assert.ok(!hasEdgeBetween(edges, { prompt: "billing-agent", fragment: "task" }, b));
});
