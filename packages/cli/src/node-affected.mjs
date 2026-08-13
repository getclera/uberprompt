// `uberprompt affected <node>` — node mode: given one prompt / shared fragment /
// prompt.fragment, report what depends on it (downstream, affected when it
// changes) and what it depends on (upstream), with the backing files.
import { relative, join } from "node:path";
import { buildGraph, dependentsOf, dependenciesOf } from "./graph.mjs";

// Map a graph node to its backing file (repo-relative).
export function nodeFile(model, repoRoot, node) {
  const dot = node.indexOf(".");
  const head = dot === -1 ? node : node.slice(0, dot);
  let abs;
  if (model.prompts.has(head)) abs = join(model.promptsDir, `${head}.json`);
  else if (model.fragments.has(node)) abs = join(model.fragmentsDir, `${node}.json`);
  else return null;
  return relative(repoRoot, abs);
}

// Resolve user input to a node id; returns { node } or { error, suggestions }.
export function resolveNode(model, input) {
  if (model.prompts.has(input) || model.fragments.has(input)) return { node: input };
  const dot = input.indexOf(".");
  if (dot !== -1) {
    const [p, f] = [input.slice(0, dot), input.slice(dot + 1)];
    const prompt = model.prompts.get(p);
    if (prompt && (prompt.fragments || []).some((x) => x.key === f)) return { node: input };
  }
  const all = [
    ...model.prompts.keys(),
    ...model.fragments.keys(),
    ...[...model.prompts.values()].flatMap((p) =>
      (p.fragments || []).map((f) => `${p.name}.${f.key}`)
    ),
  ];
  const needle = input.toLowerCase();
  const suggestions = all.filter((n) => n.toLowerCase().includes(needle)).slice(0, 5);
  return { error: `unknown prompt or fragment: "${input}"`, suggestions };
}

export function runNodeAffected(model, repoRoot, input, opts) {
  const res = resolveNode(model, input);
  if (res.error) {
    console.error(res.error);
    if (res.suggestions.length) console.error(`did you mean: ${res.suggestions.join(", ")}`);
    return 1;
  }
  const node = res.node;
  const graph = buildGraph(model);
  const decorate = (e) => ({ ...e, file: nodeFile(model, repoRoot, e.node) });
  const affected = dependentsOf(graph, node).map(decorate);
  const dependsOn = dependenciesOf(graph, node).map(decorate);

  if (opts.json) {
    console.log(JSON.stringify(
      { node, file: nodeFile(model, repoRoot, node), affected, dependsOn }, null, 2));
    return 0;
  }

  console.log(`\n${node}  (${nodeFile(model, repoRoot, node) ?? "?"})`);

  console.log(`\naffected by a change to it (${affected.length}):`);
  if (!affected.length) console.log("  (nothing depends on this)");
  for (const a of affected) {
    const conf = a.confidence != null ? ` conf=${a.confidence.toFixed(2)}` : "";
    const mark = a.kind === "semantic" ? " ⚠" : "";
    console.log(`  <- ${a.node}  [${a.kind}${conf}]${mark}  ${a.file ?? ""}`);
    console.log(`       via ${a.via.join(" -> ")}`);
  }

  console.log(`\ndepends on (${dependsOn.length}):`);
  if (!dependsOn.length) console.log("  (no dependencies)");
  for (const d of dependsOn) {
    const conf = d.confidence != null ? ` conf=${d.confidence.toFixed(2)}` : "";
    const mark = d.kind === "semantic" ? " ⚠" : "";
    console.log(`  -> ${d.node}  [${d.kind}${conf}]${mark}  ${d.file ?? ""}`);
  }
  console.log("");
  return 0;
}
