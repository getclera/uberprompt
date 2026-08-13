import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const scenariosDir = dirname(fileURLToPath(import.meta.url));
const demoDir = resolve(scenariosDir, "..");
const repoRoot = resolve(scenariosDir, "../../..");

const WIPE_COLLECTIONS = [
  "prompts",
  "prompt_versions",
  "edges",
  "proposals",
  "lessons",
  "traces",
  "spans",
  "eval_runs",
];

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
  for (const k of ["MONGODB_URI", "MONGODB_DB", "OPENAI_API_KEY", "VOYAGE_API_KEY"]) {
    out[k] = process.env[k] || out[k];
    if (!out[k]) throw new Error(`missing ${k} — set it in the environment or ${envPath}`);
  }
  return out;
}

function revertScenarios() {
  for (const name of readdirSync(scenariosDir)) {
    const scenarioPath = join(scenariosDir, name, "scenario.json");
    if (!existsSync(scenarioPath)) continue;
    try {
      execFileSync("node", [join(scenariosDir, "apply.mjs"), name, "--revert"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      console.log(`reverted scenario file edits: ${name}`);
    } catch {
      console.log(`scenario "${name}" already at base state`);
    }
  }
}

async function main() {
  const env = loadEnv();

  revertScenarios();

  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  try {
    const db = client.db(env.MONGODB_DB);
    for (const name of WIPE_COLLECTIONS) {
      const { deletedCount } = await db.collection(name).deleteMany({});
      console.log(`wiped ${name}: ${deletedCount} docs`);
    }
  } finally {
    await client.close();
  }

  console.log("\nreseeding prompts + traces via @uberprompt/sdk seed-demo …");
  execFileSync("pnpm", ["-F", "@uberprompt/sdk", "seed-demo"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

  console.log("\nreset complete — clean v1 demo state.");
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
