import OpenAI from "openai";
import { edgesCol, promptsCol, promptVersionsCol } from "./db";
import { embed, embedMany } from "./embeddings";
import type { EdgeEndpoint, PromptDoc, PromptFragment } from "./types";

export const DESCRIPTION_MODEL = process.env.OPENAI_REASONING_MODEL ?? "gpt-5.1";

export interface UsesEdge extends EdgeEndpoint {
  note?: string;
}

export interface DefinePromptArgs {
  name: string;
  fragments: Record<string, string>;
  template: string;
  description?: string;
  uses?: UsesEdge[];
  updatedBy?: string;
}

let openai: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    openai = new OpenAI();
  }
  return openai;
}

async function generateDescription(
  name: string,
  template: string,
  fragments: PromptFragment[],
): Promise<string> {
  const body = fragments
    .filter((f) => f.text.length > 0)
    .map((f) => `[${f.key}]\n${f.text}`)
    .join("\n\n");
  const response = await getOpenAI().chat.completions.create({
    model: DESCRIPTION_MODEL,
    messages: [
      {
        role: "user",
        content: `Prompt "${name}".\n\nTemplate:\n${template}\n\nFragments:\n${body}\n\nWrite a one-line purpose description of this prompt: what it is for, under 25 words. Return only that line.`,
      },
    ],
  });
  const content = response.choices[0]?.message.content;
  if (!content) {
    throw new Error(`${DESCRIPTION_MODEL} returned no description for "${name}"`);
  }
  return content.trim();
}

function fragmentsChanged(a: PromptFragment[], b: PromptFragment[]): boolean {
  const strip = (fs: PromptFragment[]) => fs.map((f) => ({ key: f.key, text: f.text }));
  return JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
}

async function embedFragments(fragments: PromptFragment[]): Promise<PromptFragment[]> {
  const nonEmpty = fragments.filter((f) => f.text.length > 0);
  const vectors = await embedMany(nonEmpty.map((f) => f.text));
  const byKey = new Map(
    nonEmpty.map((f, i) => {
      const vector = vectors[i];
      if (!vector) throw new Error(`Voyage returned no embedding for fragment "${f.key}"`);
      return [f.key, vector] as const;
    }),
  );
  return fragments.map((f) => {
    const embedding = byKey.get(f.key);
    return embedding ? { ...f, embedding } : f;
  });
}

export async function definePrompt(args: DefinePromptArgs): Promise<PromptDoc> {
  const { name, template, uses = [], updatedBy = "sdk" } = args;
  const fragments: PromptFragment[] = Object.entries(args.fragments).map(([key, text]) => ({
    key,
    text,
  }));

  const existing = await promptsCol().findOne({ name });
  const changed =
    !existing || existing.template !== template || fragmentsChanged(existing.fragments, fragments);

  let doc: PromptDoc;
  if (!changed) {
    doc = existing;
  } else {
    const description = args.description ?? (await generateDescription(name, template, fragments));
    doc = {
      name,
      version: existing ? existing.version + 1 : 1,
      description,
      descriptionEmbedding: await embed(description),
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
    await edgesCol().insertMany(
      uses.map(({ note, ...to }) => ({
        from: { prompt: name },
        to,
        kind: "uses" as const,
        ...(note ? { note } : {}),
      })),
    );
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
