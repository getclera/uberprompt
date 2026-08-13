// Load the demo prompt-set (fragments/, prompts/, edges.json) into one model.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
}

// Node-id helpers. Shared fragment  -> "<key>".
//                  Prompt           -> "<name>".
//                  Prompt-local frag -> "<name>.<key>".
export function refNodeId(ref) {
  if (ref.prompt && ref.fragment) return `${ref.prompt}.${ref.fragment}`;
  if (ref.prompt) return ref.prompt;
  return ref.fragment;
}

export function loadModel(dir) {
  const fragmentsDir = join(dir, "fragments");
  const promptsDir = join(dir, "prompts");
  const edgesPath = join(dir, "edges.json");

  const fragments = new Map(); // key -> { key, version, text }
  for (const p of listJson(fragmentsDir)) {
    const doc = readJson(p);
    fragments.set(doc.key, doc);
  }

  const prompts = new Map(); // name -> prompt doc
  for (const p of listJson(promptsDir)) {
    const doc = readJson(p);
    prompts.set(doc.name, doc);
  }

  const edges = existsSync(edgesPath) ? readJson(edgesPath) : [];

  return { dir, fragmentsDir, promptsDir, edgesPath, fragments, prompts, edges };
}

// Every non-empty fragment (shared + prompt-local). Empty text = runtime input slot.
export function nonEmptyFragments(model) {
  const out = [];
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
