import type { TokenUsage } from "@uberprompt/sdk";

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

// USD per million tokens, Anthropic first-party list rates. Cache read is 0.1x input;
// cache write is 1.25x input at the default 5-minute TTL (2x at 1h — not modelled here).
// Longest matching prefix wins, so "claude-opus-5-20260101" resolves to "claude-opus-5".
// Models absent here are deliberately unpriced rather than assumed free — see estimateCostUsd.
// Add other providers, or Sonnet 5's introductory $2/$10 rate (through 2026-08-31), via
// UBERPROMPT_PRICING as JSON.
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
};

function loadPricing(): Record<string, ModelPricing> {
  const raw = process.env.UBERPROMPT_PRICING;
  if (raw === undefined) return DEFAULT_PRICING;
  return { ...DEFAULT_PRICING, ...(JSON.parse(raw) as Record<string, ModelPricing>) };
}

export function pricingFor(model: string): ModelPricing | undefined {
  const pricing = loadPricing();
  const exact = pricing[model];
  if (exact !== undefined) return exact;
  const prefix = Object.keys(pricing)
    .filter((key) => model.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return prefix === undefined ? undefined : pricing[prefix];
}

// Returns undefined rather than 0 for unpriced models: a missing price is not free,
// and summing unknowns as zero would quietly understate spend.
export function estimateCostUsd(model: string, usage: TokenUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;
  const price = pricingFor(model);
  if (price === undefined) return undefined;

  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const billableInput = Math.max((usage.inputTokens ?? 0) - cacheRead - cacheWrite, 0);

  const usd =
    (billableInput * price.inputPerMTok +
      (usage.outputTokens ?? 0) * price.outputPerMTok +
      cacheRead * (price.cacheReadPerMTok ?? price.inputPerMTok) +
      cacheWrite * (price.cacheWritePerMTok ?? price.inputPerMTok)) /
    1_000_000;

  return Math.round(usd * 1e6) / 1e6;
}

export function formatUsd(usd: number | undefined): string {
  if (usd === undefined) return "-";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}
