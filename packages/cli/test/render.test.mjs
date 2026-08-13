import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, dependentsOf } from "../src/graph.mjs";
import { renderPromptForest, renderImpactTree } from "../src/render.mjs";

function fixtureModel() {
  const fragments = new Map([
    ["policy", { key: "policy", version: 1, text: "policy text" }],
    ["criteria", { key: "criteria", version: 1, text: "criteria text" }],
    ["format", { key: "format", version: 1, text: "format text" }],
  ]);
  const prompts = new Map([
    [
      "billing",
      {
        name: "billing",
        version: 1,
        fragments: [{ key: "context", text: "restates policy" }],
      },
    ],
    ["triage", { name: "triage", version: 1, fragments: [] }],
  ]);
  const edges = [
    { from: { prompt: "billing" }, to: { fragment: "policy" }, kind: "uses" },
    { from: { prompt: "billing" }, to: { fragment: "format" }, kind: "uses" },
    { from: { prompt: "triage" }, to: { fragment: "format" }, kind: "uses" },
    {
      from: { prompt: "billing", fragment: "context" },
      to: { fragment: "policy" },
      kind: "semantic",
      confidence: 0.83,
    },
    {
      from: { fragment: "policy" },
      to: { fragment: "criteria" },
      kind: "semantic",
      confidence: 0.71,
    },
  ];
  return { fragments, prompts, edges };
}

test("prompt forest renders one tree per prompt with edge kinds", () => {
  const out = renderPromptForest(fixtureModel());
  assert.match(out, /^billing$/m);
  assert.match(out, /^triage$/m);
  assert.match(out, /├─┬ policy \[uses\]/);
  assert.match(out, /└── criteria \[semantic 0\.71 ⚠\]/);
  assert.match(out, /format \[uses\]/);
});

test("prompt forest shows local fragments and their semantic edges", () => {
  const out = renderPromptForest(fixtureModel());
  assert.match(out, /context \(local\)/);
  assert.match(out, /policy \[semantic 0\.83 ⚠\]/);
});

test("diamond dependency collapses to a shown-above marker", () => {
  const out = renderPromptForest(fixtureModel());
  const billing = out.slice(0, out.indexOf("triage"));
  const occurrences = billing.match(/policy/g) || [];
  assert.equal(occurrences.length, 2);
  assert.match(billing, /policy \[semantic 0\.83 ⚠\] ↩ shown above/);
  const expandedTwice = (billing.match(/criteria/g) || []).length;
  assert.equal(expandedTwice, 1);
});

test("impact tree walks reverse edges through local fragments to owning prompts", () => {
  const model = fixtureModel();
  const out = renderImpactTree(model, buildGraph(model), "policy");
  assert.match(out, /^policy — change ripples to:/);
  assert.match(out, /billing\.context \[semantic 0\.83 ⚠\]/);
  assert.match(out, /billing \[contains\]/);
  assert.match(out, /billing \[uses\]/);
});

test("impact tree of a leaf node reports no dependents", () => {
  const model = fixtureModel();
  const out = renderImpactTree(model, buildGraph(model), "triage");
  assert.match(out, /\(no dependents\)/);
});

test("cyclic semantic edges terminate", () => {
  const model = fixtureModel();
  model.edges.push({
    from: { fragment: "criteria" },
    to: { fragment: "policy" },
    kind: "semantic",
    confidence: 0.9,
  });
  const forest = renderPromptForest(model);
  assert.ok(forest.length > 0);
  const impact = renderImpactTree(model, buildGraph(model), "policy");
  assert.match(impact, /criteria/);
});

test("colors default off — output has no ANSI escapes", () => {
  const out = renderPromptForest(fixtureModel());
  assert.doesNotMatch(out, /\x1b\[/);
});

test("dependentsOf finds transitive dependents including prompt ownership", () => {
  const model = fixtureModel();
  const deps = dependentsOf(buildGraph(model), "policy");
  const nodes = deps.map((d) => d.node);
  assert.ok(nodes.includes("billing"));
  assert.ok(nodes.includes("billing.context"));
});
