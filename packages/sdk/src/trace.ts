import { tracesCol } from "./db";
import { loadPrompt, renderPromptDoc } from "./prompt";
import type { TraceDoc } from "./types";

export interface TracedCallResult<T> {
  result: T;
  output: string;
  model?: string;
  tokens?: object;
}

export interface TracedCallArgs<T> {
  promptName: string;
  input: object;
  fn: (renderedPrompt: string) => Promise<T | TracedCallResult<T>>;
  model?: string;
  score?: number;
}

function isTracedResult<T>(value: unknown): value is TracedCallResult<T> {
  return typeof value === "object" && value !== null && "result" in value && "output" in value;
}

export async function tracedCall<T>(args: TracedCallArgs<T>): Promise<T> {
  const doc = await loadPrompt(args.promptName);
  const rendered = renderPromptDoc(doc);
  const trace: TraceDoc = {
    promptName: doc.name,
    promptVersion: doc.version,
    input: args.input,
    output: "",
    meta: { model: args.model ?? "unknown", latencyMs: 0 },
    ts: new Date(),
  };
  if (args.score !== undefined) trace.score = args.score;

  const start = Date.now();
  try {
    const value = await args.fn(rendered);
    trace.meta.latencyMs = Date.now() - start;
    if (isTracedResult<T>(value)) {
      trace.output = value.output;
      if (value.model) trace.meta.model = value.model;
      if (value.tokens) trace.meta.tokens = value.tokens;
      await tracesCol().insertOne(trace);
      return value.result;
    }
    trace.output = typeof value === "string" ? value : JSON.stringify(value);
    await tracesCol().insertOne(trace);
    return value as T;
  } catch (err) {
    trace.meta.latencyMs = Date.now() - start;
    trace.error = err instanceof Error ? err.message : String(err);
    await tracesCol().insertOne(trace);
    throw err;
  }
}
