import { edgesCol, promptsCol, promptVersionsCol } from "./db";
import { embedMany } from "./embeddings";
import type { EdgeEndpoint, PromptDoc, PromptFragment } from "./types";

export interface DefinePromptArgs {
  name: string;
  fragments: Record<string, string>;
  template: string;
  uses?: EdgeEndpoint[];
  updatedBy?: string;
}

function fragmentsChanged(a: PromptFragment[], b: PromptFragment[]): boolean {
  const strip = (fs: PromptFragment[]) => fs.map((f) => ({ key: f.key, text: f.text }));
  return JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
}

async function embedFragments(fragments: PromptFragment[]): Promise<PromptFragment[]> {
  try {
    const vectors = await embedMany(fragments.map((f) => f.text));
    return fragments.map((f, i) => ({ ...f, embedding: vectors[i] }));
  } catch {
    return fragments; // best-effort: embeddings are optional in the contract
  }
}

// Registers/upserts a prompt + its declared "uses" edges. Bumps version only on text change.
export async function definePrompt(args: DefinePromptArgs): Promise<PromptDoc> {
  const { name, template, uses = [], updatedBy = "sdk" } = args;
  const fragments: PromptFragment[] = Object.entries(args.fragments).map(([key, text]) => ({ key, text }));

  const existing = await promptsCol().findOne({ name });
  const changed = !existing || existing.template !== template || fragmentsChanged(existing.fragments, fragments);

  let doc: PromptDoc;
  if (!changed) {
    doc = existing;
  } else {
    doc = {
      name,
      version: existing ? existing.version + 1 : 1,
      fragments: await embedFragments(fragments),
      template,
      updatedAt: new Date(),
      updatedBy,
    };
    await promptsCol().updateOne({ name }, { $set: { ...doc } }, { upsert: true });
    const { _id: _drop, ...snapshot } = doc;
    await promptVersionsCol().insertOne({ ...snapshot, promptName: name, frozenAt: new Date() });
  }

  await edgesCol().deleteMany({ "from.prompt": name, kind: "uses" });
  if (uses.length > 0) {
    await edgesCol().insertMany(uses.map((to) => ({ from: { prompt: name }, to, kind: "uses" as const })));
  }
  return doc;
}

export function renderPromptDoc(doc: PromptDoc): string {
  const byKey = new Map(doc.fragments.map((f) => [f.key, f.text]));
  return doc.template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => byKey.get(key) ?? match);
}

export async function loadPrompt(name: string): Promise<PromptDoc> {
  const doc = await promptsCol().findOne({ name });
  if (!doc) throw new Error(`Prompt not found: ${name}`);
  return doc;
}

export async function renderPrompt(name: string): Promise<string> {
  return renderPromptDoc(await loadPrompt(name));
}
