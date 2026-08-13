// Load the demo prompt-set (fragments/, prompts/, edges.json) into one model.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Edge, Fragment, Model, PromptDoc, Ref } from "./types.ts";

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
}

// Node-id helpers. Shared fragment  -> "<key>".
//                  Prompt           -> "<name>".
//                  Prompt-local frag -> "<name>.<key>".
export function refNodeId(ref: Ref): string {
  if (ref.prompt && ref.fragment) return `${ref.prompt}.${ref.fragment}`;
  if (ref.prompt) return ref.prompt;
  if (ref.fragment) return ref.fragment;
  throw new Error("edge ref has neither prompt nor fragment");
}

export function loadModel(dir: string): Model {
  const fragmentsDir = join(dir, "fragments");
  const promptsDir = join(dir, "prompts");
  const edgesPath = join(dir, "edges.json");

  const fragments = new Map<string, Fragment>(); // key -> { key, version, text }
  for (const p of listJson(fragmentsDir)) {
    const doc = readJson<Fragment>(p);
    fragments.set(doc.key, doc);
  }

  const prompts = new Map<string, PromptDoc>(); // name -> prompt doc
  for (const p of listJson(promptsDir)) {
    const doc = readJson<PromptDoc>(p);
    prompts.set(doc.name, doc);
  }

  const edges: Edge[] = existsSync(edgesPath) ? readJson<Edge[]>(edgesPath) : [];

  return { dir, fragmentsDir, promptsDir, edgesPath, fragments, prompts, edges };
}

interface FlatFragment {
  id: string;
  kind: "shared" | "local";
  prompt?: string;
  key: string;
  text: string;
}

// Every non-empty fragment (shared + prompt-local). Empty text = runtime input slot.
export function nonEmptyFragments(model: Model): FlatFragment[] {
  const out: FlatFragment[] = [];
  for (const frag of model.fragments.values()) {
    if (frag.text && frag.text.trim() !== "") {
      out.push({ id: frag.key, kind: "shared", key: frag.key, text: frag.text });
    }
  }
  for (const prompt of model.prompts.values()) {
    for (const frag of prompt.fragments || []) {
      if (frag.text && frag.text.trim() !== "") {
        out.push({
          id: `${prompt.name}.${frag.key}`,
          kind: "local",
          prompt: prompt.name,
          key: frag.key,
          text: frag.text,
        });
      }
    }
  }
  return out;
}
