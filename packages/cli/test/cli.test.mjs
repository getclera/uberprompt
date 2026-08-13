import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "uberprompt.mjs");
const demoDir = join(here, "..", "..", "..", "apps", "demo");

function run(args) {
  return execFileSync("node", [bin, ...args, "--dir", demoDir], {
    encoding: "utf8",
  });
}

test("graph renders the demo prompt forest", () => {
  const out = run(["graph"]);
  assert.match(out, /Prompt dependency graph — 5 prompts, 4 shared fragments/);
  assert.match(out, /^billing-agent$/m);
  assert.match(out, /├── brand-voice \[uses\]/);
  assert.match(out, /└── output-format \[uses\]/);
});

test("graph <fragment> renders the impact tree", () => {
  const out = run(["graph", "output-format"]);
  assert.match(out, /^output-format — change ripples to:/);
  assert.match(out, /── satisfaction-summarizer \[uses\]/);
});

test("graph --json emits dependents per shared fragment", () => {
  const parsed = JSON.parse(run(["graph", "--json"]));
  const keys = parsed.nodes.map((n) => n.node);
  assert.deepEqual(keys, [
    "brand-voice",
    "escalation-criteria",
    "output-format",
    "refund-policy",
  ]);
});

test("graph rejects unknown nodes with the known-node list", () => {
  assert.throws(
    () => run(["graph", "nope"]),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /unknown node: nope/);
      assert.match(err.stderr, /known nodes:/);
      return true;
    }
  );
});
