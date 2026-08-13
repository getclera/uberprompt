import type { ChangeStreamOptions, ClientSession, Document } from "mongodb";
import { edgesCol, evalRunsCol, getClient, getDb, lessonsCol, promptsCol, syncStateCol, tracesCol } from "./db";
import { embed } from "./embeddings";
import type { EdgeDoc, EdgeEndpoint, LessonDoc } from "./types";

export const FRAGMENTS_TEXT_INDEX_NAME = "fragments_text";
export const FRAGMENTS_VECTOR_INDEX_NAME = "fragments_embedding";
export const RANK_FUSION_MIN_VERSION = { major: 8, minor: 1 } as const;

export interface DependentHit {
  prompt: string;
  fragment?: string;
  kind: "uses" | "semantic";
  depth: number;
}

export interface FragmentHit {
  prompt: string;
  fragment: string;
  text: string;
  score: number;
}

export function buildDependentsPipeline(target: EdgeEndpoint, maxDepth: number): Document[] {
  const match: Document = {};
  if (target.prompt) match["to.prompt"] = target.prompt;
  if (target.fragment) match["to.fragment"] = target.fragment;
  return [
    { $match: match },
    {
      $graphLookup: {
        from: "edges",
        startWith: "$from.prompt",
        connectFromField: "from.prompt",
        connectToField: "to.prompt",
        as: "chain",
        depthField: "chainDepth",
        maxDepth: Math.max(0, maxDepth - 2),
      },
    },
  ];
}

interface DependentsRow extends EdgeDoc {
  chain: Array<EdgeDoc & { chainDepth: number }>;
}

export function flattenDependentsRows(rows: DependentsRow[], maxDepth: number): DependentHit[] {
  const best = new Map<string, DependentHit>();
  const consider = (from: EdgeEndpoint, kind: "uses" | "semantic", depth: number): void => {
    if (!from.prompt || depth > maxDepth) return;
    const key = `${from.prompt}\u0000${from.fragment ?? ""}`;
    const existing = best.get(key);
    if (!existing || depth < existing.depth) {
      best.set(key, {
        prompt: from.prompt,
        ...(from.fragment ? { fragment: from.fragment } : {}),
        kind,
        depth,
      });
    }
  };
  for (const row of rows) {
    consider(row.from, row.kind, 1);
    for (const link of row.chain) consider(link.from, link.kind, link.chainDepth + 2);
  }
  return [...best.values()].sort((a, b) => a.depth - b.depth || a.prompt.localeCompare(b.prompt));
}

export async function getDependents(
  target: { prompt?: string; fragment?: string },
  opts: { maxDepth?: number } = {},
): Promise<DependentHit[]> {
  if (!target.prompt && !target.fragment) {
    throw new Error("getDependents requires a prompt or fragment target");
  }
  const maxDepth = opts.maxDepth ?? 5;
  const rows = await edgesCol()
    .aggregate<DependentsRow>(buildDependentsPipeline(target, maxDepth))
    .toArray();
  return flattenDependentsRows(rows, maxDepth);
}

