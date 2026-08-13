import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MODEL = "gpt-5.1";
const VOYAGE_URL = "https://ai.mongodb.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-3.5-lite";
const VOYAGE_DIMS = 1024;
const DEDUPE_MIN_SCORE = 0.92;
const DEFAULT_LIMIT = 50;

function loadEnv(repoRoot) {
  const env = { ...process.env };
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return env;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (v && !env[m[1]]) env[m[1]] = v;
  }
  return env;
}

function requireEnv(env, name, why) {
  if (env[name]) return env[name];
  console.error(
    `error: ${name} is not set.\n` +
      `  Set it in your environment or in the repo-root .env.\n` +
      `  \`uberprompt learn\` needs it ${why}.`
  );
  return null;
}

const LESSONS_SCHEMA = {
  type: "object",
  properties: {
    lessons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          reason: { type: "string" },
          appliesTo: { type: "array", items: { type: "string" } },
          sourceTraceIds: { type: "array", items: { type: "string" } },
        },
        required: ["text", "reason", "appliesTo", "sourceTraceIds"],
        additionalProperties: false,
      },
    },
  },
  required: ["lessons"],
  additionalProperties: false,
};

function summarize(traces) {
  return traces.map((t) => ({
    id: String(t._id),
    promptName: t.promptName,
    ...(t.promptVersion != null ? { promptVersion: t.promptVersion } : {}),
    ...(t.score !== undefined ? { score: t.score } : {}),
    ...(t.error !== undefined ? { error: t.error } : {}),
    input: JSON.stringify(t.input ?? null).slice(0, 400),
    output: String(t.output ?? "").slice(0, 400),
  }));
}

async function analyze(client, model, traces, knownPrompts) {
  const prompt = [
    "You analyze production LLM traces for a prompt-management system.",
    `Known prompt names: ${knownPrompts.join(", ")}`,
    "",
    "Traces (a trace is a failure if it has an error field, a score below 0.5,",
    "or visible failure signals in its output — e.g. a negative or frustrated user reply):",
    JSON.stringify(summarize(traces), null, 2),
    "",
    "Find recurring failure patterns or durable insights that should change how these prompts are written.",
    "Each lesson: text = one concrete, durable, actionable insight (not a restatement of a single trace);",
    "reason = one sentence citing the evidence in the traces;",
    "appliesTo = the known prompt names it applies to;",
    "sourceTraceIds = the ids of the traces that evidence it.",
    "Be conservative: at most 3 lessons; return an empty lessons array if nothing durable emerges.",
  ].join("\n");

  const resp = await client.chat.completions.create({
    model,
    response_format: {
      type: "json_schema",
      json_schema: { name: "report_lessons", strict: true, schema: LESSONS_SCHEMA },
    },
    messages: [{ role: "user", content: prompt }],
  });
  const msg = resp.choices[0]?.message;
  if (msg?.refusal) throw new Error(`model refused: ${msg.refusal}`);
  if (!msg?.content) throw new Error("model returned no content");
  return JSON.parse(msg.content).lessons;
}

async function embedText(apiKey, apiUrl, text) {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: [text],
      model: VOYAGE_MODEL,
      output_dimension: VOYAGE_DIMS,
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage embeddings failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()).data[0].embedding;
}

async function findSimilarActiveLesson(lessons, embedding) {
  const results = await lessons
    .aggregate([
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
  return (
    results.find((r) => r.status === "active" && r.score > DEDUPE_MIN_SCORE) ?? null
  );
}

function printCandidate(c) {
  console.log(`  - ${c.text}`);
  console.log(`      reason: ${c.reason}`);
  console.log(`      appliesTo: ${c.appliesTo.join(", ")}`);
  console.log(`      sourceTraces: ${c.sourceTraceIds.length}`);
}

export async function runLearn(repoRoot, opts) {
  const dryRun = Boolean(opts["dry-run"]);
  const limit = opts.limit != null ? opts.limit : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    console.error("error: --limit must be a positive integer.");
    return 1;
  }
  const model = opts.model || DEFAULT_MODEL;
  const env = loadEnv(repoRoot);
  const uri = requireEnv(env, "MONGODB_URI", "to read traces and write lessons");
  const openaiKey = requireEnv(env, "OPENAI_API_KEY", "to analyze traces");
  const voyageKey = dryRun
    ? env.VOYAGE_API_KEY
    : requireEnv(env, "VOYAGE_API_KEY", "to embed lessons for dedupe");
  if (!uri || !openaiKey || (!dryRun && !voyageKey)) return 1;

  const { MongoClient, ObjectId } = await import("mongodb");
  const { default: OpenAI } = await import("openai");
  const mongo = new MongoClient(uri);
  try {
    await mongo.connect();
    const db = mongo.db(env.MONGODB_DB || "uberprompt");
    const lessons = db.collection("lessons");
    const seen = await lessons.distinct("sourceTraceIds");
    const filter = { promptName: { $exists: true } };
    if (seen.length > 0) filter._id = { $nin: seen };
    const traces = await db
      .collection("traces")
      .find(filter)
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    if (traces.length === 0) {
      console.log("No unanalyzed traces with a prompt binding — nothing to learn.");
      return 0;
    }

    const knownPrompts = [...new Set(traces.map((t) => t.promptName))];
    console.log(
      `Analyzing ${traces.length} trace(s) across ${knownPrompts.length} prompt(s) with ${model}...`
    );
    const client = new OpenAI({ apiKey: openaiKey });
    const raw = await analyze(client, model, traces, knownPrompts);
    const traceIds = new Set(traces.map((t) => String(t._id)));
    const candidates = raw
      .map((c) => ({
        ...c,
        appliesTo: c.appliesTo.filter((p) => knownPrompts.includes(p)),
        sourceTraceIds: c.sourceTraceIds.filter((id) => traceIds.has(id)),
      }))
      .filter((c) => c.text && c.appliesTo.length > 0);

    if (candidates.length === 0) {
      console.log(`No durable lessons in this batch (${traces.length} traces analyzed).`);
      return 0;
    }
    if (dryRun) {
      console.log(`\nDRY RUN — ${candidates.length} candidate lesson(s), nothing written:\n`);
      for (const c of candidates) printCandidate(c);
      return 0;
    }

    const written = [];
    const deduped = [];
    for (const c of candidates) {
      const embedding = await embedText(voyageKey, env.VOYAGE_API_URL || VOYAGE_URL, c.text);
      const similar = await findSimilarActiveLesson(lessons, embedding);
      if (similar) {
        deduped.push({ candidate: c, existing: similar });
        continue;
      }
      await lessons.insertOne({
        text: c.text,
        reason: c.reason,
        embedding,
        sourceTraceIds: c.sourceTraceIds.map((id) => new ObjectId(id)),
        appliesTo: c.appliesTo,
        status: "active",
        ts: new Date(),
      });
      written.push(c);
    }

    console.log("\n=== learn summary ===");
    console.log(`  traces analyzed : ${traces.length}`);
    console.log(`  lessons written : ${written.length}`);
    for (const c of written) console.log(`    + ${c.text}`);
    console.log(`  deduped         : ${deduped.length}`);
    for (const d of deduped) {
      console.log(`    ~ ${d.candidate.text}`);
      console.log(`      (similar active lesson: "${d.existing.text.slice(0, 80)}")`);
    }
    return 0;
  } finally {
    await mongo.close();
  }
}
