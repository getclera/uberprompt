import { AsyncLocalStorage } from "node:async_hooks";
import type { Attributes } from "@opentelemetry/api";
import type { PromptRef } from "@uberprompt/sdk";
import { promptVersionsCol, promptsCol } from "@uberprompt/sdk";
import { UBERPROMPT } from "./attributes";

const storage = new AsyncLocalStorage<PromptRef>();

// Short TTL rather than an unbounded cache: stage 3 bumps prompt versions while apps are
// running, and a cached ref would keep stamping the superseded version onto new traces —
// silently attributing post-change traces to the pre-change version, which is exactly the
// comparison the pipeline exists to make.
const CACHE_TTL_MS = Number(process.env.UBERPROMPT_PROMPT_CACHE_MS ?? 10_000);
const cache = new Map<string, { ref: PromptRef; expiresAt: number }>();

export async function resolvePromptRef(name: string): Promise<PromptRef> {
  const cached = cache.get(name);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.ref;

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
  cache.set(name, { ref, expiresAt: Date.now() + CACHE_TTL_MS });
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

export function promptAttributes(): Attributes | undefined {
  const ref = currentPromptRef();
  if (ref === undefined) return undefined;
  return {
    [UBERPROMPT.name]: ref.name,
    [UBERPROMPT.version]: ref.version,
    [UBERPROMPT.versionId]: ref.versionId.toHexString(),
    [UBERPROMPT.contentHash]: ref.contentHash,
  };
}

