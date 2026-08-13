#!/usr/bin/env node
// uberprompt — dependency graph + semantic-sync CLI for prompt fragments.
import { execFileSync } from "node:child_process";
import { resolve, isAbsolute, join } from "node:path";
import { runGraph } from "../src/graph-cmd.mjs";
import { runAffected } from "../src/affected.mjs";
import { runInfer } from "../src/infer.mjs";
import { runTracing } from "../src/tracing-cmd.mjs";

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
    if (a === "--apply" || a === "--staged" || a === "--json" || a === "--dry-run" || a === "--all") {
      opts[a.slice(2)] = true;
    } else if (a === "--dir" || a === "--base" || a === "--threshold" || a === "--port" || a === "--service" || a === "--model" || a === "--to" || a === "--limit" || a === "--dedup-threshold") {
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
  graph [node]          Render the dependency graph. Without a node: 2D map —
                        prompts left, shared fragments right, colored buses
                        between (● = junction where a line crosses its own bus).
                        With a node: the impact tree of that node.
                          --tree   per-prompt dependency trees instead of the map
                          --json --no-color
  affected [<node>]     With <node> (a prompt, shared fragment, or
                        prompt.fragment): show what depends on it and what it
                        depends on, with backing files.
                        Without <node>: show prompts affected by git-changed
                        prompt/fragment files.
                          --base <ref>   git mode: compare against ref (default HEAD)
                          --staged       git mode: use staged changes
                          --json
  infer                 Ask the model for undeclared semantic edges.
                          --threshold <n>  confidence cutoff (default 0.7)
                          --apply          merge results into edges.json

  init                  Create the trace-ingestion collections and indexes
                        (spans, plus the unique traces.traceId index that the
                        rollup's \$merge depends on).
  collect               Run an OTLP/HTTP receiver; any language, no SDK import.
                        Spans land in the spans collection and roll up into traces.
                          --port <n>       listen port (default 4318)
                          --service <name> fallback service.name
  tail                  Print recent traces, then stream new ones live via a
                        MongoDB change stream.
  compare [prompt]      Per prompt version: traces, error rate, score, latency,
                        tokens - and the version-over-version delta. This is how
                        you see whether a new prompt version actually helped.
                          --json

  learn                 Stage 2: mine recent traces (prioritizing errors and low
                        scores) into durable lessons, embed them via Voyage, and
                        vector-dedup against existing active lessons — a near-
                        duplicate merges its trace ids instead of inserting.
                          --limit <n>            traces to read (default 100)
                          --model <m>            LLM to use (default gpt-5.1)
                          --dedup-threshold <t>  cosine cutoff (default 0.92)
                          --dry-run              print without writing anything

  propose               Consume unprocessed lessons into pending proposals via
                        the targeting ladder (lineage -> catalog -> RAG).
                          --dry-run        print without writing anything
                          --model <m>      LLM to use (default gpt-5.1)
  proposals             List pending proposals with a compact old->new diff.
                          --all            include applied and rejected too
  approve <id>          Apply a proposal: snapshot pre + post versions to
                        prompt_versions, rewrite the fragment, bump the version,
                        re-embed via Voyage, then run the stage-4 sync check.
                          --no-sync        skip the automatic sync check
  reject <id>           Mark a pending proposal rejected.
  sync-check <p[.frag]> Stage 4, manual run (alias: sync; approve and rollback
                        trigger it automatically): diff the prompt's current
                        version against its latest prompt_versions snapshot,
                        walk the Mongo edges graph for dependents of each
                        changed fragment, discover undeclared semantic edges
                        via \$vectorSearch (cosine >= 0.80, top 5, persisted
                        with confidence), LLM-check each dependent for
                        contradiction, and file source "sync-check" proposals
                        for the ones that broke.
                          --dry-run        print without writing anything
                          --model <m>      LLM to use (default gpt-5.1)
  rollback <prompt>     Restore a prompt from a prompt_versions snapshot as a
                        NEW version (history stays append-only): snapshot the
                        current state, restore fragments + template, bump the
                        version, re-embed changed fragments, run the sync check.
                          --to <version>   snapshot to restore (default: previous)
                          --dry-run        print without writing anything
                          --no-sync        skip the automatic sync check
  reembed               Re-embed every stored vector (prompt fragments,
                        descriptions, lessons) via the current Voyage endpoint,
                        then verify known-good similarity pairs. Run after an
                        embedding-space drift.
                          --dry-run        list what would be re-embedded

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
      if (opts._[1]) {
        const { runNodeAffected } = await import("../src/node-affected.mjs");
        const { loadModel } = await import("../src/load.mjs");
        return runNodeAffected(loadModel(dir), root, opts._[1], opts);
      }
      return runAffected(dir, root, opts);
    case "infer":
      return await runInfer(dir, root, opts);
    case "init":
    case "collect":
    case "tail":
    case "compare":
      return await runTracing(cmd, root, opts);
    case "learn": {
      const { runLearn } = await import("../src/learn.mjs");
      return await runLearn(root, opts);
    }
    case "propose": {
      const { runPropose } = await import("../src/propose.mjs");
      return await runPropose(root, opts);
    }
    case "proposals": {
      const { runProposals } = await import("../src/proposals.mjs");
      return await runProposals(root, opts);
    }
    case "approve": {
      const { runApprove } = await import("../src/review.mjs");
      return await runApprove(root, opts._[1], opts);
    }
    case "reject": {
      const { runReject } = await import("../src/review.mjs");
      return await runReject(root, opts._[1]);
    }
    case "sync":
    case "sync-check": {
      const { runSyncCommand } = await import("../src/sync-check.mjs");
      return await runSyncCommand(root, opts._[1], opts);
    }
    case "rollback": {
      const { runRollback } = await import("../src/rollback.mjs");
      return await runRollback(root, opts._[1], opts);
    }
    case "reembed": {
      const { runReembed } = await import("../src/reembed.mjs");
      return await runReembed(root, opts);
    }
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

main().then(
  (code) => process.exit(code || 0),
  (err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
);
