import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePromptContentHash } from "./prompt";

const TEMPLATE = "{{role}}\n{{tone}}";
const FRAGMENTS = [
  { key: "role", text: "You are a support agent." },
  { key: "tone", text: "Be concise." },
];

describe("computePromptContentHash", () => {
  it("is stable across repeated calls", () => {
    assert.equal(computePromptContentHash(TEMPLATE, FRAGMENTS), computePromptContentHash(TEMPLATE, FRAGMENTS));
  });

  it("returns a sha256 hex digest", () => {
    assert.match(computePromptContentHash(TEMPLATE, FRAGMENTS), /^[0-9a-f]{64}$/);
  });

  // Fragment order is an artifact of how the caller built the object, not content.
  it("ignores fragment order", () => {
    assert.equal(
      computePromptContentHash(TEMPLATE, FRAGMENTS),
      computePromptContentHash(TEMPLATE, [...FRAGMENTS].reverse()),
    );
  });

  it("ignores embeddings, which are derived rather than authored", () => {
    const withEmbedding = FRAGMENTS.map((f) => ({ ...f, embedding: [0.1, 0.2, 0.3] }));
    assert.equal(computePromptContentHash(TEMPLATE, withEmbedding), computePromptContentHash(TEMPLATE, FRAGMENTS));
  });

  it("changes when fragment text changes", () => {
    const edited = [FRAGMENTS[0]!, { key: "tone", text: "Be VERY concise." }];
    assert.notEqual(computePromptContentHash(TEMPLATE, FRAGMENTS), computePromptContentHash(TEMPLATE, edited));
  });

  it("changes when the template changes", () => {
    assert.notEqual(
      computePromptContentHash(TEMPLATE, FRAGMENTS),
      computePromptContentHash("{{tone}}\n{{role}}", FRAGMENTS),
    );
  });

  it("changes when a fragment key is renamed", () => {
    const renamed = [FRAGMENTS[0]!, { key: "voice", text: "Be concise." }];
    assert.notEqual(computePromptContentHash(TEMPLATE, FRAGMENTS), computePromptContentHash(TEMPLATE, renamed));
  });

  it("distinguishes a fragment being added", () => {
    const extra = [...FRAGMENTS, { key: "task", text: "Route the ticket." }];
    assert.notEqual(computePromptContentHash(TEMPLATE, FRAGMENTS), computePromptContentHash(TEMPLATE, extra));
  });

  // The hash is a cross-machine version identity. Sorting with localeCompare would make
  // it depend on the host's locale, so the same prompt could hash differently per laptop.
  it("orders fragments by codepoint, independent of locale collation", () => {
    const keys = ["Z", "a", "ä", "b", "A"];
    const fragments = keys.map((key) => ({ key, text: `text-${key}` }));
    const expected = [...keys].sort().map((key) => ({ key, text: `text-${key}` }));

    assert.equal(
      computePromptContentHash("t", fragments),
      computePromptContentHash("t", expected),
      "hash must match codepoint-sorted order",
    );
    // Locale collation puts "ä" next to "a"; codepoint order does not. If the
    // implementation used localeCompare these two would disagree.
    assert.notEqual([...keys].sort().join(), [...keys].sort((a, b) => a.localeCompare(b)).join());
  });
});
