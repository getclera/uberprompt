import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, definePrompt, tracesCol, type UsesEdge } from "../src/index";

interface SharedFragmentFile {
  key: string;
  version: number;
  text: string;
}

interface PromptFile {
  name: string;
  version: number;
  template: string;
  fragments: Array<{ key: string; text: string }>;
  uses: string[];
}

interface EdgeFile {
  from: { prompt?: string; fragment?: string };
  to: { prompt?: string; fragment?: string };
  kind: "uses" | "semantic";
  note?: string;
}

interface TraceSeedFile {
  promptName: string;
  promptVersion: number;
  input: object;
  output: string;
  meta: { model: string; latencyMs: number; tokens?: object };
  score?: number;
  error?: string;
  ts: string;
}

const demoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/demo");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadSharedFragments(): Map<string, string> {
  const shared = new Map<string, string>();
  for (const file of readdirSync(join(demoDir, "fragments"))) {
    const doc = readJson<SharedFragmentFile>(join(demoDir, "fragments", file));
    shared.set(doc.key, doc.text);
  }
  return shared;
}

async function seedPrompts(): Promise<void> {
  const shared = loadSharedFragments();
  const edges = readJson<EdgeFile[]>(join(demoDir, "edges.json"));
  for (const file of readdirSync(join(demoDir, "prompts"))) {
    const promptFile = readJson<PromptFile>(join(demoDir, "prompts", file));
    const fragments: Record<string, string> = {};
    for (const fragment of promptFile.fragments) {
      fragments[fragment.key] = fragment.text;
    }
    for (const key of promptFile.uses) {
      const text = shared.get(key);
      if (text === undefined) {
        throw new Error(`${promptFile.name} uses unknown shared fragment "${key}"`);
      }
      if (key in fragments) {
        throw new Error(`${promptFile.name} local fragment "${key}" collides with shared fragment`);
      }
      fragments[key] = text;
    }
    const uses: UsesEdge[] = promptFile.uses.map((key) => {
      const declared = edges.find(
        (edge) => edge.from.prompt === promptFile.name && edge.to.fragment === key,
      );
      return declared?.note ? { fragment: key, note: declared.note } : { fragment: key };
    });
    const doc = await definePrompt({
      name: promptFile.name,
      template: promptFile.template,
      fragments,
      uses,
      updatedBy: "seed-demo",
    });
    console.log(
      `seeded ${doc.name} v${doc.version} (${doc.fragments.length} fragments, ${uses.length} uses edges)`,
    );
  }
}

async function seedTraces(): Promise<void> {
  const existing = await tracesCol().countDocuments();
  if (existing > 0) {
    console.log(`traces collection already has ${existing} docs, skipping trace seed`);
    return;
  }
  const seeds = readJson<TraceSeedFile[]>(join(demoDir, "traces.seed.json"));
  await tracesCol().insertMany(seeds.map(({ ts, ...rest }) => ({ ...rest, ts: new Date(ts) })));
  console.log(`seeded ${seeds.length} traces`);
}

async function main(): Promise<void> {
  await seedPrompts();
  await seedTraces();
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
