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
import { refNodeId } from "./load.ts";
import type { DepEntry, FwdEntry, Graph, GraphModel, RevEntry } from "./types.ts";

export function buildGraph(model: GraphModel): Graph {
  // rev: toNode -> [{ from, kind, note, confidence }]  (things that depend on toNode)
  // fwd: fromNode -> [{ to, kind, note, confidence }]  (things toNode depends on)
  const rev = new Map<string, RevEntry[]>();
  const fwd = new Map<string, FwdEntry[]>();
  for (const edge of model.edges) {
    const from = refNodeId(edge.from);
    const to = refNodeId(edge.to);
    if (!rev.has(to)) rev.set(to, []);
    rev.get(to)!.push({
      from,
      kind: edge.kind,
      note: edge.note,
      confidence: edge.confidence,
    });
    if (!fwd.has(from)) fwd.set(from, []);
    fwd.get(from)!.push({
      to,
      kind: edge.kind,
      note: edge.note,
      confidence: edge.confidence,
    });
  }

  const promptNames = new Set(model.prompts.keys());

  // Local-fragment node -> owning prompt, else null.
  const owningPrompt = (node: string): string | null => {
    const dot = node.indexOf(".");
    if (dot === -1) return null;
    const head = node.slice(0, dot);
    return promptNames.has(head) ? head : null;
  };

  // prompt -> its local-fragment node ids (a prompt "contains" its fragments,
  // so it depends on whatever they depend on).
  const localFragments = new Map<string, string[]>();
  for (const [name, prompt] of model.prompts) {
    localFragments.set(
      name,
      (prompt.fragments || []).map((f) => `${name}.${f.key}`)
    );
  }

  return { rev, fwd, promptNames, owningPrompt, localFragments };
}

// All nodes affected when `start` changes. Returns ordered entries:
//   { node, kind, via: [path...], confidence?, note? }
// kind is the connecting edge's kind ("uses" | "semantic") or "contains" for the
// prompt reached through one of its local fragments.
export function dependentsOf(graph: Graph, start: string): DepEntry[] {
  const result: DepEntry[] = [];
  const seen = new Set([start]);
  const queue: { node: string; via: string[] }[] = [{ node: start, via: [start] }];

  while (queue.length) {
    const cur = queue.shift()!;

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

// Everything `start` depends on (forward walk). Entering a prompt node also
// descends into its local fragments ("contains"), so a prompt's dependencies
// include what its local fragments semantically depend on.
export function dependenciesOf(graph: Graph, start: string): DepEntry[] {
  const result: DepEntry[] = [];
  const seen = new Set([start]);
  const queue: { node: string; via: string[] }[] = [{ node: start, via: [start] }];

  while (queue.length) {
    const cur = queue.shift()!;

    for (const dep of graph.fwd.get(cur.node) || []) {
      if (seen.has(dep.to)) continue;
      seen.add(dep.to);
      const entry = {
        node: dep.to,
        kind: dep.kind,
        note: dep.note,
        confidence: dep.confidence,
        via: [...cur.via, dep.to],
      };
      result.push(entry);
      queue.push(entry);
    }

    for (const frag of graph.localFragments.get(cur.node) || []) {
      if (seen.has(frag)) continue;
      seen.add(frag);
      // Local fragments are part of the prompt — traverse through them but
      // only report ones that lead somewhere (kind "contains" entries with
      // outgoing edges are still traversal steps, so include them).
      const entry = { node: frag, kind: "contains", via: [...cur.via, frag] };
      queue.push(entry);
      if ((graph.fwd.get(frag) || []).length > 0) result.push(entry);
    }
  }

  return result;
}
