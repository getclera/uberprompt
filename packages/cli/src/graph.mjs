// Build the dependency graph from edges and walk it.
//
// Node kinds:
//   shared fragment   "escalation-criteria"
//   prompt            "triage-router"
//   prompt-local frag "triage-router.routing-rules"
//
// An edge from:{prompt,fragment?} to:{fragment} means the FROM-node DEPENDS ON
// the TO-fragment. So the dependents of a shared fragment are the prompts /
// local-fragments whose edges point at it. Transitively: a prompt-local
// fragment belongs to its prompt, so if the local fragment is affected the
// prompt is too.
import { refNodeId } from "./load.mjs";

export function buildGraph(model) {
  // rev: toNode -> [{ from, kind, note, confidence }]  (things that depend on toNode)
  const rev = new Map();
  for (const edge of model.edges) {
    const from = refNodeId(edge.from);
    const to = refNodeId(edge.to);
    if (!rev.has(to)) rev.set(to, []);
    rev.get(to).push({
      from,
      kind: edge.kind,
      note: edge.note,
      confidence: edge.confidence,
    });
  }

  const promptNames = new Set(model.prompts.keys());

  // Local-fragment node -> owning prompt, else null.
  const owningPrompt = (node) => {
    const dot = node.indexOf(".");
    if (dot === -1) return null;
    const head = node.slice(0, dot);
    return promptNames.has(head) ? head : null;
  };

  return { rev, promptNames, owningPrompt };
}

// All nodes affected when `start` changes. Returns ordered entries:
//   { node, kind, via: [path...], confidence?, note? }
// kind is the connecting edge's kind ("uses" | "semantic") or "contains" for the
// prompt reached through one of its local fragments.
export function dependentsOf(graph, start) {
  const result = [];
  const seen = new Set([start]);
  const queue = [{ node: start, via: [start] }];

  while (queue.length) {
    const cur = queue.shift();

    for (const dep of graph.rev.get(cur.node) || []) {
      if (seen.has(dep.from)) continue;
      seen.add(dep.from);
      const entry = {
        node: dep.from,
        kind: dep.kind,
        note: dep.note,
        confidence: dep.confidence,
        via: [...cur.via, dep.from],
      };
      result.push(entry);
      queue.push(entry);
    }

    const owner = graph.owningPrompt(cur.node);
    if (owner && !seen.has(owner)) {
      seen.add(owner);
      const entry = { node: owner, kind: "contains", via: [...cur.via, owner] };
      result.push(entry);
      queue.push(entry);
    }
  }

  return result;
}
