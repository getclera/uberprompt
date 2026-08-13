#!/usr/bin/env node
// uberprompt — dependency graph + semantic-sync CLI for prompt fragments.
import { execFileSync } from "node:child_process";
import { resolve, isAbsolute, join } from "node:path";
import { runGraph } from "../src/graph-cmd.mjs";
import { runAffected } from "../src/affected.mjs";
import { runInfer } from "../src/infer.mjs";

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

// Hand-rolled arg parsing. Extracts --dir, boolean flags, and --key value pairs.
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply" || a === "--staged" || a === "--json") {
      opts[a.slice(2)] = true;
    } else if (a === "--dir" || a === "--base" || a === "--threshold") {
      opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      // --key=value form
      const eq = a.indexOf("=");
      if (eq !== -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else opts[a.slice(2)] = true;
    } else {
      opts._.push(a);
    }
  }
  if (opts.threshold != null) opts.threshold = Number(opts.threshold);
  return opts;
}

function resolveDir(root, dirOpt) {
  if (!dirOpt) return join(root, "apps", "demo");
  return isAbsolute(dirOpt) ? dirOpt : resolve(process.cwd(), dirOpt);
}

const HELP = `uberprompt — prompt-fragment dependency graph + semantic sync

Usage:
  uberprompt <command> [--dir <demo-dir>] [options]

Commands:
  graph                 Print each shared fragment with its dependents.
                          --json
  affected              Show which prompts are affected by git-changed
                        prompt/fragment files.
                          --base <ref>   compare against ref (default HEAD)
                          --staged       use staged changes
                          --json
  infer                 Ask the model for undeclared semantic edges.
                          --threshold <n>  confidence cutoff (default 0.7)
                          --apply          merge results into edges.json
  help                  Show this message.

Global:
  --dir <path>          Demo dir with prompts/, fragments/, edges.json
                        (default: <repo-root>/apps/demo)
`;

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const cmd = opts._[0];
  const root = repoRoot();
  const dir = resolveDir(root, opts.dir);

  switch (cmd) {
    case "graph":
      return runGraph(dir, opts);
    case "affected":
      return runAffected(dir, root, opts);
    case "infer":
      return await runInfer(dir, root, opts);
    case "help":
    case undefined:
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      return 1;
  }
}

main().then((code) => process.exit(code || 0));
