import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "mongodb";
import {
  loadEnv,
  requireEnv,
  connect,
  openaiClient,
  structuredCall,
  truncate,
  voyageEmbed,
  cosine,
  VOYAGE_EMBED_MODEL,
} from "./store.ts";
import type { OpenAIProvider } from "./store.ts";
import { buildGraph, dependentsOf } from "./graph.ts";
import { refNodeId } from "./load.ts";
import type { CliEnv, Edge, Fragment, Graph, PromptDoc, Ref, RenderModel, Tool } from "./types.ts";

const DEFAULT_MODEL = "gpt-5.1";
const SEMANTIC_THRESHOLD = 0.8;
const SEMANTIC_TOP_K = 5;
const VECTOR_INDEX = "fragments_embedding";

const CONSISTENCY_TOOL: Tool = {
  name: "report_consistency",
  description:
    "Judge whether a dependent prompt fragment still agrees with the new text of a fragment that just changed. If they now contradict each other, return the minimal rewrite of the dependent fragment that restores consistency.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      consistent: { type: "boolean" },
      reason: { type: "string" },
      newText: { type: ["string", "null"] },
    },
    required: ["consistent", "reason", "newText"],
  },
};

interface ConsistencyVerdict {
  consistent: boolean;
  reason: string;
  newText: string | null;
}

export interface Change {
  key: string;
  oldText: string;
  newText: string;
}

interface Target {
  prompt: PromptDoc;
  fragment: string;
  via: string[];
  kind: string;
}

interface SemanticRow {
  name: string;
  fragments?: Fragment[];
}

interface SemanticHit {
  prompt: string;
  fragment: string;
  score: number;
}

interface SnapshotDoc {
  promptName: string;
  version: number;
  fragments: Fragment[];
}

export function modelFromMongo(prompts: PromptDoc[], edges: Edge[]): RenderModel {
  return {
    prompts: new Map(prompts.map((p): [string, PromptDoc] => [p.name, p])),
    fragments: new Map<string, Fragment>(),
    edges,
  };
}

export function diffFragments(
  current: { fragments: Fragment[] },
  snapshot: { fragments: Fragment[] }
): Change[] {
  const old = new Map(snapshot.fragments.map((f) => [f.key, f.text]));
  return current.fragments
    .filter((f) => f.text && old.get(f.key) !== undefined && old.get(f.key) !== f.text)
    .map((f) => ({ key: f.key, oldText: old.get(f.key)!, newText: f.text }));
}

export function sharedFragmentKeys(edges: Edge[], repoRoot: string): Set<string> {
  const keys = new Set<string>();
  for (const edge of edges) {
    for (const ref of [edge.from, edge.to]) {
      if (ref && ref.fragment && !ref.prompt) keys.add(ref.fragment);
    }
  }
  const seedDir = join(repoRoot, "apps", "demo", "fragments");
  if (existsSync(seedDir)) {
    for (const file of readdirSync(seedDir)) {
      if (file.endsWith(".json")) keys.add(file.slice(0, -5));
    }
  }
  return keys;
}

export function dependentTargets(
  graph: Graph,
  byName: Map<string, PromptDoc>,
  changedPrompt: string,
  node: string
): Target[] {
  const hits = dependentsOf(graph, node).filter(
    (e) => e.kind !== "contains" && e.node !== changedPrompt
  );
  const targets = new Map<string, Target>();
  for (const hit of hits) {
    const dot = hit.node.indexOf(".");
    const promptName = dot === -1 ? hit.node : hit.node.slice(0, dot);
    const doc = byName.get(promptName);
    if (!doc || promptName === changedPrompt) continue;
    const keys =
      dot === -1
        ? doc.fragments.filter((f) => f.text).map((f) => f.key)
        : [hit.node.slice(dot + 1)];
    for (const key of keys) {
      const id = `${promptName}.${key}`;
      if (!targets.has(id)) {
        targets.set(id, { prompt: doc, fragment: key, via: hit.via, kind: hit.kind });
      }
    }
  }
  return [...targets.values()];
}

