// `uberprompt affected [--base <ref>] [--staged] [--json]`
// Map git-changed prompt/fragment files to graph nodes, then report the
// affected dependents of each changed node. Informational — always exits 0.
import { execFileSync } from "node:child_process";
import { relative, join } from "node:path";
import { loadModel } from "./load.mjs";
import { buildGraph, dependentsOf } from "./graph.mjs";

function git(repoRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function changedFiles(repoRoot, base, staged) {
  const args = ["diff", "--name-only"];
  if (staged) args.push("--cached");
  else args.push(base);
  const out = git(repoRoot, args);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

// Parse an old version of a file from git; null if missing/unparseable.
function oldDoc(repoRoot, ref, relPath) {
  const out = git(repoRoot, ["show", `${ref}:${relPath}`]);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Which changed graph nodes does this run touch?
export function changedNodes(model, repoRoot, base, staged) {
  const files = changedFiles(repoRoot, base, staged);
  const showRef = staged ? "HEAD" : base;
  const nodes = []; // { node, reason }

  for (const file of files) {
    const rel = relative(model.dir, join(repoRoot, file));
    if (rel.startsWith("..")) continue; // outside the demo dir

    const parts = rel.split("/");
    if (parts.length !== 2 || !parts[1].endsWith(".json")) continue;
    const key = parts[1].replace(/\.json$/, "");

    if (parts[0] === "fragments") {
      nodes.push({ node: key, reason: "shared fragment text changed" });
    } else if (parts[0] === "prompts") {
      const prompt = model.prompts.get(key);
      const before = oldDoc(repoRoot, showRef, file);
      if (!prompt || !before || !Array.isArray(before.fragments)) {
        // new / unparseable -> treat whole prompt as changed
        nodes.push({ node: key, reason: "prompt changed (whole)" });
        continue;
      }
      const beforeText = new Map(
        (before.fragments || []).map((f) => [f.key, f.text || ""])
      );
      let anyLocal = false;
      for (const f of prompt.fragments || []) {
        if ((f.text || "") !== (beforeText.get(f.key) || "")) {
          nodes.push({
            node: `${key}.${f.key}`,
            reason: `local fragment "${f.key}" text changed`,
          });
          anyLocal = true;
        }
      }
      if (!anyLocal) {
        nodes.push({ node: key, reason: "prompt changed" });
      }
    }
  }
  return nodes;
}

export function runAffected(dir, repoRoot, opts) {
  const base = opts.base || "HEAD";
  const staged = !!opts.staged;
  const model = loadModel(dir);
  const graph = buildGraph(model);

  const changed = changedNodes(model, repoRoot, base, staged);

  const report = changed.map((c) => ({
    changed: c.node,
    reason: c.reason,
    affected: dependentsOf(graph, c.node).map((e) => ({
      node: e.node,
      kind: e.kind,
      via: e.via.join(" -> "),
      confidence: e.confidence,
    })),
  }));

  if (opts.json) {
    console.log(JSON.stringify({ base: staged ? "staged" : base, report }, null, 2));
    return 0;
  }

  if (report.length === 0) {
    console.log(
      `No prompt or fragment changes detected (${staged ? "staged" : base}).`
    );
    return 0;
  }

  for (const r of report) {
    console.log(`\nchanged: ${r.changed}  (${r.reason})`);
    if (r.affected.length === 0) {
      console.log("  (no dependents)");
      continue;
    }
    for (const a of r.affected) {
      const conf =
        a.confidence != null ? ` conf=${a.confidence.toFixed(2)}` : "";
      const mark = a.kind === "semantic" ? " ⚠" : "";
      console.log(`  -> ${a.node}  [${a.kind}${conf}]${mark}   via ${a.via}`);
    }
  }
  console.log("");
  return 0;
}
