import {
  loadEnv,
  requireEnv,
  connect,
  parseObjectId,
  contentHash,
  voyageEmbed,
} from "./store.mjs";

async function loadPending(db, _id) {
  const proposal = await db.collection("proposals").findOne({ _id });
  if (!proposal) throw new Error(`proposal ${_id} not found`);
  if (proposal.status !== "pending") {
    throw new Error(`proposal ${_id} is "${proposal.status}", not pending`);
  }
  return proposal;
}

async function snapshotVersion(db, prompt) {
  const hash = contentHash(prompt);
  const versions = db.collection("prompt_versions");
  const existing = await versions.findOne({
    promptName: prompt.name,
    version: prompt.version,
  });
  if (existing) {
    const existingHash = existing.contentHash || contentHash(existing);
    if (existingHash !== hash) {
      throw new Error(
        `prompt_versions already holds ${prompt.name} v${prompt.version} with different content — refusing to overwrite an immutable snapshot`
      );
    }
    if (!existing.contentHash) {
      await versions.updateOne(
        { _id: existing._id },
        { $set: { contentHash: existingHash } }
      );
    }
    return { versionId: existing._id, created: false };
  }
  const { _id, ...doc } = prompt;
  const { insertedId } = await versions.insertOne({
    ...doc,
    promptName: prompt.name,
    frozenAt: new Date(),
    contentHash: hash,
  });
  return { versionId: insertedId, created: true };
}

export async function runReject(repoRoot, id) {
  const env = loadEnv(repoRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB"]);
  const _id = await parseObjectId(id);
  const { client, db } = await connect(env);
  try {
    const proposal = await loadPending(db, _id);
    await db
      .collection("proposals")
      .updateOne({ _id }, { $set: { status: "rejected" } });
    const target = proposal.target.fragment
      ? `${proposal.target.prompt}.${proposal.target.fragment}`
      : proposal.target.prompt;
    console.log(`rejected ${_id} (${target})`);
    return 0;
  } finally {
    await client.close();
  }
}

export async function runApprove(repoRoot, id) {
  const env = loadEnv(repoRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB", "VOYAGE_API_KEY"]);
  const _id = await parseObjectId(id);
  const { client, db } = await connect(env);
  try {
    const proposal = await loadPending(db, _id);
    if (!proposal.target.fragment) {
      throw new Error(`proposal ${_id} has no target fragment — cannot apply`);
    }
    const prompt = await db
      .collection("prompts")
      .findOne({ name: proposal.target.prompt });
    if (!prompt) {
      throw new Error(`prompt "${proposal.target.prompt}" not found`);
    }
    const idx = prompt.fragments.findIndex((f) => f.key === proposal.target.fragment);
    if (idx === -1) {
      throw new Error(
        `fragment "${proposal.target.fragment}" not found in prompt "${prompt.name}"`
      );
    }
    if (prompt.fragments[idx].text !== proposal.oldText) {
      throw new Error(
        `stale proposal: "${prompt.name}.${proposal.target.fragment}" changed since the proposal was filed — reject it and re-propose`
      );
    }

    const { versionId, created } = await snapshotVersion(db, prompt);
    const embedding = await voyageEmbed(env, proposal.newText);
    const newVersion = prompt.version + 1;
    const res = await db.collection("prompts").updateOne(
      { _id: prompt._id, version: prompt.version },
      {
        $set: {
          [`fragments.${idx}.text`]: proposal.newText,
          [`fragments.${idx}.embedding`]: embedding,
          version: newVersion,
          updatedAt: new Date(),
          updatedBy: "cli",
        },
      }
    );
    if (res.matchedCount !== 1) {
      throw new Error(
        `prompt "${prompt.name}" changed concurrently — approve aborted after snapshot, prompt untouched`
      );
    }
    await db.collection("proposals").updateOne({ _id }, { $set: { status: "applied" } });

    console.log(
      `applied ${_id}: ${prompt.name}.${proposal.target.fragment} — v${prompt.version} -> v${newVersion}`
    );
    console.log(
      `  snapshot ${created ? "created" : "reused"}: prompt_versions ${versionId} (v${prompt.version})`
    );
    console.log("  fragment re-embedded (voyage-3.5-lite)");
    return 0;
  } finally {
    await client.close();
  }
}
