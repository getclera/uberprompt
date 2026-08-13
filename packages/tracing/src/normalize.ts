import { ObjectId } from "mongodb";
import type { GenAiFacts, PromptRef, SpanDoc, TokenUsage } from "@uberprompt/sdk";
import { AI_SDK, GEN_AI, UBERPROMPT } from "./attributes";

export interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  startTime: Date;
  endTime: Date;
  status: "ok" | "error";
  statusMessage?: string;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
}

function str(attrs: Record<string, unknown>, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === "string" ? value : undefined;
}

function num(attrs: Record<string, unknown>, key: string): number | undefined {
  const value = attrs[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function strList(attrs: Record<string, unknown>, key: string): string[] | undefined {
  const value = attrs[key];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return undefined;
}

function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

function extractUsage(attrs: Record<string, unknown>): TokenUsage | undefined {
  const inputTokens = num(attrs, GEN_AI.inputTokens);
  const outputTokens = num(attrs, GEN_AI.outputTokens);
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
    cacheReadInputTokens: num(attrs, GEN_AI.cacheReadInputTokens),
    cacheCreationInputTokens: num(attrs, GEN_AI.cacheCreationInputTokens),
  };
  return compact(usage);
}

function extractGenAi(attrs: Record<string, unknown>): GenAiFacts | undefined {
  const facts: GenAiFacts = {
    operation: str(attrs, GEN_AI.operation) ?? str(attrs, AI_SDK.operationId),
    provider: str(attrs, GEN_AI.provider) ?? str(attrs, GEN_AI.system),
    requestModel: str(attrs, GEN_AI.requestModel),
    responseModel: str(attrs, GEN_AI.responseModel),
    responseId: str(attrs, GEN_AI.responseId),
    finishReasons: strList(attrs, GEN_AI.finishReasons),
    toolName: str(attrs, GEN_AI.toolName),
    toolCallId: str(attrs, GEN_AI.toolCallId),
    usage: extractUsage(attrs),
  };
  return compact(facts);
}

function extractPromptRef(attrs: Record<string, unknown>): PromptRef | undefined {
  const name = str(attrs, UBERPROMPT.name);
  const version = num(attrs, UBERPROMPT.version);
  const versionId = str(attrs, UBERPROMPT.versionId);
  const contentHash = str(attrs, UBERPROMPT.contentHash);
  if (name === undefined || version === undefined || versionId === undefined || contentHash === undefined) {
    return undefined;
  }
  if (!ObjectId.isValid(versionId)) return undefined;
  return { name, version, versionId: new ObjectId(versionId), contentHash };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractInput(attrs: Record<string, unknown>): unknown {
  const messages = str(attrs, GEN_AI.inputMessages) ?? str(attrs, AI_SDK.promptMessages);
  if (messages !== undefined) return parseJson(messages);
  const prompt = str(attrs, AI_SDK.prompt);
  return prompt === undefined ? undefined : parseJson(prompt);
}

function extractOutput(attrs: Record<string, unknown>): string | undefined {
  return (
    str(attrs, AI_SDK.responseText) ??
    str(attrs, AI_SDK.responseObject) ??
    str(attrs, GEN_AI.outputMessages)
  );
}

export function toSpanDoc(raw: RawSpan, fallbackService: string): SpanDoc {
  const service = str(raw.resource, "service.name") ?? fallbackService;
  const doc: SpanDoc = {
    traceId: raw.traceId,
    spanId: raw.spanId,
    name: raw.name,
    kind: raw.kind,
    service,
    startTime: raw.startTime,
    endTime: raw.endTime,
    durationMs: Math.max(0, raw.endTime.getTime() - raw.startTime.getTime()),
    status: raw.status,
    attributes: raw.attributes,
    resource: raw.resource,
    ingestedAt: new Date(),
  };
  if (raw.parentSpanId !== undefined) doc.parentSpanId = raw.parentSpanId;
  if (raw.statusMessage !== undefined) doc.statusMessage = raw.statusMessage;

  const genAi = extractGenAi(raw.attributes);
  if (genAi !== undefined) doc.genAi = genAi;

  const prompt = extractPromptRef(raw.attributes);
  if (prompt !== undefined) doc.prompt = prompt;

  const input = extractInput(raw.attributes);
  if (input !== undefined) doc.input = input;

  const output = extractOutput(raw.attributes);
  if (output !== undefined) doc.output = output;

  return doc;
}
