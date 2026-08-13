// `uberprompt graph [node] [--json] [--no-color]`
// Without a node: render every prompt as a dependency tree (forward edges).
// With a node: render the impact tree — everything affected when it changes.
import { loadModel, refNodeId } from "./load.ts";
import { buildGraph, dependentsOf } from "./graph.ts";
import {
  renderPromptForest,
  renderImpactTree,
  colorsEnabled,
} from "./render.ts";
import { renderMap } from "./map.ts";
import type { CliOpts, Model } from "./types.ts";

function knownNodes(model: Model): Set<string> {
  const nodes = new Set([...model.fragments.keys(), ...model.prompts.keys()]);
  for (const prompt of model.prompts.values()) {
    for (const frag of prompt.fragments || []) {
      nodes.add(`${prompt.name}.${frag.key}`);
    }
  }
  for (const edge of model.edges) {
    nodes.add(refNodeId(edge.from));
    nodes.add(refNodeId(edge.to));
  }
  return nodes;
}

export function runGraph(dir: string, opts: CliOpts): number {
  const model = loadModel(dir);
  const graph = buildGraph(model);
  const focus = opts._[1];
  const colors = colorsEnabled(opts);

  if (focus && !knownNodes(model).has(focus)) {
    console.error(`unknown node: ${focus}`);
    console.error(
      `known nodes: ${[...knownNodes(model)].sort().join(", ")}`
    );
    return 1;
  }

  if (opts.json) {
    const targets = focus ? [focus] : [...model.fragments.keys()].sort();
    const report = targets.map((key) => ({
      node: key,
      dependents: dependentsOf(graph, key).map((e) => ({
        node: e.node,
        kind: e.kind,
        confidence: e.confidence,
        via: e.via.join(" -> "),
      })),
    }));
    console.log(JSON.stringify({ nodes: report }, null, 2));
    return 0;
  }

  if (focus) {
    console.log(renderImpactTree(model, graph, focus, { colors }));
    return 0;
  }

  if (opts.tree) {
    const declared = model.edges.filter((e) => e.kind === "uses").length;
    const semantic = model.edges.filter((e) => e.kind === "semantic").length;
    console.log(
      `Prompt dependency graph — ${model.prompts.size} prompts, ` +
        `${model.fragments.size} shared fragments ` +
        `(${declared} uses, ${semantic} semantic)\n`
    );
    console.log(renderPromptForest(model, { colors }));
    return 0;
  }

  console.log(renderMap(model, { colors }));
  return 0;
}
