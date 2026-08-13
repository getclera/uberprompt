import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const scenariosDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scenariosDir, "../../..");

function loadEnv() {
  const out = {};
  const envPath = join(repoRoot, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  }
  for (const k of ["MONGODB_URI", "MONGODB_DB", "OPENAI_API_KEY"]) {
    out[k] = process.env[k] || out[k];
    if (!out[k]) throw new Error(`missing ${k} — set it in the environment or ${envPath}`);
  }
  return out;
}

function renderTemplate(template, fragments, input) {
  const inputBlock = JSON.stringify(input, null, 2);
  const byKey = new Map(fragments.map((f) => [f.key, f.text]));
  return template.replace(/\{\{([\w-]+)\}\}/g, (_, key) => {
    const text = byKey.get(key);
    if (text === undefined) throw new Error(`template references unknown fragment "${key}"`);
    return text ? text : inputBlock;
  });
}

function parseLane(text) {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`model did not return JSON: ${text}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function main() {
  const scenario = process.argv[2] || "raise-escalation-threshold";
  const model = process.argv[3] || "gpt-5.1";
  const ticketPath = join(scenariosDir, scenario, "ticket.json");
  if (!existsSync(ticketPath)) throw new Error(`no ticket.json for scenario "${scenario}" at ${ticketPath}`);
  const ticket = JSON.parse(readFileSync(ticketPath, "utf8"));

  const env = loadEnv();
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  try {
    const db = client.db(env.MONGODB_DB);
    const prompt = await db.collection("prompts").findOne({ name: ticket.promptName });
    if (!prompt) throw new Error(`prompt "${ticket.promptName}" not found in Mongo — seed the demo first`);

    const rendered = renderTemplate(prompt.template, prompt.fragments, ticket.input);
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    const t0 = Date.now();
    const { text } = await generateText({ model: openai(model), prompt: rendered });
    const latencyMs = Date.now() - t0;
    const lane = parseLane(text);

    const account = ticket.input.account || {};
    console.log(`ticket ${ticket.input.ticketId} — ${account.company || "?"} ($${account.annualValue ?? "?"}/yr)`);
    console.log(`prompt ${prompt.name} v${prompt.version} | model ${model} | ${latencyMs}ms`);
    console.log(`\n  lane:       ${lane.lane}`);
    if (lane.confidence !== undefined) console.log(`  confidence: ${lane.confidence}`);
    if (lane.reason) console.log(`  reason:     ${lane.reason}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