export function pickSemanticHits(
  rows: SemanticRow[],
  changedPrompt: string,
  queryVector: number[],
  opts: { threshold?: number; topK?: number } = {}
): SemanticHit[] {
  const threshold = opts.threshold ?? SEMANTIC_THRESHOLD;
  const topK = opts.topK ?? SEMANTIC_TOP_K;
  const hits: SemanticHit[] = [];
  for (const row of rows) {
    if (row.name === changedPrompt) continue;
    for (const frag of row.fragments || []) {
      if (!frag.text || !Array.isArray(frag.embedding)) continue;
      const score = cosine(queryVector, frag.embedding);
      if (score >= threshold) {
        hits.push({ prompt: row.name, fragment: frag.key, score });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

export function edgeEndpoints(changedRef: Ref, hitRef: Ref): { from: Ref; to: Ref } {
  if (!hitRef.prompt && changedRef.prompt) return { from: changedRef, to: hitRef };
  return { from: hitRef, to: changedRef };
}

export function hasEdgeBetween(edges: Edge[], a: Ref, b: Ref): boolean {
  const na = refNodeId(a);
  const nb = refNodeId(b);
  return edges.some((edge) => {
    const f = refNodeId(edge.from);
    const t = refNodeId(edge.to);
    return (f === na && t === nb) || (f === nb && t === na);
  });
}

async function checkTarget(
  ai: OpenAIProvider,
  model: string,
  change: Change,
  changedPrompt: string,
  target: Target
): Promise<(ConsistencyVerdict & { oldText: string }) | null> {
  const frag = target.prompt.fragments.find((f) => f.key === target.fragment);
  if (!frag || !frag.text) return null;
  const prompt =
    `The fragment "${change.key}" of prompt "${changedPrompt}" just changed.\n\n` +
    `Old text:\n${change.oldText}\n\n` +
    `New text:\n${change.newText}\n\n` +
    `The fragment "${target.fragment}" of prompt "${target.prompt.name}" depends on it:\n${frag.text}\n\n` +
    "Does the dependent fragment still agree with the new text? It is inconsistent only " +
    "if following both texts would produce contradictory behavior. If inconsistent, return " +
    "the complete new text for the dependent fragment, changing as little wording as possible.";
  const out = await structuredCall<ConsistencyVerdict>(ai, model, prompt, CONSISTENCY_TOOL);
  return { ...out, oldText: frag.text };
}

async function fileSyncProposal(
  db: Db,
  target: Target,
  verdict: ConsistencyVerdict & { oldText: string },
  refId: unknown,
  dryRun: boolean
): Promise<number> {
  if (!verdict.newText || verdict.newText === verdict.oldText) {
    console.log("      inconsistent but no rewrite returned — dropped");
    return 0;
  }
  const duplicate = await db.collection("proposals").findOne({
    "target.prompt": target.prompt.name,
    "target.fragment": target.fragment,
    newText: verdict.newText,
    status: "pending",
  });
  if (duplicate) {
    console.log(`      identical pending proposal ${duplicate._id} — skipped`);
    return 0;
  }
  if (dryRun) {
    console.log(
      `      would file sync-check proposal for ${target.prompt.name}.${target.fragment}`
    );
    return 1;
  }
  const { insertedId } = await db.collection("proposals").insertOne({
    target: { prompt: target.prompt.name, fragment: target.fragment },
    oldText: verdict.oldText,
    newText: verdict.newText,
    reason: verdict.reason,
    source: { type: "sync-check", ...(refId ? { ref: refId } : {}) },
    status: "pending",
    ts: new Date(),
  });
  console.log(`      FILED ${insertedId} for ${target.prompt.name}.${target.fragment}`);
  return 1;
}

interface DiscoveryState {
  promptName: string;
  fragmentKey: string;
  frag: Fragment;
  newText: string;
  prompts: PromptDoc[];
  edges: Edge[];
  sharedKeys: Set<string>;
  byName: Map<string, PromptDoc>;
  node: string;
  targets: Map<string, Target>;
}

async function discoverSemanticEdges(
  db: Db,
  env: CliEnv,
  state: DiscoveryState,
  dryRun: boolean
): Promise<void> {
  const { promptName, fragmentKey, frag, newText, prompts, edges, sharedKeys, byName, node, targets } = state;
  const queryVector =
    frag.text === newText && Array.isArray(frag.embedding)
      ? frag.embedding
      : await voyageEmbed(env, newText);
  const rows = await db
    .collection("prompts")
    .aggregate<SemanticRow>([
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: "fragments.embedding",
          queryVector,
          numCandidates: 100,
          limit: 10,
        },
      },
      {
        $project: {
          _id: 0,
          name: 1,
          "fragments.key": 1,
          "fragments.text": 1,
          "fragments.embedding": 1,
        },
      },
    ])
    .toArray();
  if (rows.length === 0 && prompts.length > 1) {
    throw new Error(`$vectorSearch on "${VECTOR_INDEX}" returned no rows — index unhealthy or vectors missing; run \`uberprompt reembed\``);
  }
  const hits = pickSemanticHits(rows, promptName, queryVector);
  console.log(
    `  semantic discovery ($vectorSearch, cosine >= ${SEMANTIC_THRESHOLD}, top ${SEMANTIC_TOP_K}): ${hits.length} hit(s)`
  );
  const changedRef: Ref = sharedKeys.has(fragmentKey)
    ? { fragment: fragmentKey }
    : { prompt: promptName, fragment: fragmentKey };
  const seenPairs = new Set<string>();
  for (const hit of hits) {
    console.log(`    ${hit.prompt}.${hit.fragment}  cosine ${hit.score.toFixed(3)}`);
    const hitRef: Ref = sharedKeys.has(hit.fragment)
      ? { fragment: hit.fragment }
      : { prompt: hit.prompt, fragment: hit.fragment };
    const { from, to } = edgeEndpoints(changedRef, hitRef);
    const pairKey = [refNodeId(from), refNodeId(to)].sort().join("|");
    if (hasEdgeBetween(edges, from, to) || seenPairs.has(pairKey)) {
      console.log(`      edge ${refNodeId(from)} -> ${refNodeId(to)} already known`);
    } else {
      seenPairs.add(pairKey);
      if (dryRun) {
        console.log(
          `      would insert semantic edge ${refNodeId(from)} -> ${refNodeId(to)} (confidence ${hit.score.toFixed(3)})`
        );
      } else {
        await db.collection("edges").insertOne({
          from,
          to,
          kind: "semantic",
          note: `discovered by sync check of ${node}`,
          confidence: Number(hit.score.toFixed(4)),
          model: VOYAGE_EMBED_MODEL,
          inferredAt: new Date(),
        });
        console.log(
          `      NEW semantic edge ${refNodeId(from)} -> ${refNodeId(to)} (confidence ${hit.score.toFixed(3)})`
        );
      }
    }
    const id = `${hit.prompt}.${hit.fragment}`;
    const hitDoc = byName.get(hit.prompt);
    if (hitDoc && !targets.has(id)) {
      targets.set(id, {
        prompt: hitDoc,
        fragment: hit.fragment,
        kind: "semantic",
        via: [node, "$vectorSearch"],
      });
    }
  }
}

export async function runSyncCheck(
  repoRoot: string,
  promptName: string,
  fragmentKey: string,
  newText: string,
  opts: { model?: string; dryRun?: boolean; oldText?: string; refId?: unknown } = {}
): Promise<number> {
  const env = loadEnv(repoRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB", "OPENAI_API_KEY", "VOYAGE_API_KEY"]);
  const model = opts.model || DEFAULT_MODEL;
  const dryRun = Boolean(opts.dryRun);
  const { client, db } = await connect(env);
  try {
    const prompts = await db.collection<PromptDoc>("prompts").find({}).toArray();
    const edges = await db.collection<Edge>("edges").find({}).toArray();
    const byName = new Map<string, PromptDoc>(prompts.map((p) => [p.name, p]));
    const current = byName.get(promptName);
    if (!current) throw new Error(`prompt "${promptName}" not found`);
    const frag = current.fragments.find((f) => f.key === fragmentKey);
    if (!frag) {
      throw new Error(`fragment "${fragmentKey}" not found in prompt "${promptName}"`);
    }
    let oldText = opts.oldText;
    if (oldText === undefined) {
      const snapshot = await db
        .collection<SnapshotDoc>("prompt_versions")
        .find({ promptName, version: { $lt: current.version } })
        .sort({ version: -1 })
        .limit(1)
        .next();
      oldText = snapshot?.fragments.find((f) => f.key === fragmentKey)?.text;
      if (oldText === undefined) {
        throw new Error(
          `no earlier snapshot text for ${promptName}.${fragmentKey} — pass the old text or approve a change first`
        );
      }
    }
    const node = `${promptName}.${fragmentKey}`;
    if (oldText === newText) {
      console.log(`${node}: text unchanged — nothing to check`);
      return 0;
    }
    console.log(`\nsync check: ${node} changed — walking the graph`);
    const sharedKeys = sharedFragmentKeys(edges, repoRoot);
    const graph = buildGraph(modelFromMongo(prompts, edges));
    const nodes = [node, ...(sharedKeys.has(fragmentKey) ? [fragmentKey] : [])];
    const targets = new Map<string, Target>();
    for (const n of nodes) {
      for (const t of dependentTargets(graph, byName, promptName, n)) {
        const id = `${t.prompt.name}.${t.fragment}`;
        if (!targets.has(id)) targets.set(id, t);
      }
    }
    console.log(`  graph dependents (uses + semantic edges): ${targets.size}`);
    for (const t of targets.values()) {
      console.log(`    ${t.prompt.name}.${t.fragment}  [${t.kind}]  via ${t.via.join(" -> ")}`);
    }
    await discoverSemanticEdges(
      db,
      env,
      { promptName, fragmentKey, frag, newText, prompts, edges, sharedKeys, byName, node, targets },
      dryRun
    );
    const change: Change = { key: fragmentKey, oldText, newText };
    const ai = await openaiClient(env);
    let filed = 0;
    console.log(`  consistency check (${model}) over ${targets.size} dependent fragment(s):`);
    for (const target of targets.values()) {
      console.log(`    ${target.prompt.name}.${target.fragment}  [${target.kind}]`);
      const verdict = await checkTarget(ai, model, change, promptName, target);
      if (!verdict) {
        console.log("      empty runtime slot — skipped");
        continue;
      }
      if (verdict.consistent) {
        console.log(`      consistent: ${truncate(verdict.reason, 110)}`);
        continue;
      }
      console.log(`      INCONSISTENT: ${truncate(verdict.reason, 110)}`);
      filed += await fileSyncProposal(db, target, verdict, opts.refId ?? null, dryRun);
    }
    console.log(
      `${dryRun ? "dry-run: " : ""}${filed} sync-check proposal(s)${dryRun ? " would be" : ""} filed${
        filed === 0 ? " — graph is quiet" : " — approve them to continue the wave"
      }`
    );
    return 0;
  } finally {
    await client.close();
  }
}

export async function runSyncCommand(
  repoRoot: string,
  targetArg: string | undefined,
  opts: { model?: string; "dry-run"?: boolean } = {}
): Promise<number> {
  if (!targetArg) {
    console.error("usage: uberprompt sync <prompt[.fragment]> [--dry-run] [--model <m>]");
    return 1;
  }
  const dot = targetArg.indexOf(".");
  const promptName = dot === -1 ? targetArg : targetArg.slice(0, dot);
  const fragmentKey = dot === -1 ? null : targetArg.slice(dot + 1);
  const env = loadEnv(repoRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB"]);
  const { client, db } = await connect(env);
  let changes: Change[];
  let refId: unknown = null;
  try {
    const current = await db.collection<PromptDoc>("prompts").findOne({ name: promptName });
    if (!current) throw new Error(`prompt "${promptName}" not found`);
    if (fragmentKey && !current.fragments.some((f) => f.key === fragmentKey)) {
      throw new Error(`fragment "${fragmentKey}" not found in prompt "${promptName}"`);
    }
    const snapshot = await db
      .collection<SnapshotDoc>("prompt_versions")
      .find({ promptName, version: { $lt: current.version } })
      .sort({ version: -1 })
      .limit(1)
      .next();
    if (!snapshot) {
      console.log(
        `${promptName} v${current.version}: no earlier prompt_versions snapshot — no change to check`
      );
      return 0;
    }
    changes = diffFragments(current, snapshot);
    if (fragmentKey) changes = changes.filter((c) => c.key === fragmentKey);
    console.log(
      `${promptName} v${snapshot.version} -> v${current.version}: ${changes.length} changed fragment(s): ${changes.map((c) => c.key).join(", ") || "none"}`
    );
    const currentSnap = await db
      .collection<SnapshotDoc>("prompt_versions")
      .findOne({ promptName, version: current.version });
    refId = currentSnap?._id ?? null;
  } finally {
    await client.close();
  }
  for (const change of changes) {
    const code = await runSyncCheck(repoRoot, promptName, change.key, change.newText, {
      oldText: change.oldText,
      refId,
      model: opts.model,
      dryRun: opts["dry-run"],
    });
    if (code !== 0) return code;
  }
  return 0;
}
