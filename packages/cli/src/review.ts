import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, ObjectId } from "mongodb";
import { loadEnv, requireEnv, connect, parseObjectId } from "./store.ts";
import type { Fragment, ProposalDoc } from "./types.ts";

function workspaceRoot(fallback: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "..", "..");
  return existsSync(join(candidate, "packages", "sdk")) ? candidate : fallback;
}

async function loadPending(db: Db, _id: ObjectId): Promise<ProposalDoc> {
  const proposal = await db.collection<ProposalDoc>("proposals").findOne({ _id });
  if (!proposal) throw new Error(`proposal ${_id} not found`);
  if (proposal.status !== "pending") {
    throw new Error(`proposal ${_id} is "${proposal.status}", not pending`);
  }
  return proposal;
}

export async function runReject(repoRoot: string, id: string | undefined): Promise<number> {
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

function bridgeApprove(cliRoot: string, id: string): Promise<number> {
  const root = workspaceRoot(cliRoot);
  const sdkDir = join(root, "packages", "sdk");
  const entry = join(sdkDir, "scripts", "approve.ts");
  if (!existsSync(entry)) {
    console.error(`missing ${entry} — run pnpm install at the repo root first`);
    return Promise.resolve(1);
  }

  const envFile = join(root, ".env");
  const args = ["--config.verify-deps-before-run=false", "exec", "tsx"];
  if (existsSync(envFile)) args.push(`--env-file=${envFile}`);
  args.push(entry, id);

  return new Promise((done) => {
    const child = spawn("pnpm", args, { cwd: sdkDir, stdio: "inherit" });
    child.on("exit", (code) => done(code ?? 0));
    child.on("error", (err) => {
      console.error(`failed to start: ${err.message}`);
      done(1);
    });
  });
}

export async function runApprove(
  cliRoot: string,
  id: string | undefined,
  opts: { "no-sync"?: boolean; model?: string } = {}
): Promise<number> {
  if (!id) throw new Error("usage: uberprompt approve <proposalId>");
  const code = await bridgeApprove(cliRoot, id);
  if (code !== 0 || opts["no-sync"]) return code;

  const env = loadEnv(cliRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB"]);
  const _id = await parseObjectId(id);
  const { client, db } = await connect(env);
  let applied: {
    promptName: string;
    fragmentKey: string;
    oldText: string;
    newText: string;
    refId: unknown;
  };
  try {
    const proposal = await db.collection<ProposalDoc>("proposals").findOne({ _id });
    if (!proposal || proposal.status !== "applied") {
      throw new Error(`proposal ${id} not marked applied after approve — sync check skipped`);
    }
    if (!proposal.target.fragment) {
      throw new Error(`proposal ${id} has no target fragment — sync check skipped`);
    }
    const snapshot = await db
      .collection<{ promptName: string; version: number; fragments: Fragment[] }>("prompt_versions")
      .find({ promptName: proposal.target.prompt })
      .sort({ version: -1 })
      .limit(1)
      .next();
    applied = {
      promptName: proposal.target.prompt,
      fragmentKey: proposal.target.fragment,
      oldText: proposal.oldText,
      newText: proposal.newText,
      refId: snapshot?._id ?? null,
    };
  } finally {
    await client.close();
  }
  const { runSyncCheck } = await import("./sync-check.ts");
  return runSyncCheck(cliRoot, applied.promptName, applied.fragmentKey, applied.newText, {
    oldText: applied.oldText,
    refId: applied.refId,
    model: opts.model,
  });
}
