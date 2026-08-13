import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../src/graph.mjs";
import { modelFromMongo, diffFragments, dependentTargets } from "../src/sync-check.mjs";

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
