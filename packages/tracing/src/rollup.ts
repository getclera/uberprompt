import type { Document } from "mongodb";
import { COLLECTIONS, spansCol } from "@uberprompt/sdk";

const ROOT = {
  $ifNull: [
    { $first: { $filter: { input: "$spans", cond: { $not: [{ $ifNull: ["$$this.parentSpanId", false] }] } } } },
    { $first: "$spans" },
  ],
};

const LLM_SPAN = {
  $first: { $filter: { input: "$spans", cond: { $ne: [{ $ifNull: ["$$this.genAi.requestModel", null] }, null] } } },
};

const BOUND_SPAN = {
  $first: { $filter: { input: "$spans", cond: { $ne: [{ $ifNull: ["$$this.prompt", null] }, null] } } },
};

const WITH_PROVIDER = {
  $first: { $filter: { input: "$spans", cond: { $ne: [{ $ifNull: ["$$this.genAi.provider", null] }, null] } } },
};

const WITH_INPUT = {
  $first: { $filter: { input: "$spans", cond: { $ne: [{ $ifNull: ["$$this.input", null] }, null] } } },
};

const WITH_OUTPUT = {
  $first: { $filter: { input: "$spans", cond: { $ne: [{ $ifNull: ["$$this.output", null] }, null] } } },
};

function positive(expr: string | Document): Document {
  return { $cond: [{ $gt: [expr, 0] }, expr, "$$REMOVE"] };
}

function sumOverChildren(field: string): Document {
  return {
    $sum: {
      $cond: [{ $ifNull: ["$parentSpanId", false] }, { $ifNull: [field, 0] }, 0],
    },
  };
}

function rootUsageOrChildren(field: string, childSum: string): Document {
  return { $ifNull: [`$root.genAi.usage.${field}`, childSum] };
}

export function rollupPipeline(traceIds: string[]): Document[] {
  return [
    { $match: { traceId: { $in: traceIds } } },
    { $sort: { startTime: 1 } },
    {
      $group: {
        _id: "$traceId",
        spans: { $push: "$$ROOT" },
        spanCount: { $sum: 1 },
        service: { $first: "$service" },
        childInputTokens: sumOverChildren("$genAi.usage.inputTokens"),
        childOutputTokens: sumOverChildren("$genAi.usage.outputTokens"),
        childCacheReadInputTokens: sumOverChildren("$genAi.usage.cacheReadInputTokens"),
        childCacheCreationInputTokens: sumOverChildren("$genAi.usage.cacheCreationInputTokens"),
        errors: {
          $push: {
            $cond: [{ $eq: ["$status", "error"] }, { $ifNull: ["$statusMessage", "error"] }, "$$REMOVE"],
          },
        },
      },
    },
    {
      $set: {
        root: ROOT,
        llm: LLM_SPAN,
        bound: BOUND_SPAN,
        provider: WITH_PROVIDER,
        withInput: WITH_INPUT,
        withOutput: WITH_OUTPUT,
      },
    },
    {
      $set: {
        inputTokens: rootUsageOrChildren("inputTokens", "$childInputTokens"),
        outputTokens: rootUsageOrChildren("outputTokens", "$childOutputTokens"),
        cacheReadInputTokens: rootUsageOrChildren("cacheReadInputTokens", "$childCacheReadInputTokens"),
        cacheCreationInputTokens: rootUsageOrChildren(
          "cacheCreationInputTokens",
          "$childCacheCreationInputTokens",
        ),
      },
    },
    {
      $project: {
        _id: 0,
        traceId: "$_id",
        service: 1,
        spanCount: 1,
        operation: { $ifNull: ["$root.genAi.operation", "$root.name"] },
        promptName: { $ifNull: ["$bound.prompt.name", "$$REMOVE"] },
        promptVersion: { $ifNull: ["$bound.prompt.version", "$$REMOVE"] },
        promptVersionId: { $ifNull: ["$bound.prompt.versionId", "$$REMOVE"] },
        contentHash: { $ifNull: ["$bound.prompt.contentHash", "$$REMOVE"] },
        input: { $ifNull: ["$withInput.input", null] },
        output: { $ifNull: ["$withOutput.output", ""] },
        meta: {
          provider: { $ifNull: ["$llm.genAi.provider", "$provider.genAi.provider", "$$REMOVE"] },
          model: { $ifNull: ["$llm.genAi.responseModel", "$llm.genAi.requestModel", "unknown"] },
          latencyMs: { $ifNull: ["$root.durationMs", 0] },
          tokens: {
            $let: {
              vars: {
                tokens: {
                  inputTokens: positive("$inputTokens"),
                  outputTokens: positive("$outputTokens"),
                  totalTokens: positive({ $add: ["$inputTokens", "$outputTokens"] }),
                  cacheReadInputTokens: positive("$cacheReadInputTokens"),
                  cacheCreationInputTokens: positive("$cacheCreationInputTokens"),
                },
              },
              in: { $cond: [{ $eq: [{ $size: { $objectToArray: "$$tokens" } }, 0] }, "$$REMOVE", "$$tokens"] },
            },
          },
        },
        error: { $ifNull: [{ $first: "$errors" }, "$$REMOVE"] },
        ts: "$root.startTime",
      },
    },
    {
      $merge: {
        into: COLLECTIONS.traces,
        on: "traceId",
        whenMatched: "merge",
        whenNotMatched: "insert",
      },
    },
  ];
}

export async function rollupTraces(traceIds: string[]): Promise<void> {
  if (traceIds.length === 0) return;
  await spansCol().aggregate(rollupPipeline(traceIds)).toArray();
}
