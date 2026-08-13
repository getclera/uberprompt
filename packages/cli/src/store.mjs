import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ENV_KEYS = ["MONGODB_URI", "MONGODB_DB", "OPENAI_API_KEY", "VOYAGE_API_KEY"];
const VOYAGE_URL = "https://ai.mongodb.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-3.5-lite";

export function loadEnv(repoRoot) {
  const fileVals = {};
  const envPath = join(repoRoot, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      fileVals[m[1]] = v;
    }
  }
  const env = {};
  for (const k of ENV_KEYS) env[k] = process.env[k] || fileVals[k] || null;
  return env;
}

export function requireEnv(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `missing ${missing.join(", ")} — set in the environment or the repo-root .env`
    );
  }
}

export async function connect(env) {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  return { client, db: client.db(env.MONGODB_DB) };
}

export async function parseObjectId(id) {
  const { ObjectId } = await import("mongodb");
  if (!id || !ObjectId.isValid(id)) {
    throw new Error(`"${id}" is not a valid proposal id`);
  }
  return new ObjectId(id);
}

export function contentHash(doc) {
  const canon = {
    template: doc.template,
    fragments: doc.fragments.map((f) => ({ key: f.key, text: f.text })),
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

export async function voyageEmbed(env, text) {
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [text] }),
  });
  if (!res.ok) {
    throw new Error(`voyage embed failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const embedding = body.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error(
      `voyage embed returned no embedding: ${JSON.stringify(body).slice(0, 200)}`
    );
  }
  return embedding;
}

export async function openaiClient(env) {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}

export async function structuredCall(client, model, prompt, tool) {
  const resp = await client.chat.completions.create({
    model,
    tools: [
      {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: tool.name } },
    messages: [{ role: "user", content: prompt }],
  });
  const call = (resp.choices[0]?.message?.tool_calls || []).find(
    (c) => c.function?.name === tool.name
  );
  if (!call) throw new Error(`model returned no ${tool.name} tool call`);
  return JSON.parse(call.function.arguments);
}

export function truncate(text, max) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
