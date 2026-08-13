import { AsyncLocalStorage } from "node:async_hooks";
import type { Attributes } from "@opentelemetry/api";
import type { PromptRef } from "@uberprompt/sdk";
import { promptVersionsCol, promptsCol } from "@uberprompt/sdk";
import { UBERPROMPT } from "./attributes";

const storage = new AsyncLocalStorage<PromptRef>();
const cache = new Map<string, PromptRef>();

export async function resolvePromptRef(name: string): Promise<PromptRef> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const prompt = await promptsCol().findOne({ name });
  if (prompt === null) {
    throw new Error(`Prompt not registered: ${name} — run the prompt seed before tracing against it`);
  }

  const version = await promptVersionsCol().findOne({ promptName: name, version: prompt.version });
  if (version === null || version._id === undefined) {
    throw new Error(
      `No prompt_versions snapshot for ${name}@${prompt.version} — stage 1 never writes prompt versions, so this must be seeded by stage 3`,
    );
  }

  const ref: PromptRef = {
    name,
    version: prompt.version,
    versionId: version._id,
    contentHash: version.contentHash ?? "",
  };
  cache.set(name, ref);
  return ref;
}

export function clearPromptRefCache(): void {
  cache.clear();
}

export async function withPrompt<T>(nameOrRef: string | PromptRef, fn: () => Promise<T>): Promise<T> {
  const ref = typeof nameOrRef === "string" ? await resolvePromptRef(nameOrRef) : nameOrRef;
  return storage.run(ref, fn);
}

export function currentPromptRef(): PromptRef | undefined {
  return storage.getStore();
}

export function promptAttributes(runtimeContext?: Record<string, unknown>): Attributes | undefined {
  const fromContext = runtimeContext?.uberpromptPrompt;
  const ref = isPromptRef(fromContext) ? fromContext : currentPromptRef();
  if (ref === undefined) return undefined;
  return {
    [UBERPROMPT.name]: ref.name,
    [UBERPROMPT.version]: ref.version,
    [UBERPROMPT.versionId]: ref.versionId.toHexString(),
    [UBERPROMPT.contentHash]: ref.contentHash,
  };
}

function isPromptRef(value: unknown): value is PromptRef {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string" && typeof candidate.version === "number";
}
