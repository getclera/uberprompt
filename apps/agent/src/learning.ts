import type { ObjectId } from "mongodb";
import {
  embed,
  lessonsCol,
  promptsCol,
  proposalsCol,
  tracesCol,
  type LessonDoc,
  type TraceDoc,
} from "@uberprompt/sdk";
import { analyzeTraceBatch, applyLessonToPrompt } from "./claude";

const FLUSH_MS = 20_000;
const FLUSH_AT = 10;
const POLL_MS = 3_000;
const DEDUPE_MIN_SCORE = 0.92;

const buffer: TraceDoc[] = [];
let flushing = false;

export async function startLearningLoop(): Promise<void> {
  setInterval(() => {
    flush().catch((err) => console.error("[learning] ERROR in flush:", err));
  }, FLUSH_MS);

  try {
    const stream = tracesCol().watch([{ $match: { operationType: "insert" } }]);
    console.log("[learning] watching traces via change stream");
    for await (const change of stream) {
      if ("fullDocument" in change && change.fullDocument) bufferTrace(change.fullDocument);
    }
  } catch (err) {
    console.error("[learning] change stream unavailable, falling back to 3s polling:", err);
    await pollTraces();
  }
}

async function pollTraces(): Promise<void> {
  let lastSeen = new Date();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const fresh = await tracesCol().find({ ts: { $gt: lastSeen } }).toArray();
      lastSeen = new Date();
      for (const trace of fresh) bufferTrace(trace);
    } catch (err) {
      console.error("[learning] ERROR polling traces:", err);
    }
  }
}

function bufferTrace(trace: TraceDoc): void {
  buffer.push(trace);
  console.log(`[learning] buffered trace for "${trace.promptName}" (${buffer.length} pending)`);
  if (buffer.length >= FLUSH_AT) {
    flush().catch((err) => console.error("[learning] ERROR in flush:", err));
  }
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, buffer.length);
  console.log(`[learning] analyzing batch of ${batch.length} trace(s)`);
  try {
    await analyzeBatch(batch);
  } finally {
    flushing = false;
  }
}

async function analyzeBatch(batch: TraceDoc[]): Promise<void> {
  const knownPrompts = await promptsCol().distinct("name");
  const summaries = batch.map((t) => ({
    promptName: t.promptName,
    promptVersion: t.promptVersion,
    ...(t.score !== undefined ? { score: t.score } : {}),
    ...(t.error !== undefined ? { error: t.error } : {}),
    input: JSON.stringify(t.input).slice(0, 400),
    output: t.output.slice(0, 400),
  }));
  const lessons = await analyzeTraceBatch(summaries, knownPrompts);
  if (lessons.length === 0) {
    console.log("[learning] no durable lessons in this batch");
    return;
  }
  const sourceTraceIds = batch.map((t) => t._id).filter((id): id is ObjectId => id !== undefined);
  for (const candidate of lessons) {
    await recordLesson(candidate.text, candidate.appliesTo, sourceTraceIds).catch((err) =>
      console.error("[learning] ERROR recording lesson:", err),
    );
  }
}

async function recordLesson(text: string, appliesTo: string[], sourceTraceIds: ObjectId[]): Promise<void> {
  console.log(`[learning] lesson candidate: "${text}" (applies to ${appliesTo.join(", ")})`);
  const embedding = await embed(text);
  const similar = await findSimilarActiveLesson(embedding);
  if (similar) {
    console.log(`[learning] very similar active lesson exists ("${similar.text.slice(0, 80)}..."), skipping`);
    return;
  }
  const lesson: LessonDoc = { text, embedding, sourceTraceIds, appliesTo, status: "active", ts: new Date() };
  const inserted = await lessonsCol().insertOne(lesson);
  console.log(`[learning] LESSON stored (${inserted.insertedId}): ${text}`);

  for (const promptName of appliesTo) {
    await proposeLessonFix(inserted.insertedId, text, promptName).catch((err) =>
      console.error(`[learning] ERROR proposing fix for "${promptName}":`, err),
    );
  }
}

async function findSimilarActiveLesson(embedding: number[]): Promise<LessonDoc | null> {
  try {
    const results = await lessonsCol()
      .aggregate<LessonDoc & { score: number }>([
        {
          $vectorSearch: {
            index: "lessons_embedding",
            path: "embedding",
            queryVector: embedding,
            numCandidates: 50,
            limit: 3,
          },
        },
        { $addFields: { score: { $meta: "vectorSearchScore" } } },
      ])
      .toArray();
    return results.find((r) => r.status === "active" && r.score > DEDUPE_MIN_SCORE) ?? null;
  } catch (err) {
    console.error("[learning] ERROR in lesson $vectorSearch (Atlas index missing?), skipping dedupe:", err);
    return null;
  }
}

async function proposeLessonFix(lessonId: ObjectId, lesson: string, promptName: string): Promise<void> {
  const prompt = await promptsCol().findOne({ name: promptName });
  if (!prompt) {
    console.error(`[learning] prompt "${promptName}" not found, skipping proposal`);
    return;
  }
  const fix = await applyLessonToPrompt({
    lesson,
    prompt: { name: prompt.name, fragments: prompt.fragments.map((f) => ({ key: f.key, text: f.text })) },
  });
  if (!fix.fragment) {
    console.log(`[learning] lesson does not change "${promptName}" (${fix.reason})`);
    return;
  }
  const target = prompt.fragments.find((f) => f.key === fix.fragment);
  if (!target) {
    console.error(`[learning] Claude picked unknown fragment "${fix.fragment}" in "${promptName}"`);
    return;
  }
  if (target.text === fix.newText) {
    console.log(`[learning] proposed text for "${promptName}.${fix.fragment}" is unchanged, skipping`);
    return;
  }
  const duplicate = await proposalsCol().findOne({
    "target.prompt": promptName,
    "target.fragment": fix.fragment,
    newText: fix.newText,
    status: "pending",
  });
  if (duplicate) {
    console.log(`[learning] identical pending proposal exists for "${promptName}.${fix.fragment}", skipping`);
    return;
  }
  await proposalsCol().insertOne({
    target: { prompt: promptName, fragment: fix.fragment },
    oldText: target.text,
    newText: fix.newText,
    reason: fix.reason,
    source: { type: "lesson", ref: lessonId },
    status: "pending",
    ts: new Date(),
  });
  console.log(`[learning] PROPOSAL filed for "${promptName}.${fix.fragment}": ${fix.reason}`);
}
