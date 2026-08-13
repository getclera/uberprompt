import assert from "node:assert/strict";
import test from "node:test";
import { computePromptContentHash, nextVersionOf } from "./prompt";
import type { PromptDoc } from "./types";

function promptDoc(): PromptDoc {
  return {
    name: "billing-agent",
    version: 3,
    description: "billing",
    fragments: [
      { key: "task", text: "old task", embedding: [0.1] },
      { key: "brand-voice", text: "warm", embedding: [0.2] },
    ],
    template: "{{task}}\n{{brand-voice}}",
    contentHash: "stale",
    updatedAt: new Date("2026-08-13T00:00:00Z"),
    updatedBy: "sdk",
  };
}

test("approving a proposal bumps the version and rewrites only the target fragment", () => {
  const next = nextVersionOf(promptDoc(), "task", "new task", [0.9]);
  assert.equal(next.version, 4);
  assert.equal(next.fragments.find((f) => f.key === "task")?.text, "new task");
  assert.deepEqual(next.fragments.find((f) => f.key === "task")?.embedding, [0.9]);
  assert.equal(next.fragments.find((f) => f.key === "brand-voice")?.text, "warm");
  assert.deepEqual(next.fragments.find((f) => f.key === "brand-voice")?.embedding, [0.2]);
  assert.equal(next.updatedBy, "approval");
});

test("the new version carries a content hash matching its own text", () => {
  const next = nextVersionOf(promptDoc(), "task", "new task", [0.9]);
  assert.equal(next.contentHash, computePromptContentHash(next.template, next.fragments));
  assert.notEqual(next.contentHash, promptDoc().contentHash);
});

test("identical approved text yields an identical hash, so version identity stays deterministic", () => {
  const a = nextVersionOf(promptDoc(), "task", "new task", [0.9]);
  const b = nextVersionOf(promptDoc(), "task", "new task", [0.1]);
  assert.equal(a.contentHash, b.contentHash);
});

test("approving a fragment the prompt does not have is refused", () => {
  assert.throws(() => nextVersionOf(promptDoc(), "nope", "x", [0.1]), /has no fragment "nope"/);
});