export function buildSimilarFragmentsPipeline(
  queryVector: number[],
  opts: { excludePrompt?: string; limit?: number; minScore?: number } = {},
): Document[] {
  const limit = opts.limit ?? 10;
  return [
    {
      $vectorSearch: {
        index: FRAGMENTS_VECTOR_INDEX_NAME,
        path: "fragments.embedding",
        queryVector,
        numCandidates: limit * 20,
        limit,
        ...(opts.excludePrompt ? { filter: { name: { $ne: opts.excludePrompt } } } : {}),
      },
    },
    {
      $project: {
        _id: 0,
        name: 1,
        "fragments.key": 1,
        "fragments.text": 1,
        "fragments.embedding": 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
    ...(opts.minScore ? [{ $match: { score: { $gte: opts.minScore } } }] : []),
  ];
}

interface PromptSearchRow {
  name: string;
  fragments: Array<{ key: string; text: string; embedding?: number[] }>;
  score: number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function bestFragmentByCosine(row: PromptSearchRow, queryVector: number[]): FragmentHit | undefined {
  let hit: FragmentHit | undefined;
  let bestScore = -Infinity;
  for (const fragment of row.fragments) {
    if (!fragment.embedding) continue;
    const score = cosine(fragment.embedding, queryVector);
    if (score > bestScore) {
      bestScore = score;
      hit = { prompt: row.name, fragment: fragment.key, text: fragment.text, score: row.score };
    }
  }
  return hit;
}

export async function findSimilarFragments(
  text: string,
  opts: { excludePrompt?: string; limit?: number; minScore?: number } = {},
): Promise<FragmentHit[]> {
  const queryVector = await embed(text);
  const rows = await promptsCol()
    .aggregate<PromptSearchRow>(buildSimilarFragmentsPipeline(queryVector, opts))
    .toArray();
  return rows.flatMap((row) => {
    const hit = bestFragmentByCosine(row, queryVector);
    return hit ? [hit] : [];
  });
}

function phraseSearchStage(span: string, excludePrompt?: string): Document {
  const phrase = { query: span, path: "fragments.text" };
  return {
    $search: {
      index: FRAGMENTS_TEXT_INDEX_NAME,
      compound: {
        must: [{ phrase }],
        ...(excludePrompt ? { mustNot: [{ equals: { path: "name", value: excludePrompt } }] } : {}),
      },
    },
  };
}

export function buildLiteralMatchesPipeline(
  span: string,
  opts: { excludePrompt?: string; limit?: number } = {},
): Document[] {
  return [
    phraseSearchStage(span, opts.excludePrompt),
    { $limit: opts.limit ?? 10 },
    {
      $project: {
        _id: 0,
        name: 1,
        "fragments.key": 1,
        "fragments.text": 1,
        score: { $meta: "searchScore" },
      },
    },
  ];
}

export async function findLiteralMatches(
  span: string,
  opts: { excludePrompt?: string; limit?: number } = {},
): Promise<FragmentHit[]> {
  const rows = await promptsCol()
    .aggregate<PromptSearchRow>(buildLiteralMatchesPipeline(span, opts))
    .toArray();
  const needle = span.toLowerCase();
  return rows.flatMap((row) => {
    const fragment = row.fragments.find((f) => f.text.toLowerCase().includes(needle));
    return fragment
      ? [{ prompt: row.name, fragment: fragment.key, text: fragment.text, score: row.score }]
      : [];
  });
}

export function parseServerVersion(version: string): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Unparseable MongoDB server version: "${version}"`);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function supportsRankFusion(version: string): boolean {
  const { major, minor } = parseServerVersion(version);
  if (major !== RANK_FUSION_MIN_VERSION.major) return major > RANK_FUSION_MIN_VERSION.major;
  return minor >= RANK_FUSION_MIN_VERSION.minor;
}

export function buildRelatedFragmentsPipeline(
  queryVector: number[],
  span: string,
  opts: { excludePrompt?: string; limit?: number } = {},
): Document[] {
  const limit = opts.limit ?? 10;
  return [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [
              {
                $vectorSearch: {
                  index: FRAGMENTS_VECTOR_INDEX_NAME,
                  path: "fragments.embedding",
                  queryVector,
                  numCandidates: limit * 20,
                  limit,
                  ...(opts.excludePrompt
                    ? { filter: { name: { $ne: opts.excludePrompt } } }
                    : {}),
                },
              },
            ],
            literal: [phraseSearchStage(span, opts.excludePrompt), { $limit: limit }],
          },
        },
        combination: { weights: { vector: 0.7, literal: 0.3 } },
      },
    },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        name: 1,
        "fragments.key": 1,
        "fragments.text": 1,
        score: { $meta: "score" },
      },
    },
  ];
}

export async function findRelatedFragments(
  text: string,
  opts: { excludePrompt?: string; limit?: number } = {},
): Promise<PromptSearchRow[]> {
  const info = (await getDb().admin().serverInfo()) as { version: string };
  if (!supportsRankFusion(info.version)) {
    throw new Error(
      `findRelatedFragments requires MongoDB ${RANK_FUSION_MIN_VERSION.major}.${RANK_FUSION_MIN_VERSION.minor}+ for $rankFusion; connected server reports ${info.version}. Upgrade the Atlas cluster, or call findSimilarFragments and findLiteralMatches separately.`,
    );
  }
  const queryVector = await embed(text);
  return promptsCol()
    .aggregate<PromptSearchRow>(buildRelatedFragmentsPipeline(queryVector, text, opts))
    .toArray();
}

export interface EvalTrendAttempt {
  attempt: number;
  baselineAvg: number;
  candidateAvg: number;
  runs: number;
  runningCandidateAvg: number;
}

export interface EvalTrend {
  attempts: EvalTrendAttempt[];
  tally: { passed: number; failed: number; runs: number };
}

export function buildEvalTrendPipeline(promptName: string): Document[] {
  return [
    { $match: { "target.prompt": promptName } },
    {
      $facet: {
        attempts: [
          {
            $group: {
              _id: "$attempt",
              baselineAvg: { $avg: "$summary.baselineAvg" },
              candidateAvg: { $avg: "$summary.candidateAvg" },
              runs: { $sum: 1 },
            },
          },
          {
            $setWindowFields: {
              sortBy: { _id: 1 },
              output: {
                runningCandidateAvg: {
                  $avg: "$candidateAvg",
                  window: { documents: ["unbounded", "current"] },
                },
              },
            },
          },
          {
            $project: {
              _id: 0,
              attempt: "$_id",
              baselineAvg: 1,
              candidateAvg: 1,
              runs: 1,
              runningCandidateAvg: 1,
            },
          },
        ],
        tally: [
          {
            $group: {
              _id: null,
              passed: { $sum: { $cond: ["$summary.passed", 1, 0] } },
              failed: { $sum: { $cond: ["$summary.passed", 0, 1] } },
              runs: { $sum: 1 },
            },
          },
          { $project: { _id: 0 } },
        ],
      },
    },
    {
      $project: {
        attempts: 1,
        tally: { $ifNull: [{ $first: "$tally" }, { passed: 0, failed: 0, runs: 0 }] },
      },
    },
  ];
}

export async function evalTrend(promptName: string): Promise<EvalTrend> {
  const [result] = await evalRunsCol()
    .aggregate<EvalTrend>(buildEvalTrendPipeline(promptName))
    .toArray();
  if (!result) throw new Error(`evalTrend aggregation returned no document for "${promptName}"`);
  return result;
}

export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = getClient().startSession();
  try {
    return await session.withTransaction(fn);
  } finally {
    await session.endSession();
  }
}

export const LESSONS_WATCH_PIPELINE: Document[] = [{ $match: { operationType: "insert" } }];

export function buildLessonsWatchOptions(startAfter?: unknown): ChangeStreamOptions {
  return {
    fullDocument: "updateLookup",
    ...(startAfter !== undefined ? { startAfter } : {}),
  };
}

export interface LessonWatcher {
  resumeToken: () => unknown;
  close: () => Promise<void>;
}

export function watchLessons(
  onLesson: (lesson: LessonDoc, resumeToken: unknown) => void | Promise<void>,
  opts: { startAfter?: unknown } = {},
): LessonWatcher {
  const stream = lessonsCol().watch(LESSONS_WATCH_PIPELINE, buildLessonsWatchOptions(opts.startAfter));
  stream.on("change", (change) => {
    if (change.operationType === "insert" && change.fullDocument) {
      void onLesson(change.fullDocument, change._id);
    }
  });
  return {
    resumeToken: () => stream.resumeToken,
    close: () => stream.close(),
  };
}

export async function loadResumeToken(watcherName: string): Promise<unknown> {
  const doc = await syncStateCol().findOne({ _id: watcherName });
  return doc?.resumeToken ?? undefined;
}

export async function saveResumeToken(watcherName: string, token: unknown): Promise<void> {
  await syncStateCol().updateOne(
    { _id: watcherName },
    { $set: { resumeToken: token, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function watchLessonsResumable(
  watcherName: string,
  onLesson: (lesson: LessonDoc) => void | Promise<void>,
): Promise<LessonWatcher> {
  const token = await loadResumeToken(watcherName);
  const opts: ChangeStreamOptions = {
    fullDocument: "updateLookup",
    ...(token !== undefined ? { startAfter: token } : {}),
  };
  const stream = lessonsCol().watch(LESSONS_WATCH_PIPELINE, opts);
  stream.on("change", (change) => {
    if (change.operationType === "insert" && change.fullDocument) {
      void (async () => {
        await onLesson(change.fullDocument);
        await saveResumeToken(watcherName, change._id);
      })();
    }
  });
  return {
    resumeToken: () => stream.resumeToken,
    close: () => stream.close(),
  };
}

export interface LatencyBucket {
  _id: number | string;
  count: number;
  avgLatency: number;
  errorCount: number;
}

export function buildLatencyHistogramPipeline(since: Date): Document[] {
  return [
    { $match: { ts: { $gte: since } } },
    {
      $bucket: {
        groupBy: "$meta.latencyMs",
        boundaries: [0, 100, 250, 500, 1000, 2500, 5000],
        default: "5000+",
        output: {
          count: { $sum: 1 },
          avgLatency: { $avg: "$meta.latencyMs" },
          errorCount: { $sum: { $cond: [{ $ifNull: ["$error", false] }, 1, 0] } },
        },
      },
    },
  ];
}

export async function latencyHistogram(since: Date): Promise<LatencyBucket[]> {
  return tracesCol().aggregate<LatencyBucket>(buildLatencyHistogramPipeline(since)).toArray();
}

export interface DashboardSummary {
  latency: { p50: number; p95: number; p99: number } | null;
  errorRate: { total: number; errors: number; rate: number } | null;
  tokensByPrompt: Array<{ promptName: string; totalTokens: number }>;
}

export function buildDashboardSummaryPipeline(since: Date): Document[] {
  return [
    { $match: { ts: { $gte: since } } },
    {
      $facet: {
        latency: [
          {
            $group: {
              _id: null,
              p50: { $percentile: { input: "$meta.latencyMs", p: [0.5], method: "approximate" } },
              p95: { $percentile: { input: "$meta.latencyMs", p: [0.95], method: "approximate" } },
              p99: { $percentile: { input: "$meta.latencyMs", p: [0.99], method: "approximate" } },
            },
          },
          { $project: { _id: 0 } },
        ],
        errorRate: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              errors: { $sum: { $cond: [{ $ifNull: ["$error", false] }, 1, 0] } },
            },
          },
          { $project: { _id: 0, total: 1, errors: 1, rate: { $divide: ["$errors", "$total"] } } },
        ],
        tokensByPrompt: [
          { $match: { promptName: { $exists: true } } },
          {
            $group: {
              _id: "$promptName",
              totalTokens: { $sum: { $ifNull: ["$meta.tokens.totalTokens", 0] } },
            },
          },
          { $project: { _id: 0, promptName: "$_id", totalTokens: 1 } },
          { $sort: { totalTokens: -1 } },
        ],
      },
    },
    {
      $project: {
        latency: { $ifNull: [{ $first: "$latency" }, null] },
        errorRate: { $ifNull: [{ $first: "$errorRate" }, null] },
        tokensByPrompt: 1,
      },
    },
  ];
}

export async function dashboardSummary(since: Date): Promise<DashboardSummary> {
  const [result] = await tracesCol()
    .aggregate<DashboardSummary>(buildDashboardSummaryPipeline(since))
    .toArray();
  return result ?? { latency: null, errorRate: null, tokensByPrompt: [] };
}

export interface TimelineBucket {
  ts: Date;
  traceCount: number;
  avgLatency: number;
  errorCount: number;
}

export function buildTraceTimelinePipeline(since: Date, until: Date): Document[] {
  return [
    { $match: { ts: { $gte: since, $lte: until } } },
    {
      $group: {
        _id: { $dateTrunc: { date: "$ts", unit: "hour" } },
        traceCount: { $sum: 1 },
        avgLatency: { $avg: "$meta.latencyMs" },
        errorCount: { $sum: { $cond: [{ $ifNull: ["$error", false] }, 1, 0] } },
      },
    },
    { $project: { _id: 0, ts: "$_id", traceCount: 1, avgLatency: 1, errorCount: 1 } },
    { $sort: { ts: 1 } },
    { $densify: { field: "ts", range: { step: 1, unit: "hour", bounds: [since, until] } } },
    {
      $fill: {
        sortBy: { ts: 1 },
        output: {
          traceCount: { value: 0 },
          avgLatency: { value: 0 },
          errorCount: { value: 0 },
        },
      },
    },
  ];
}

export async function traceTimeline(since: Date, until: Date): Promise<TimelineBucket[]> {
  return tracesCol().aggregate<TimelineBucket>(buildTraceTimelinePipeline(since, until)).toArray();
}
