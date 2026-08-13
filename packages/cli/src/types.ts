import type { ObjectId } from "mongodb";

export interface Ref {
  prompt?: string;
  fragment?: string;
}

export interface Edge {
  from: Ref;
  to: Ref;
  kind: string;
  note?: string;
  confidence?: number;
  model?: string;
  inferredAt?: string;
}

export interface Fragment {
  key: string;
  version?: number;
  text: string;
  embedding?: number[];
}

export interface PromptDoc {
  name: string;
  version: number;
  description?: string;
  descriptionEmbedding?: number[];
  template?: string;
  fragments: Fragment[];
  uses?: string[];
}

export interface GraphModel {
  edges: Edge[];
  prompts: Map<string, PromptDoc>;
}

export interface RenderModel extends GraphModel {
  fragments: Map<string, Fragment>;
}

export interface Model extends RenderModel {
  dir: string;
  fragmentsDir: string;
  promptsDir: string;
  edgesPath: string;
}

export interface RevEntry {
  from: string;
  kind: string;
  note?: string;
  confidence?: number;
}

export interface FwdEntry {
  to: string;
  kind: string;
  note?: string;
  confidence?: number;
}

export interface Graph {
  rev: Map<string, RevEntry[]>;
  fwd: Map<string, FwdEntry[]>;
  promptNames: Set<string>;
  owningPrompt: (node: string) => string | null;
  localFragments: Map<string, string[]>;
}

export interface DepEntry {
  node: string;
  kind: string;
  note?: string;
  confidence?: number;
  via: string[];
}

export interface Palette {
  cyan: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  magenta: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

export interface CliOpts {
  _: string[];
  dir?: string;
  base?: string;
  staged?: boolean;
  json?: boolean;
  apply?: boolean;
  "dry-run"?: boolean;
  "no-color"?: boolean;
  all?: boolean;
  tree?: boolean;
  threshold?: number;
  port?: string;
  service?: string;
  model?: string;
  against?: string;
  to?: string;
  limit?: string;
  "dedup-threshold"?: string;
  "no-sync"?: boolean;
  [key: string]: unknown;
}

export interface CliEnv {
  MONGODB_URI: string | null;
  MONGODB_DB: string | null;
  OPENAI_API_KEY: string | null;
  VOYAGE_API_KEY: string | null;
}

export interface ProposalDoc {
  _id: ObjectId;
  target: { prompt: string; fragment?: string };
  oldText: string;
  newText: string;
  reason: string;
  source?: { type: string; ref?: unknown };
  status: string;
  ts: Date | string;
}

export interface LessonDoc {
  _id: ObjectId;
  text: string;
  reason?: string;
  embedding?: number[];
  appliesTo?: string[];
  status?: string;
  processedAt?: Date;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
