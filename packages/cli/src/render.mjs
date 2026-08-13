// Tree rendering for the dependency graph (archy-based).
//
// Two views:
//   prompt forest — every prompt with the fragments it depends on (forward edges)
//   impact tree   — everything affected when one node changes (reverse edges)
//
// The graph is a DAG (diamonds allowed), archy renders trees: a node that was
// already drawn in the current tree is repeated as a leaf marked "↩ shown above"
// instead of re-expanding its subtree.
import archy from "archy";
import { refNodeId } from "./load.mjs";

const CODES = { cyan: 36, green: 32, yellow: 33, magenta: 35, dim: 2, bold: 1 };

export function makePalette(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  const p = {};
  for (const [name, code] of Object.entries(CODES)) p[name] = wrap(code);
  return p;
}

export function colorsEnabled(opts = {}) {
  if (opts["no-color"] || process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

export function buildForward(model) {
  const fwd = new Map();
  for (const edge of model.edges) {
    const from = refNodeId(edge.from);
    if (!fwd.has(from)) fwd.set(from, []);
    fwd.get(from).push({
      to: refNodeId(edge.to),
      kind: edge.kind,
      note: edge.note,
      confidence: edge.confidence,
    });
  }
  return fwd;
}

function nodeKind(model, node) {
  if (model.prompts.has(node)) return "prompt";
  if (model.fragments.has(node)) return "fragment";
  return "local";
}

function nodeLabel(model, node, c) {
  const kind = nodeKind(model, node);
  if (kind === "prompt") return c.cyan(c.bold(node));
  if (kind === "fragment") return c.green(node);
  const dot = node.indexOf(".");
  return c.cyan(node.slice(0, dot)) + "." + c.magenta(node.slice(dot + 1));
}

function edgeSuffix(edge, c) {
  if (edge.kind === "uses") return " " + c.dim("[uses]");
  if (edge.kind === "semantic") {
    const conf = edge.confidence != null ? ` ${edge.confidence.toFixed(2)}` : "";
    return " " + c.yellow(`[semantic${conf} ⚠]`);
  }
  return " " + c.dim(`[${edge.kind}]`);
}

function subtree(model, adjacency, node, edge, c, seen) {
  let label = nodeLabel(model, node, c);
  if (edge) label += edgeSuffix(edge, c);
  if (seen.has(node)) {
    const children = adjacency.get(node) || [];
    if (children.length > 0) label += " " + c.dim("↩ shown above");
    return { label, nodes: [] };
  }
  seen.add(node);
  const nodes = (adjacency.get(node) || []).map((child) =>
    subtree(model, adjacency, childTarget(child), child, c, seen)
  );
  return { label, nodes };
}

const childTarget = (edge) => edge.to ?? edge.from;

export function renderPromptForest(model, opts = {}) {
  const c = makePalette(opts.colors ?? false);
  const fwd = buildForward(model);

  const localsByPrompt = new Map();
  for (const from of fwd.keys()) {
    const dot = from.indexOf(".");
    if (dot === -1) continue;
    const owner = from.slice(0, dot);
    if (!localsByPrompt.has(owner)) localsByPrompt.set(owner, []);
    localsByPrompt.get(owner).push(from);
  }

  const lines = [];
  for (const name of [...model.prompts.keys()].sort()) {
    const seen = new Set([name]);
    const direct = (fwd.get(name) || []).map((edge) =>
      subtree(model, fwd, edge.to, edge, c, seen)
    );
    const locals = (localsByPrompt.get(name) || []).sort().map((local) => {
      const key = local.slice(local.indexOf(".") + 1);
      const children = (fwd.get(local) || []).map((edge) =>
        subtree(model, fwd, edge.to, edge, c, seen)
      );
      return { label: c.magenta(key) + " " + c.dim("(local)"), nodes: children };
    });
    lines.push(archy({ label: nodeLabel(model, name, c), nodes: [...direct, ...locals] }));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function renderImpactTree(model, graph, start, opts = {}) {
  const c = makePalette(opts.colors ?? false);
  const adjacency = {
    get(node) {
      const deps = [...(graph.rev.get(node) || [])];
      const owner = graph.owningPrompt(node);
      if (owner) deps.push({ from: owner, kind: "contains" });
      return deps;
    },
  };
  const seen = new Set([start]);
  const nodes = adjacency
    .get(start)
    .map((edge) => subtree(model, adjacency, edge.from, edge, c, seen));
  const header = nodeLabel(model, start, c) + " " + c.dim("— change ripples to:");
  if (nodes.length === 0) return header + "\n└── " + c.dim("(no dependents)") + "\n";
  return archy({ label: header, nodes });
}
