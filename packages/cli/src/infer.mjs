// `uberprompt infer [--apply] [--threshold 0.7]`
// Ask Claude for undeclared semantic dependencies between fragments: fragments
// that restate / paraphrase / constrain the same rules such that editing one
// should trigger review of the other. Structured tool output, threshold filter,
// optional merge into edges.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadModel, nonEmptyFragments, refNodeId } from "./load.mjs";

const MODEL = "gpt-5-nano";

function loadApiKey(repoRoot) {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const envPath = join(repoRoot, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.+)\s*$/);
      if (m) {
        let v = m[1].trim();
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

const TOOL = {
  name: "report_semantic_edges",
  description:
    "Report semantic-dependency edges between prompt fragments. A semantic edge means two fragments restate, paraphrase, or constrain the SAME underlying rule (e.g. the same threshold, policy, or trigger) in their own words, such that editing one should trigger a review of the other.",
  input_schema: {
    type: "object",
    properties: {
      edges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                fragment: { type: "string" },
              },
              required: ["fragment"],
            },
            to: {
              type: "object",
              properties: { fragment: { type: "string" } },
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
  },
};

// Pairs already tied by a declared "uses" edge from that prompt — never re-infer.
function usesPairKeys(model) {
  const s = new Set();
  for (const e of model.edges) {
    if (e.kind !== "uses") continue;
    if (e.from.prompt && e.to.fragment) {
      s.add(`${e.from.prompt}::${e.to.fragment}`);
    }
  }
  return s;
}

function edgeExists(model, from, to) {
  const fromId = refNodeId(from);
  const toId = refNodeId(to);
  return model.edges.some(
    (e) => refNodeId(e.from) === fromId && refNodeId(e.to) === toId
  );
}

export async function runInfer(dir, repoRoot, opts) {
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

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const resp = await client.chat.completions.create({
    model: MODEL,
    tools: [
      {
        type: "function",
        function: {
          name: TOOL.name,
          description: TOOL.description,
          parameters: TOOL.input_schema,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: TOOL.name } },
    messages: [{ role: "user", content: prompt }],
  });

  const toolCall = (resp.choices[0]?.message?.tool_calls || []).find(
    (c) => c.function?.name === TOOL.name
  );
  const raw = toolCall
    ? JSON.parse(toolCall.function.arguments).edges || []
    : [];

  const usesPairs = usesPairKeys(model);
  const proposed = [];
  for (const e of raw) {
    if (!e.from || !e.to || !e.to.fragment) continue;
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
        `  ${from} -> ${e.to.fragment}  conf=${e.confidence.toFixed(2)}`
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
  return 0;
}
