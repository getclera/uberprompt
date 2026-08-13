import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { estimateCostUsd, formatUsd, pricingFor, resetPricingCache } from "./cost";

afterEach(() => {
  delete process.env.UBERPROMPT_PRICING;
  resetPricingCache();
});

describe("pricingFor", () => {
  it("resolves an exact model id", () => {
    assert.equal(pricingFor("claude-opus-5")?.inputPerMTok, 5);
  });

  it("resolves a dated snapshot to its base model", () => {
    assert.equal(pricingFor("claude-opus-5-20260101")?.inputPerMTok, 5);
  });

  it("prefers the longest matching prefix", () => {
    process.env.UBERPROMPT_PRICING = JSON.stringify({
      "claude-opus-5-mini": { inputPerMTok: 1, outputPerMTok: 2 },
    });
    resetPricingCache();
    assert.equal(pricingFor("claude-opus-5-mini")?.inputPerMTok, 1);
    assert.equal(pricingFor("claude-opus-5")?.inputPerMTok, 5);
  });

  it("returns undefined for an unknown model rather than a default", () => {
    assert.equal(pricingFor("gpt-5-nano"), undefined);
  });

  it("falls back to defaults when the override is malformed", () => {
    process.env.UBERPROMPT_PRICING = "{not valid json";
    resetPricingCache();
    assert.equal(pricingFor("claude-opus-5")?.inputPerMTok, 5);
  });
});

describe("estimateCostUsd", () => {
  it("prices input at the list rate", () => {
    assert.equal(estimateCostUsd("claude-opus-5", { inputTokens: 1_000_000, outputTokens: 0 }), 5);
  });

  it("prices output at the list rate", () => {
    assert.equal(estimateCostUsd("claude-opus-5", { inputTokens: 0, outputTokens: 1_000_000 }), 25);
  });

  it("bills cache reads at the cached rate instead of the input rate", () => {
    const usd = estimateCostUsd("claude-opus-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    });
    assert.equal(usd, 0.5);
  });

  it("does not double-count cached tokens as fresh input", () => {
    const usd = estimateCostUsd("claude-opus-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 500_000,
    });
    assert.equal(usd, 2.75);
  });

  it("never returns a negative cost when cache counts exceed the input total", () => {
    const usd = estimateCostUsd("claude-opus-5", {
      inputTokens: 100,
      outputTokens: 0,
      cacheReadInputTokens: 400,
    });
    assert.ok(usd !== undefined && usd >= 0, `expected non-negative, got ${usd}`);
  });

  // Unknown must never render as free: an unpriced model summed as zero understates spend.
  it("returns undefined for an unpriced model", () => {
    assert.equal(estimateCostUsd("gpt-5-nano", { inputTokens: 1000, outputTokens: 1000 }), undefined);
  });

  it("returns undefined when usage is absent", () => {
    assert.equal(estimateCostUsd("claude-opus-5", undefined), undefined);
  });

  // The rollup emits a usage object whose fields are all absent when no span reported
  // tokens; that must read as unknown, not as zero cost.
  it("returns undefined when every token field is absent", () => {
    assert.equal(estimateCostUsd("claude-opus-5", {}), undefined);
  });

  it("treats an explicit zero as priced, not absent", () => {
    assert.equal(estimateCostUsd("claude-opus-5", { inputTokens: 0, outputTokens: 0 }), 0);
  });
});

describe("formatUsd", () => {
  it("renders absent cost as a dash", () => {
    assert.equal(formatUsd(undefined), "-");
  });

  it("keeps sub-cent amounts visible", () => {
    assert.equal(formatUsd(0.00898), "$0.00898");
  });

  it("renders zero distinctly from absent", () => {
    assert.equal(formatUsd(0), "$0");
  });
});
