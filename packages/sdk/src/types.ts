import type { ObjectId } from "mongodb";

export const COLLECTIONS = {
  prompts: "prompts",
  promptVersions: "prompt_versions",
  edges: "edges",
  spans: "spans",
  traces: "traces",
  lessons: "lessons",
  proposals: "proposals",
  evalRuns: "eval_runs",
} as const;

export interface PromptFragment {
  key: string;
  text: string;
  embedding?: number[];
}

export interface PromptDoc {
  _id?: ObjectId;
  name: string;
  version: number;
  description: string;
  descriptionEmbedding?: number[];
  fragments: PromptFragment[];
  template: string;
  contentHash?: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface PromptVersionDoc extends PromptDoc {
  promptName: string;
  frozenAt: Date;
  contentHash?: string;
}

export interface EdgeEndpoint {
  prompt?: string;
  fragment?: string;
}

export interface EdgeDoc {
  _id?: ObjectId;
  from: EdgeEndpoint;
  to: EdgeEndpoint;
  kind: "uses" | "semantic";
  note?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface GenAiFacts {
  operation?: string;
  provider?: string;
  requestModel?: string;
  responseModel?: string;
  responseId?: string;
  finishReasons?: string[];
  toolName?: string;
  toolCallId?: string;
  usage?: TokenUsage;
}

export interface PromptRef {
  name: string;
  version: number;
  versionId: ObjectId;
  contentHash: string;
}

export interface SpanDoc {
  _id?: ObjectId;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  service: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  status: "ok" | "error";
  statusMessage?: string;
  genAi?: GenAiFacts;
  prompt?: PromptRef;
  input?: unknown;
  output?: string;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  ingestedAt: Date;
}

export interface TraceDoc {
  _id?: ObjectId;
  traceId: string;
  service: string;
  operation: string;
  promptName?: string;
  promptVersion?: number;
  promptVersionId?: ObjectId;
  contentHash?: string;
  input: unknown;
  output: string;
  meta: {
    provider?: string;
    model: string;
    latencyMs: number;
    tokens?: TokenUsage;
  };
  spanCount: number;
  score?: number;
  error?: string;
  ts: Date;
}

export interface LessonDoc {
  _id?: ObjectId;
  text: string;
  reason?: string;
  embedding: number[];
  sourceTraceIds: ObjectId[];
  appliesTo: string[];
  status: "active" | "superseded";
  processedAt?: Date;
  ts: Date;
}

export interface UndeclaredHit {
  prompt: string;
  fragment: string;
  score: number;
  kind: "semantic" | "literal";
}

export interface ProposalCulprit {
  fragment: string;
  span: string;
  traceIds: ObjectId[];
  sharedWith: string[];
  undeclared?: UndeclaredHit[];
}

export interface ProposalEvals {
  runIds: ObjectId[];
  passed: boolean;
  baselineAvg: number;
  candidateAvg: number;
}

export interface ProposalDoc {
  _id?: ObjectId;
  target: { prompt: string; fragment?: string };
  oldText: string;
  newText: string;
  reason: string;
  source: { type: "lesson" | "sync-check" | "human-edit"; ref?: ObjectId };
  status: "evaluating" | "pending" | "applied" | "rejected";
  ts: Date;
  culprit?: ProposalCulprit;
  evals?: ProposalEvals;
}

export type Rubric = Record<string, number>;

export interface EvalCase {
  caseId: string;
  kind: "replay" | "golden";
  input: object;
  baselineOutput: string;
  candidateOutput: string;
  baseline: Rubric;
  candidate: Rubric;
  delta: number;
  verdict: "win" | "tie" | "loss";
  critique: string;
}

export interface EvalRunSummary {
  replayWins: number;
  replayLosses: number;
  goldenRegressions: number;
  baselineAvg: number;
  candidateAvg: number;
  passed: boolean;
}

export interface EvalRunDoc {
  _id?: ObjectId;
  proposalId: ObjectId;
  lessonId: ObjectId | null;
  target: { prompt: string; fragment: string };
  attempt: number;
  candidateText: string;
  cases: EvalCase[];
  summary: EvalRunSummary;
  judgeModel: string;
  genModel: string;
  ts: Date;
}
