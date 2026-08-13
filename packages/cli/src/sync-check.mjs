import {
  loadEnv,
  requireEnv,
  connect,
  openaiClient,
  structuredCall,
  truncate,
} from "./store.mjs";
import { buildGraph, dependentsOf } from "./graph.mjs";

const DEFAULT_MODEL = "gpt-5.1";

const CONSISTENCY_TOOL = {
  name: "report_consistency",
  description:
    "Judge whether a dependent prompt fragment still agrees with the new text of a fragment that just changed. If they now contradict each other, return the minimal rewrite of the dependent fragment that restores consistency.",
  parameters: {
    type: "object",
    properties: {
      consistent: { type: "boolean" },
      reason: { type: "string" },
      newText: { type: "string" },
    },
    required: ["consistent", "reason"],
  },
};

export function modelFromMongo(prompts, edges) {
  return {
    prompts: new Map(prompts.map((p) => [p.name, p])),
    fragments: new Map(),
    edges,
  };
}

export function diffFragments(current, snapshot) {
  const old = new Map(snapshot.fragments.map((f) => [f.key, f.text]));
  return current.fragments
    .filter((f) => f.text && old.get(f.key) !== undefined && old.get(f.key) !== f.text)
    .map((f) => ({ key: f.key, oldText: old.get(f.key), newText: f.text }));
}

export function dependentTargets(graph, byName, changedPrompt, node) {
  const hits = dependentsOf(graph, node).filter(
    (e) => e.kind !== "contains" && e.node !== changedPrompt
  );
  const targets = new Map();
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
      if (!targets.has(id)) targets.set(id, { prompt: doc, fragment: key, via: hit.via, kind: hit.kind });
    }
  }
  return [...targets.values()];
}

async function checkTarget(ai, model, change, changedPrompt, target) {
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
  const out = await structuredCall(ai, model, prompt, CONSISTENCY_TOOL);
  return { ...out, oldText: frag.text };
}

async function fileSyncProposal(db, target, verdict, refId, dryRun) {
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
  const proposal = {
    target: { prompt: target.prompt.name, fragment: target.fragment },
    oldText: verdict.oldText,
    newText: verdict.newText,
    reason: verdict.reason,
    source: { type: "sync-check", ref: refId },
    status: "pending",
    ts: new Date(),
  };
  if (dryRun) {
    console.log(`      would file sync-check proposal for ${target.prompt.name}.${target.fragment}`);
    return 1;
  }
  const { insertedId } = await db.collection("proposals").insertOne(proposal);
  console.log(`      filed ${insertedId} for ${target.prompt.name}.${target.fragment}`);
  return 1;
}

export async function runSyncCheck(repoRoot, promptName, opts) {
  if (!promptName) {
    console.error("usage: uberprompt sync-check <prompt> [--against <prompt.fragment>] [--dry-run] [--model <m>]");
    return 1;
  }
  const env = loadEnv(repoRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB", "OPENAI_API_KEY"]);
  const model = opts.model || DEFAULT_MODEL;
  const dryRun = Boolean(opts["dry-run"]);
  const { client, db } = await connect(env);
  try {
    const current = await db.collection("prompts").findOne({ name: promptName });
    if (!current) throw new Error(`prompt "${promptName}" not found`);
    const snapshot = await db
      .collection("prompt_versions")
      .find({ promptName, version: { $lt: current.version } })
      .sort({ version: -1 })
      .limit(1)
      .next();
    if (!snapshot) {
      console.log(`${promptName} v${current.version}: no earlier prompt_versions snapshot — no bump to check`);
      return 0;
    }
    const changes = diffFragments(current, snapshot);
    console.log(
      `${promptName} v${snapshot.version} -> v${current.version}: ${changes.length} changed fragment(s): ${changes.map((c) => c.key).join(", ") || "none"}`
    );
    if (changes.length === 0) return 0;

    const prompts = await db.collection("prompts").find({}).toArray();
    const edges = await db.collection("edges").find({}).toArray();
    const byName = new Map(prompts.map((p) => [p.name, p]));
    const graph = buildGraph(modelFromMongo(prompts, edges));
    const ai = await openaiClient(env);
    let filed = 0;

    const sharedKeys = new Set(
      edges
        .filter((e) => e.kind === "uses" && e.to?.fragment && !e.to.prompt)
        .map((e) => e.to.fragment)
    );
    for (const change of changes) {
      const node = sharedKeys.has(change.key) ? change.key : `${promptName}.${change.key}`;
      const targets = dependentTargets(graph, byName, promptName, node);
      if (opts.against) {
        const dot = opts.against.indexOf(".");
        const doc = byName.get(dot === -1 ? opts.against : opts.against.slice(0, dot));
        if (!doc || dot === -1) throw new Error(`--against must be <prompt.fragment>, got "${opts.against}"`);
        targets.push({ prompt: doc, fragment: opts.against.slice(dot + 1), via: [node, "--against"], kind: "forced" });
      }
      console.log(`\n  ${node}: ${targets.length} dependent fragment(s) to check`);
      for (const target of targets) {
        console.log(`    ${target.prompt.name}.${target.fragment}  [${target.kind}]  via ${target.via.join(" -> ")}`);
        const verdict = await checkTarget(ai, model, change, promptName, target);
        if (!verdict) {
          console.log("      empty runtime slot — skipped");
          continue;
        }
        if (verdict.consistent) {
          console.log(`      consistent: ${truncate(verdict.reason, 100)}`);
          continue;
        }
        console.log(`      INCONSISTENT: ${truncate(verdict.reason, 100)}`);
        filed += await fileSyncProposal(db, target, verdict, snapshot._id, dryRun);
      }
    }
    console.log(
      `\n${dryRun ? "dry-run: " : ""}${filed} sync-check proposal(s)${dryRun ? " would be" : ""} filed${filed === 0 ? " — graph is quiet" : ""}`
    );
    return 0;
  } finally {
    await client.close();
  }
}
