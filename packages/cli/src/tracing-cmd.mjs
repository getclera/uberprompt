// Bridges the .mjs CLI to the TypeScript ingestion core in packages/tracing.
// The core stays TS (it shares contract types with the SDK); tsx runs it in-process
// so `uberprompt init|collect|tail` behaves like any other subcommand.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = { init: "init.ts", collect: "collect.ts", tail: "tail.ts", compare: "compare.ts" };

// The workspace is found from this file's own location, not from cwd: the CLI is
// installed as a bin and is routinely run from outside the repo, where the caller's
// git-based repoRoot() falls back to cwd and resolves the wrong path.
function workspaceRoot(fallback) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "..", "..");
  return existsSync(join(candidate, "packages", "tracing")) ? candidate : fallback;
}

export function runTracing(command, cliRoot, opts) {
  const script = SCRIPTS[command];
  if (!script) throw new Error(`unknown tracing command: ${command}`);

  const root = workspaceRoot(cliRoot);
  const entry = join(root, "packages", "tracing", "src", "cli", script);
  if (!existsSync(entry)) {
    console.error(`missing ${entry} — run pnpm install at the repo root first`);
    return 1;
  }

  const env = { ...process.env };
  if (opts.port) env.UBERPROMPT_COLLECT_PORT = String(opts.port);
  if (opts.service) env.UBERPROMPT_COLLECT_SERVICE = String(opts.service);
  if (opts._[1]) env.UBERPROMPT_COMPARE_PROMPT = String(opts._[1]);
  if (opts.json) env.UBERPROMPT_COMPARE_JSON = "1";

  const envFile = join(root, ".env");
  const args = ["tsx"];
  if (existsSync(envFile)) args.push(`--env-file=${envFile}`);
  args.push(entry);

  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", ...args], { cwd: root, stdio: "inherit", env });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      console.error(`failed to start: ${err.message}`);
      resolve(1);
    });
  });
}
