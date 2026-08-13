// `uberprompt graph [--json]`
// Print each shared fragment with its dependents. Declared "uses" edges are
// plain; discovered "semantic" edges are marked ⚠ with confidence.
import { loadModel } from "./load.mjs";
import { buildGraph, dependentsOf } from "./graph.mjs";

export function runGraph(dir, opts) {
  const model = loadModel(dir);
  const graph = buildGraph(model);

  const shared = [...model.fragments.keys()].sort();

  const report = shared.map((key) => ({
    fragment: key,
    dependents: dependentsOf(graph, key).map((e) => ({
      node: e.node,
      kind: e.kind,
      confidence: e.confidence,
      via: e.via.join(" -> "),
    })),
  }));

  if (opts.json) {
    console.log(JSON.stringify({ fragments: report }, null, 2));
    return 0;
  }

  const declared = model.edges.filter((e) => e.kind === "uses").length;
  const semantic = model.edges.filter((e) => e.kind === "semantic").length;
  console.log(
    `Prompt dependency graph (${declared} declared, ${semantic} semantic edges)`
  );

  for (const r of report) {
    console.log(`\n${r.fragment}`);
    if (r.dependents.length === 0) {
      console.log("  (no dependents)");
      continue;
    }
    for (const d of r.dependents) {
      if (d.kind === "contains") continue; // implicit prompt-ownership, skip in listing
      const conf =
        d.confidence != null ? ` conf=${d.confidence.toFixed(2)}` : "";
      const mark = d.kind === "semantic" ? " ⚠" : "";
      console.log(`  <- ${d.node}  [${d.kind}${conf}]${mark}`);
    }
  }
  console.log("");
  return 0;
}
