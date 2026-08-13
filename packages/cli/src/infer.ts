// `uberprompt infer [--apply] [--threshold 0.7]`
// Ask Claude for undeclared semantic dependencies between fragments: fragments
// that restate / paraphrase / constrain the same rules such that editing one
// should trigger review of the other. Structured tool output, threshold filter,
// optional merge into edges.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadModel, nonEmptyFragments, refNodeId } from "./load.ts";
import { loadEnv, connect } from "./store.ts";
import type { CliOpts, Model, Ref } from "./types.ts";

const MODEL = "gpt-5-nano";

interface InferEdge {
  from: { prompt?: string | null; fragment: string };
  to: { fragment?: string };
  confidence?: number;
  reason?: string;
}

function loadApiKey(repoRoot: string): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const envPath = join(repoRoot, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.+)\s*$/);
      if (m) {
        let v = m[1]!.trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (v) return v;
      }
    }
  }
  return null;
}

const TOOL_DESCRIPTION =
  "Report semantic-dependency edges between prompt fragments. A semantic edge means two fragments restate, paraphrase, or constrain the SAME underlying rule (e.g. the same threshold, policy, or trigger) in their own words, such that editing one should trigger a review of the other.";

function buildEdgeSchema(
  model: Model,
  frags: { key: string }[]
): Record<string, unknown> {
  const sharedKeys = [...model.fragments.keys()];
  const promptNames = [...model.prompts.keys()];
  const fragmentKeys = [...new Set(frags.map((f) => f.key))];
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      edges: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: {
              type: "object",
              additionalProperties: false,
              properties: {
                prompt: { type: ["string", "null"], enum: [...promptNames, null] },
                fragment: { type: "string", enum: fragmentKeys },
              },
              required: ["prompt", "fragment"],
            },
            to: {
              type: "object",
              additionalProperties: false,
              properties: { fragment: { type: "string", enum: sharedKeys } },
              required: ["fragment"],
            },
            confidence: { type: "number" },
            reason: { type: "string" },
          },
          required: ["from", "to", "confidence", "reason"],
        },
      },
    },
    required: ["edges"],
  };
}

// Pairs already tied by a declared "uses" edge from that prompt — never re-infer.
function usesPairKeys(model: Model): Set<string> {
  const s = new Set<string>();
  for (const e of model.edges) {
    if (e.kind !== "uses") continue;
    if (e.from.prompt && e.to.fragment) {
      s.add(`${e.from.prompt}::${e.to.fragment}`);
    }
  }
  return s;
}

function edgeExists(model: Model, from: Ref, to: Ref): boolean {
  const fromId = refNodeId(from);
  const toId = refNodeId(to);
  return model.edges.some(
    (e) => refNodeId(e.from) === fromId && refNodeId(e.to) === toId
  );
}

