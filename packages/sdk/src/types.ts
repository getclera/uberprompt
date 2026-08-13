import type { ObjectId } from "mongodb";

export const COLLECTIONS = {
  prompts: "prompts",
  promptVersions: "prompt_versions",
  edges: "edges",
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
  updatedAt: Date;
  updatedBy: string;
}

export interface PromptVersionDoc extends PromptDoc {
  promptName: string;
  frozenAt: Date;
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

export interface TraceDoc {
  _id?: ObjectId;
  promptName: string;
  promptVersion: number;
  input: object;
  output: string;
  meta: {
    model: string;
    latencyMs: number;
    tokens?: object;
  };
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

export interface ProposalCulprit {
  fragment: string;
  span: string;
  traceIds: ObjectId[];
  sharedWith: string[];
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
