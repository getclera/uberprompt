import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, requireEnv, connect, parseObjectId } from "./store.mjs";

function workspaceRoot(fallback) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "..", "..");
  return existsSync(join(candidate, "packages", "sdk")) ? candidate : fallback;
}

async function loadPending(db, _id) {
  const proposal = await db.collection("proposals").findOne({ _id });
  if (!proposal) throw new Error(`proposal ${_id} not found`);
  if (proposal.status !== "pending") {
    throw new Error(`proposal ${_id} is "${proposal.status}", not pending`);
  }
  return proposal;
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

export function runApprove(cliRoot, id) {
  if (!id) throw new Error("usage: uberprompt approve <proposalId>");
  const root = workspaceRoot(cliRoot);
  const sdkDir = join(root, "packages", "sdk");
  const entry = join(sdkDir, "scripts", "approve.ts");
  if (!existsSync(entry)) {
    console.error(`missing ${entry} — run pnpm install at the repo root first`);
    return Promise.resolve(1);
  }

  const envFile = join(root, ".env");
  const args = ["exec", "tsx"];
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
