import type { Document } from "mongodb";
import { COLLECTIONS, tracesCol } from "@uberprompt/sdk";

export interface VersionStats {
  promptName: string;
  promptVersion: number;
  traces: number;
  errors: number;
  errorRate: number;
  avgScore?: number;
  avgLatencyMs: number;
  model?: string;
  avgInputTokens?: number;
  avgOutputTokens?: number;
  firstSeen: Date;
  lastSeen: Date;
  frozenAt?: Date;
}

export interface VersionDelta {
  promptName: string;
  from: VersionStats;
  to: VersionStats;
  scoreDelta?: number;
  errorRateDelta: number;
  latencyDelta: number;
}

function statsPipeline(promptName?: string): Document[] {
  const match: Document = { promptName: { $exists: true }, promptVersion: { $exists: true } };
  if (promptName !== undefined) match.promptName = promptName;

  return [
    { $match: match },
    {
      $group: {
        _id: { promptName: "$promptName", promptVersion: "$promptVersion" },
        promptVersionId: { $first: "$promptVersionId" },
        traces: { $sum: 1 },
        errors: { $sum: { $cond: [{ $ifNull: ["$error", false] }, 1, 0] } },
        avgScore: { $avg: "$score" },
        avgLatencyMs: { $avg: "$meta.latencyMs" },
        model: { $first: "$meta.model" },
        avgInputTokens: { $avg: "$meta.tokens.inputTokens" },
        avgOutputTokens: { $avg: "$meta.tokens.outputTokens" },
        firstSeen: { $min: "$ts" },
        lastSeen: { $max: "$ts" },
      },
    },
    {
      $lookup: {
        from: COLLECTIONS.promptVersions,
        localField: "promptVersionId",
        foreignField: "_id",
        as: "version",
      },
    },
    {
      $project: {
        _id: 0,
        promptName: "$_id.promptName",
        promptVersion: "$_id.promptVersion",
        traces: 1,
        errors: 1,
        errorRate: { $divide: ["$errors", "$traces"] },
        avgScore: 1,
        avgLatencyMs: { $round: ["$avgLatencyMs", 0] },
        model: 1,
        avgInputTokens: { $round: ["$avgInputTokens", 0] },
        avgOutputTokens: { $round: ["$avgOutputTokens", 0] },
        firstSeen: 1,
        lastSeen: 1,
        frozenAt: { $first: "$version.frozenAt" },
      },
    },
    { $sort: { promptName: 1, promptVersion: 1 } },
  ];
}

// Mongo's $avg returns null for fields absent from every document; normalize those to
// undefined at the boundary so downstream code can rely on a single absent-value shape.
export async function versionStats(promptName?: string): Promise<VersionStats[]> {
  return (await tracesCol().aggregate<VersionStats>(statsPipeline(promptName)).toArray()).map((row) => ({
    ...row,
    avgScore: row.avgScore ?? undefined,
    model: row.model ?? undefined,
    avgInputTokens: row.avgInputTokens ?? undefined,
    avgOutputTokens: row.avgOutputTokens ?? undefined,
  }));
}

export function versionDeltas(stats: VersionStats[]): VersionDelta[] {
  const byPrompt = new Map<string, VersionStats[]>();
  for (const row of stats) {
    const list = byPrompt.get(row.promptName) ?? [];
    list.push(row);
    byPrompt.set(row.promptName, list);
  }

  const deltas: VersionDelta[] = [];
  for (const [promptName, versions] of byPrompt) {
    for (let i = 1; i < versions.length; i += 1) {
      const from = versions[i - 1];
      const to = versions[i];
      if (from === undefined || to === undefined) continue;
      const delta: VersionDelta = {
        promptName,
        from,
        to,
        errorRateDelta: to.errorRate - from.errorRate,
        latencyDelta: to.avgLatencyMs - from.avgLatencyMs,
      };
      if (from.avgScore !== undefined && to.avgScore !== undefined) {
        delta.scoreDelta = to.avgScore - from.avgScore;
      }
      deltas.push(delta);
    }
  }
  return deltas;
}
