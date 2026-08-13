import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMap } from "../src/map.ts";

function fixtureModel() {
  const fragments = new Map([
    ["policy", { key: "policy", version: 1, text: "policy text" }],
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
  ];
  return { fragments, prompts, edges };
}

test("map shows prompts left, fragments right with arrows", () => {
  const out = renderMap(fixtureModel());
  assert.match(out, /^billing ╶/m);
  assert.match(out, /^triage ╶/m);
  assert.match(out, /▶ policy/);
  assert.match(out, /▶ format/);
});

test("map marks semantic-source local fragments with ⚠", () => {
  const out = renderMap(fixtureModel());
  assert.match(out, /^ {2}context ⚠ ╶/m);
});

test("map omits local fragments without semantic edges", () => {
  const model = fixtureModel();
  model.edges.pop();
  const out = renderMap(model);
  assert.doesNotMatch(out, /context/);
});

test("map draws box glyphs and keeps every line inside the canvas", () => {
  const out = renderMap(fixtureModel());
  assert.match(out, /[┬┴├┤╮╯╰╭│]/);
  const body = out.split("\n").slice(3);
  for (const line of body) assert.ok(line.length < 120);
});

test("map fragment labels sit on rows without left labels", () => {
  const out = renderMap(fixtureModel());
  for (const line of out.split("\n").slice(3)) {
    if (line.includes("▶")) assert.match(line, /^[ ─│┬┴├┤╮╯╰╭┼●╶╴]/);
  }
});

test("map without colors has no ANSI escapes", () => {
  assert.doesNotMatch(renderMap(fixtureModel()), /\x1b\[/);
});

test("map with colors wraps nets in ANSI and strips cleanly", () => {
  const colored = renderMap(fixtureModel(), { colors: true });
  assert.match(colored, /\x1b\[3[0-9]m/);
  const stripped = colored.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(stripped, renderMap(fixtureModel()));
});
