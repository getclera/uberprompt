import type { ObjectId } from "mongodb";

// Collection names (db: "uberprompt") — see docs/IDEA.md "Data model — THE CONTRACT"
export const COLLECTIONS = {
  prompts: "prompts",
  promptVersions: "prompt_versions",
  edges: "edges",
  traces: "traces",
  lessons: "lessons",
  proposals: "proposals",
} as const;

export interface PromptFragment {
  key: string;
  text: string;
  embedding?: number[];
}

// prompts — current version per name lives here; history in prompt_versions
export interface PromptDoc {
  _id?: ObjectId;
  name: string;
  version: number;
  fragments: PromptFragment[];
  template: string; // e.g. "{{intro}}\n{{tone}}\n{{task}}" refs fragment keys
  updatedAt: Date;
  updatedBy: string;
}

// prompt_versions — immutable snapshots (same shape + { promptName, frozenAt })
export interface PromptVersionDoc extends PromptDoc {
  promptName: string;
  frozenAt: Date;
}

export interface EdgeEndpoint {
  prompt: string;
  fragment?: string;
}

// edges — dependency graph
export interface EdgeDoc {
  _id?: ObjectId;
  from: EdgeEndpoint;
  to: EdgeEndpoint;
  kind: "uses" | "semantic"; // "uses" = declared in SDK; "semantic" = agent-found
  note?: string;
}

// traces
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

// lessons — the agent's persistent memory
export interface LessonDoc {
  _id?: ObjectId;
  text: string;
  embedding: number[];
  sourceTraceIds: ObjectId[];
  appliesTo: string[]; // prompt names
  status: "active" | "superseded";
  ts: Date;
}

// proposals — pending changes awaiting human approval in the dashboard
export interface ProposalDoc {
  _id?: ObjectId;
  target: { prompt: string; fragment?: string };
  oldText: string;
  newText: string;
  reason: string;
  source: { type: "consistency" | "lesson"; ref?: ObjectId };
  status: "pending" | "applied" | "rejected";
  ts: Date;
}
