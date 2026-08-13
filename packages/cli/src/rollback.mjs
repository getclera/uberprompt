import { loadEnv, requireEnv, connect, voyageEmbedBatch } from "./store.mjs";
import { snapshotVersion } from "./review.mjs";
import { diffFragments } from "./sync.mjs";

export async function runRollback(repoRoot, promptName, opts = {}) {
  if (!promptName) {
    console.error("usage: uberprompt rollback <prompt> [--to <version>] [--dry-run]");
    return 1;
  }
  const env = loadEnv(repoRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB", "VOYAGE_API_KEY", "OPENAI_API_KEY"]);
  const { client, db } = await connect(env);
  let restored;
  try {
    const current = await db.collection("prompts").findOne({ name: promptName });
    if (!current) throw new Error(`prompt "${promptName}" not found`);
    let snapshot;
    if (opts.to !== undefined) {
      const toVersion = Number(opts.to);
      if (!Number.isInteger(toVersion)) throw new Error(`--to must be an integer version, got "${opts.to}"`);
      snapshot = await db.collection("prompt_versions").findOne({ promptName, version: toVersion });
      if (!snapshot) throw new Error(`no prompt_versions snapshot for ${promptName} v${toVersion}`);
    } else {
      snapshot = await db
        .collection("prompt_versions")
        .find({ promptName, version: { $lt: current.version } })
        .sort({ version: -1 })
        .limit(1)
        .next();
      if (!snapshot) throw new Error(`no earlier prompt_versions snapshot for ${promptName} — nothing to roll back to`);
    }
    const changes = diffFragments(snapshot, current);
    const templateChanged = snapshot.template !== current.template;
    if (changes.length === 0 && !templateChanged) {
      throw new Error(`${promptName} v${current.version} already matches the v${snapshot.version} snapshot — nothing to roll back`);
    }
    console.log(
      `rolling back ${promptName} v${current.version} to the v${snapshot.version} snapshot: ${changes.length} fragment(s) change${templateChanged ? " + template" : ""}: ${changes.map((c) => c.key).join(", ") || "none"}`
    );
    if (opts["dry-run"]) {
      console.log("dry-run: nothing written");
      return 0;
    }
    await snapshotVersion(db, current);
    const currentByKey = new Map(current.fragments.map((f) => [f.key, f]));
    const toEmbed = changes.filter((c) => c.newText);
    const vectors = await voyageEmbedBatch(env, toEmbed.map((c) => c.newText));
    const freshByKey = new Map(toEmbed.map((c, i) => [c.key, vectors[i]]));
    const fragments = snapshot.fragments.map((f) => {
      const cur = currentByKey.get(f.key);
      if (cur && cur.text === f.text) {
        return cur.embedding ? { key: f.key, text: f.text, embedding: cur.embedding } : { key: f.key, text: f.text };
      }
      const fresh = freshByKey.get(f.key);
      return fresh ? { key: f.key, text: f.text, embedding: fresh } : { key: f.key, text: f.text };
    });
    const newVersion = current.version + 1;
    const updatedAt = new Date();
    const res = await db.collection("prompts").updateOne(
      { _id: current._id, version: current.version },
      {
        $set: {
          fragments,
          template: snapshot.template,
          version: newVersion,
          updatedAt,
          updatedBy: "cli",
        },
      }
    );
    if (res.matchedCount !== 1) {
      throw new Error(`prompt "${promptName}" changed concurrently — rollback aborted, prompt untouched`);
    }
    const updated = { ...current, fragments, template: snapshot.template, version: newVersion, updatedAt, updatedBy: "cli" };
    const { versionId } = await snapshotVersion(db, updated);
    console.log(`rolled back: ${promptName} v${current.version} -> v${newVersion} (content of v${snapshot.version})`);
    console.log(`  snapshot created: prompt_versions ${versionId} (v${newVersion})`);
    console.log(`  ${toEmbed.length} changed fragment(s) re-embedded (voyage-3.5-lite)`);
    restored = { changes, refId: versionId };
  } finally {
    await client.close();
  }
  if (opts["no-sync"]) return 0;
  const { runSyncCheck } = await import("./sync.mjs");
  for (const change of restored.changes) {
    const code = await runSyncCheck(repoRoot, promptName, change.key, change.newText, {
      oldText: change.oldText,
      refId: restored.refId,
      model: opts.model,
    });
    if (code !== 0) return code;
  }
  return 0;
}
