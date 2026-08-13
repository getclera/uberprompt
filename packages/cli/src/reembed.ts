import type { Db, WithId } from "mongodb";
import {
  loadEnv,
  requireEnv,
  connect,
  voyageEmbedBatch,
  cosine,
  VOYAGE_EMBED_MODEL,
} from "./store.ts";
import type { CliEnv, LessonDoc, PromptDoc } from "./types.ts";

interface VerifyPair {
  a: string;
  b: string;
  min?: number;
  max?: number;
}

const VERIFY_PAIRS: VerifyPair[] = [
  { a: "triage-router.routing-rules", b: "escalation-writer.escalation-criteria", min: 0.8 },
  { a: "escalation-writer.context", b: "refund-agent.refund-policy", min: 0.8 },
  { a: "satisfaction-summarizer.task", b: "order-agent.task", max: 0.8 },
];

function fragmentVector(prompts: PromptDoc[], id: string): number[] | undefined {
  const dot = id.indexOf(".");
  const doc = prompts.find((p) => p.name === id.slice(0, dot));
  const frag = doc?.fragments.find((f) => f.key === id.slice(dot + 1));
  return frag?.embedding;
}

function verifySpace(prompts: PromptDoc[]): void {
  console.log("\nembedding-space verification:");
  let failures = 0;
  for (const pair of VERIFY_PAIRS) {
    const va = fragmentVector(prompts, pair.a);
    const vb = fragmentVector(prompts, pair.b);
    if (!va || !vb) {
      console.log(`  ${pair.a} vs ${pair.b}: fragment or embedding missing — skipped`);
      continue;
    }
    const score = cosine(va, vb);
    const ok = pair.min !== undefined ? score >= pair.min : score < pair.max!;
    const bound = pair.min !== undefined ? `expected >= ${pair.min}` : `expected < ${pair.max}`;
    console.log(`  ${pair.a} vs ${pair.b}: ${score.toFixed(3)} (${bound}) ${ok ? "OK" : "FAIL"}`);
    if (!ok) failures++;
  }
  if (failures > 0) {
    throw new Error(`${failures} embedding-space check(s) failed — the space is still split or the model drifted`);
  }
}

async function reembedPrompt(
  db: Db,
  env: CliEnv,
  doc: WithId<PromptDoc>,
  dryRun: boolean
): Promise<{ fragments: number; descriptions: number }> {
  const fragIdx: number[] = [];
  const texts: string[] = [];
  doc.fragments.forEach((f, i) => {
    if (Array.isArray(f.embedding) && f.text) {
      fragIdx.push(i);
      texts.push(f.text);
    }
  });
  const hasDesc = Array.isArray(doc.descriptionEmbedding) && Boolean(doc.description);
  if (hasDesc) texts.push(doc.description!);
  const label = `${doc.name} v${doc.version}: ${fragIdx.length} fragment(s)${hasDesc ? " + description" : ""}`;
  if (texts.length === 0) {
    console.log(`  ${doc.name} v${doc.version}: no existing embeddings — skipped`);
    return { fragments: 0, descriptions: 0 };
  }
  if (dryRun) {
    console.log(`  would re-embed ${label}`);
    return { fragments: fragIdx.length, descriptions: hasDesc ? 1 : 0 };
  }
  const vectors = await voyageEmbedBatch(env, texts);
  const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy: "cli" };
  fragIdx.forEach((idx, j) => {
    set[`fragments.${idx}.embedding`] = vectors[j];
  });
  if (hasDesc) set.descriptionEmbedding = vectors[vectors.length - 1];
  const res = await db.collection<PromptDoc>("prompts").updateOne({ _id: doc._id, version: doc.version }, { $set: set });
  if (res.matchedCount !== 1) {
    throw new Error(`prompt "${doc.name}" changed concurrently — reembed aborted`);
  }
  fragIdx.forEach((idx, j) => {
    doc.fragments[idx]!.embedding = vectors[j]!;
  });
  console.log(`  re-embedded ${label}`);
  return { fragments: fragIdx.length, descriptions: hasDesc ? 1 : 0 };
}

export async function runReembed(
  repoRoot: string,
  opts: { "dry-run"?: boolean } = {}
): Promise<number> {
  const env = loadEnv(repoRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB", "VOYAGE_API_KEY"]);
  const dryRun = Boolean(opts["dry-run"]);
  const { client, db } = await connect(env);
  try {
    const prompts = await db.collection<PromptDoc>("prompts").find({}).toArray();
    const lessons = await db.collection<LessonDoc>("lessons").find({}).toArray();
    console.log(
      `re-embedding all vectors via ${VOYAGE_EMBED_MODEL} (${prompts.length} prompts, ${lessons.length} lessons)${dryRun ? " — dry run" : ""}:`
    );
    let fragments = 0;
    let descriptions = 0;
    for (const doc of prompts) {
      const n = await reembedPrompt(db, env, doc, dryRun);
      fragments += n.fragments;
      descriptions += n.descriptions;
    }
    let lessonCount = 0;
    for (const lesson of lessons) {
      if (!Array.isArray(lesson.embedding) || !lesson.text) {
        console.log(`  lesson ${lesson._id}: no embedding or text — skipped`);
        continue;
      }
      lessonCount++;
      if (dryRun) {
        console.log(`  would re-embed lesson ${lesson._id}`);
        continue;
      }
      const [vector] = await voyageEmbedBatch(env, [lesson.text]);
      await db.collection<LessonDoc>("lessons").updateOne({ _id: lesson._id }, { $set: { embedding: vector } });
      console.log(`  re-embedded lesson ${lesson._id}`);
    }
    console.log(
      `${dryRun ? "dry-run: would re-embed" : "re-embedded"} ${fragments} fragment(s), ${descriptions} description(s), ${lessonCount} lesson(s)`
    );
    if (!dryRun) verifySpace(prompts);
    return 0;
  } finally {
    await client.close();
  }
}
