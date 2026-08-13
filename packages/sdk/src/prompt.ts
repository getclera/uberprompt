import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createHash } from "node:crypto";
import type { ObjectId } from "mongodb";
import { edgesCol, promptsCol, promptVersionsCol, proposalsCol } from "./db";
import { embed, embedMany } from "./embeddings";
import { withTransaction } from "./queries";
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

async function generateDescription(
  name: string,
  template: string,
  fragments: PromptFragment[],
): Promise<string> {
  const body = fragments
    .filter((f) => f.text.length > 0)
    .map((f) => `[${f.key}]\n${f.text}`)
    .join("\n\n");
  const { text } = await generateText({
    model: openai(DESCRIPTION_MODEL),
    prompt: `Prompt "${name}".\n\nTemplate:\n${template}\n\nFragments:\n${body}\n\nWrite a one-line purpose description of this prompt: what it is for, under 25 words. Return only that line.`,
    telemetry: { functionId: "sdk-generate-description" },
  });
  if (text.trim().length === 0) {
    throw new Error(`${DESCRIPTION_MODEL} returned no description for "${name}"`);
  }
  return text.trim();
}

function fragmentsChanged(a: PromptFragment[], b: PromptFragment[]): boolean {
  const strip = (fs: PromptFragment[]) => fs.map((f) => ({ key: f.key, text: f.text }));
  return JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
}

// Version identity. Fragments are sorted by key so that the hash depends on prompt
// content only, not on the iteration order the caller happened to build them in.
export function computePromptContentHash(template: string, fragments: PromptFragment[]): string {
  const canonical = JSON.stringify({
    template,
    fragments: fragments
      .map((f) => ({ key: f.key, text: f.text }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  });
  return createHash("sha256").update(canonical).digest("hex");
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
  const contentHash = computePromptContentHash(template, fragments);
  const changed =
    !existing ||
    (existing.contentHash !== undefined
      ? existing.contentHash !== contentHash
      : existing.template !== template || fragmentsChanged(existing.fragments, fragments));

  let doc: PromptDoc;
  if (!changed) {
    doc = existing;
    if (existing.contentHash === undefined) {
      await promptsCol().updateOne({ name }, { $set: { contentHash } });
      await promptVersionsCol().updateOne(
        { promptName: name, version: existing.version },
        { $set: { contentHash } },
      );
      doc = { ...existing, contentHash };
    }
  } else {
    const description = args.description ?? (await generateDescription(name, template, fragments));
    doc = {
      name,
      version: existing ? existing.version + 1 : 1,
      description,
      descriptionEmbedding: await embed(description),
      fragments: await embedFragments(fragments),
      template,
      contentHash,
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

export function nextVersionOf(
  doc: PromptDoc,
  key: string,
  text: string,
  embedding: number[],
): PromptDoc {
  if (!doc.fragments.some((f) => f.key === key)) {
    throw new Error(`Prompt "${doc.name}" has no fragment "${key}"`);
  }
  const fragments = doc.fragments.map((f) => (f.key === key ? { ...f, text, embedding } : f));
  return {
    ...doc,
    version: doc.version + 1,
    fragments,
    contentHash: computePromptContentHash(doc.template, fragments),
    updatedAt: new Date(),
    updatedBy: "approval",
  };
}

export interface ApprovalResult {
  prompt: string;
  version: number;
  fragment: string;
  contentHash: string;
}

export async function approveProposal(proposalId: ObjectId): Promise<ApprovalResult> {
  const proposal = await proposalsCol().findOne({ _id: proposalId });
  if (!proposal) throw new Error(`Proposal not found: ${proposalId.toHexString()}`);
  if (proposal.status !== "pending") {
    throw new Error(
      `Proposal ${proposalId.toHexString()} is "${proposal.status}" — only pending proposals can be approved`,
    );
  }
  const key = proposal.target.fragment;
  if (!key) throw new Error(`Proposal ${proposalId.toHexString()} names no target fragment`);

  const current = await loadPrompt(proposal.target.prompt);
  const fragment = current.fragments.find((f) => f.key === key);
  if (!fragment) throw new Error(`Prompt "${current.name}" has no fragment "${key}"`);
  if (fragment.text !== proposal.oldText) {
    throw new Error(
      `Fragment "${key}" of "${current.name}" changed since this proposal was filed — re-run the lesson against v${current.version}`,
    );
  }

  const embedding = await embed(proposal.newText);
  const { _id, ...next } = nextVersionOf(current, key, proposal.newText, embedding);
  await withTransaction(async (session) => {
    const written = await promptsCol().updateOne(
      { name: next.name, version: current.version },
      { $set: { ...next } },
      { session },
    );
    if (written.matchedCount !== 1) {
      throw new Error(
        `Prompt "${next.name}" moved past v${current.version} while this approval was running — nothing was applied`,
      );
    }
    await promptVersionsCol().insertOne(
      { ...next, promptName: next.name, frozenAt: new Date() },
      { session },
    );
    await proposalsCol().updateOne(
      { _id: proposalId },
      { $set: { status: "applied" } },
      { session },
    );
  });
  return {
    prompt: next.name,
    version: next.version,
    fragment: key,
    contentHash: next.contentHash ?? "",
  };
}