export async function runInfer(dir: string, repoRoot: string, opts: CliOpts): Promise<number> {
  const threshold = opts.threshold != null ? opts.threshold : 0.7;
  const apiKey = loadApiKey(repoRoot);
  if (!apiKey) {
    console.error(
      "error: OPENAI_API_KEY is not set.\n" +
        "  Set it in your environment or add it to a .env file at the repo root:\n" +
        "    OPENAI_API_KEY=sk-...\n" +
        "  `uberprompt infer` needs it to call the model."
    );
    return 1;
  }

  const model = loadModel(dir);
  const frags = nonEmptyFragments(model);

  const listing = frags
    .map(
      (f) =>
        `- id: ${f.id}\n  kind: ${f.kind}${
          f.prompt ? `\n  prompt: ${f.prompt}` : ""
        }\n  text: ${JSON.stringify(f.text)}`
    )
    .join("\n");

  const prompt =
    "You are auditing a set of prompt fragments for UNDECLARED semantic dependencies.\n\n" +
    "Each fragment has an id. Shared fragments are canonical policy text; prompt-local " +
    "fragments belong to one prompt. Find pairs where a fragment restates, paraphrases, " +
    "or constrains the SAME underlying rule as another fragment (same threshold, policy, " +
    "trigger, or constraint) — even in different words — so that editing one should " +
    "trigger a review of the other.\n\n" +
    "Report each as an edge FROM the paraphrasing fragment TO the shared fragment it " +
    "mirrors. For a prompt-local `from`, include its prompt. Only report the shared " +
    "fragment key in `to`. Give a confidence 0-1 and a one-sentence reason. Do not report " +
    "a fragment against itself.\n\n" +
    "Fragments:\n" +
    listing;

  const { generateText, Output, jsonSchema } = await import("ai");
  const { createOpenAI } = await import("@ai-sdk/openai");
  const provider = createOpenAI({ apiKey });

  const schema = buildEdgeSchema(model, frags) as Parameters<typeof jsonSchema>[0];
  const { output } = await generateText({
    model: provider(MODEL),
    output: Output.object({ schema: jsonSchema(schema) }),
    prompt: `${TOOL_DESCRIPTION}\n\n${prompt}`,
    telemetry: { functionId: "cli-infer" },
  });

  const raw = (output as { edges?: InferEdge[] } | undefined)?.edges || [];

  const usesPairs = usesPairKeys(model);
  const proposed: InferEdge[] = [];
  for (const e of raw) {
    if (!e.from || !e.to || !e.to.fragment) continue;
    if (e.from.prompt === null) delete e.from.prompt;
    if (e.from.prompt) {
      const owner = model.prompts.get(e.from.prompt);
      if (!owner || !(owner.fragments || []).some((f) => f.key === e.from.fragment)) continue;
    } else if (!model.fragments.has(e.from.fragment)) {
      continue;
    }
    if (e.from.fragment && e.from.fragment.includes(".")) {
      const dot = e.from.fragment.indexOf(".");
      const head = e.from.fragment.slice(0, dot);
      if (model.prompts.has(head)) {
        e.from = { prompt: head, fragment: e.from.fragment.slice(dot + 1) };
      }
    }
    if (typeof e.confidence !== "number" || e.confidence < threshold) continue;
    // skip self
    if (e.from.fragment === e.to.fragment && !e.from.prompt) continue;
    // skip pairs already declared via `uses`
    if (e.from.prompt && usesPairs.has(`${e.from.prompt}::${e.to.fragment}`)) {
      continue;
    }
    proposed.push(e);
  }

  if (!opts.apply) {
    if (proposed.length === 0) {
      console.log(`No semantic edges >= ${threshold} proposed.`);
      return 0;
    }
    console.log(`Proposed semantic edges (threshold ${threshold}):\n`);
    for (const e of proposed) {
      const from = e.from.prompt
        ? `${e.from.prompt}.${e.from.fragment}`
        : e.from.fragment;
      console.log(
        `  ${from} -> ${e.to.fragment}  conf=${(e.confidence ?? 0).toFixed(2)}`
      );
      console.log(`    ${e.reason}`);
    }
    console.log("\nRe-run with --apply to merge into edges.json.");
    return 0;
  }

  // --apply: merge, never duplicating and never touching declared uses edges.
  const now = new Date().toISOString();
  let added = 0;
  for (const e of proposed) {
    const from = e.from.prompt
      ? { prompt: e.from.prompt, fragment: e.from.fragment }
      : { fragment: e.from.fragment };
    const to = { fragment: e.to.fragment };
    if (edgeExists(model, from, to)) continue;
    model.edges.push({
      from,
      to,
      kind: "semantic",
      note: e.reason,
      confidence: e.confidence,
      model: MODEL,
      inferredAt: now,
    });
    added++;
  }
  writeFileSync(model.edgesPath, JSON.stringify(model.edges, null, 2) + "\n");
  console.log(`Applied ${added} semantic edge(s) to ${model.edgesPath}.`);

  await upsertSemanticEdges(repoRoot, proposed, now);
  return 0;
}

async function upsertSemanticEdges(
  repoRoot: string,
  proposed: InferEdge[],
  now: string,
): Promise<void> {
  const env = loadEnv(repoRoot);
  if (!env.MONGODB_URI) {
    console.log("MONGODB_URI not set — wrote edges.json only, skipped Mongo upsert.");
    return;
  }
  const { client, db } = await connect(env);
  try {
    const col = db.collection("edges");
    let upserted = 0;
    let matched = 0;
    for (const e of proposed) {
      const prompt = e.from.prompt ?? undefined;
      const key: Record<string, unknown> = {
        "from.fragment": e.from.fragment,
        "to.fragment": e.to.fragment,
        kind: "semantic",
        "from.prompt": prompt ? prompt : { $exists: false },
      };
      const set: Record<string, unknown> = {
        "from.fragment": e.from.fragment,
        "to.fragment": e.to.fragment,
        kind: "semantic",
        note: e.reason,
        confidence: e.confidence,
        model: MODEL,
        inferredAt: new Date(now),
      };
      if (prompt) set["from.prompt"] = prompt;
      const res = await col.updateOne(key, { $set: set }, { upsert: true });
      if (res.upsertedCount > 0) upserted++;
      else matched++;
    }
    console.log(
      `Upserted ${upserted} new + refreshed ${matched} existing semantic edge(s) in the Mongo edges collection.`,
    );
  } finally {
    await client.close();
  }
}
