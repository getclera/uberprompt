import {
  loadEnv,
  requireEnv,
  connect,
  openaiClient,
  structuredCall,
  voyageEmbed,
  truncate,
} from "./store.mjs";

const DEFAULT_MODEL = "gpt-5.1";
const DEFAULT_LIMIT = 100;
const DEFAULT_DEDUP_THRESHOLD = 0.92;
const SNIPPET_MAX = 400;

const LESSONS_TOOL = {
  name: "report_lessons",
  description:
    "Report durable, generalizable lessons mined from production LLM traces of one prompt. Report an empty list when the traces show nothing recurring worth remembering.",
  parameters: {
    type: "object",
    properties: {
      lessons: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            reason: { type: "string" },
          },
          required: ["text", "reason"],
        },
      },
    },
    required: ["lessons"],
  },
};

export async function selectTraces(db, limit) {
  const signal = await db
    .collection("traces")
    .find({
      promptName: { $exists: true },
      $or: [{ error: { $exists: true } }, { score: { $lt: 0.5 } }],
    })
    .sort({ ts: -1 })
    .limit(limit)
    .toArray();
  const remaining = limit - signal.length;
  if (remaining <= 0) return signal;
  const rest = await db
    .collection("traces")
    .find({
      promptName: { $exists: true },
      _id: { $nin: signal.map((t) => t._id) },
    })
    .sort({ ts: -1 })
    .limit(remaining)
    .toArray();
  return [...signal, ...rest];
}

export function groupByPrompt(traces) {
  const groups = new Map();
  for (const trace of traces) {
    if (!groups.has(trace.promptName)) groups.set(trace.promptName, []);
    groups.get(trace.promptName).push(trace);
  }
  return groups;
}

function traceListing(traces) {
  return traces
    .map((t) => {
      const lines = [`- trace ${t.traceId || t._id} (prompt v${t.promptVersion ?? "?"})`];
      if (t.error) lines.push(`  error: ${truncate(t.error, SNIPPET_MAX)}`);
      if (typeof t.score === "number") lines.push(`  score: ${t.score}`);
      lines.push(`  input: ${truncate(JSON.stringify(t.input), SNIPPET_MAX)}`);
      lines.push(`  output: ${truncate(t.output, SNIPPET_MAX)}`);
      return lines.join("\n");
    })
    .join("\n");
}

export function miningPrompt(promptName, traces) {
  return (
    `Production traces of the LLM prompt "${promptName}" are listed below. ` +
    "Mine durable, generalizable lessons about what is going wrong or recurring — " +
    "rules worth folding into the prompt permanently (like \"never promise a refund " +
    "amount before checking the account\"). Never report one-off incident summaries, " +
    "transient infrastructure noise, or restatements of a single trace. " +
    "A healthy group yields ZERO lessons — return an empty list rather than inventing one.\n\n" +
    `Traces:\n${traceListing(traces)}`
  );
}

export async function findDuplicate(db, embedding, threshold) {
  const hits = await db
    .collection("lessons")
    .aggregate([
      {
        $vectorSearch: {
          index: "lessons_embedding",
          path: "embedding",
          queryVector: embedding,
          numCandidates: 100,
          limit: 5,
        },
      },
      { $project: { text: 1, status: 1, score: { $meta: "vectorSearchScore" } } },
    ])
    .toArray();
  const top = hits.find((h) => h.status === "active");
  return top && top.score >= threshold ? top : null;
}

export async function learnPipeline({ db, structured, embed, limit, threshold, dryRun }) {
  const traces = await selectTraces(db, limit);
  const groups = groupByPrompt(traces);
  if (traces.length === 0) console.log("No traces with a prompt binding.");
  let mined = 0;
  let inserted = 0;
  let merged = 0;

  for (const [promptName, group] of groups) {
    console.log(`\n${promptName}: ${group.length} trace(s)`);
    const out = await structured(miningPrompt(promptName, group), LESSONS_TOOL);
    const lessons = (out.lessons || []).filter((l) => l.text);
    if (lessons.length === 0) {
      console.log("  healthy — no lessons");
      continue;
    }
    const traceIds = group.map((t) => t._id);
    for (const lesson of lessons) {
      mined += 1;
      console.log(`  lesson: ${truncate(lesson.text, 110)}`);
      const embedding = await embed(lesson.text);
      const duplicate = await findDuplicate(db, embedding, threshold);
      if (duplicate) {
        merged += 1;
        console.log(
          `    duplicate of ${duplicate._id} (score ${duplicate.score.toFixed(3)}): ${truncate(duplicate.text, 80)} — ${dryRun ? "would merge" : "merged"} trace ids`
        );
        if (!dryRun) {
          await db.collection("lessons").updateOne(
            { _id: duplicate._id },
            {
              $addToSet: {
                sourceTraceIds: { $each: traceIds },
                appliesTo: promptName,
              },
            }
          );
        }
        continue;
      }
      inserted += 1;
      if (dryRun) {
        console.log("    would insert as new lesson");
        continue;
      }
      const { insertedId } = await db.collection("lessons").insertOne({
        text: lesson.text,
        reason: lesson.reason,
        embedding,
        sourceTraceIds: traceIds,
        appliesTo: [promptName],
        status: "active",
        ts: new Date(),
      });
      console.log(`    inserted ${insertedId}`);
    }
  }

  console.log(
    `\n${dryRun ? "dry-run: " : ""}${traces.length} trace(s) read, ${mined} lesson(s) mined, ${inserted}${dryRun ? " would be" : ""} inserted, ${merged} merged into duplicates`
  );
  return { traces: traces.length, mined, inserted, merged };
}

export async function runLearn(repoRoot, opts) {
  const env = loadEnv(repoRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB", "OPENAI_API_KEY", "VOYAGE_API_KEY"]);
  const model = opts.model || DEFAULT_MODEL;
  const limit = opts.limit == null ? DEFAULT_LIMIT : Number(opts.limit);
  const threshold =
    opts["dedup-threshold"] == null
      ? DEFAULT_DEDUP_THRESHOLD
      : Number(opts["dedup-threshold"]);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer, got "${opts.limit}"`);
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(`--dedup-threshold must be in (0, 1], got "${opts["dedup-threshold"]}"`);
  }
  const { client, db } = await connect(env);
  try {
    const ai = await openaiClient(env);
    await learnPipeline({
      db,
      structured: (prompt, tool) => structuredCall(ai, model, prompt, tool),
      embed: (text) => voyageEmbed(env, text),
      limit,
      threshold,
      dryRun: Boolean(opts["dry-run"]),
    });
    return 0;
  } finally {
    await client.close();
  }
}
