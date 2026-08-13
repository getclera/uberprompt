// 2D terminal graph map — prompts (and their local fragments) on the left,
// shared fragments on the right, each fragment routed as its own colored
// vertical "bus" in between. Junction glyphs come from a per-cell NSEW
// bitmask so merges (├ ┬ ╮ …) and crossings (┼) fall out automatically.
import { makePalette } from "./render.ts";
import { refNodeId } from "./load.ts";
import type { Palette, RenderModel } from "./types.ts";

const N = 1, S = 2, E = 4, W = 8;
const GLYPH: Record<number, string> = {
  1: "╵", 2: "╷", 3: "│", 4: "╶", 5: "╰", 6: "╭", 7: "├",
  8: "╴", 9: "╯", 10: "╮", 11: "┤", 12: "─", 13: "┴", 14: "┬", 15: "┼",
};
const NET_COLORS = [32, 33, 34, 35, 36, 31];

interface Row {
  id: string;
  text: string;
  plain: string;
}

interface MapEdge {
  to: string;
  kind: string;
}

interface Source {
  from: string;
  kind: string;
}

function stripLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function leftRows(promptOrder: string[], fwd: Map<string, MapEdge[]>, c: Palette): (Row | null)[] {
  const rows: (Row | null)[] = [];
  for (const name of promptOrder) {
    rows.push({ id: name, text: c.cyan(c.bold(name)), plain: name });
    const locals = [...fwd.keys()]
      .filter((k) => k.startsWith(name + "."))
      .sort();
    for (const local of locals) {
      const key = local.slice(name.length + 1);
      rows.push({
        id: local,
        text: "  " + c.magenta(key) + " " + c.dim("⚠"),
        plain: "  " + key + " ⚠",
      });
    }
    rows.push(null);
  }
  while (rows.length && rows[rows.length - 1] === null) rows.pop();
  return rows;
}

export function renderMap(model: RenderModel, opts: { colors?: boolean } = {}): string {
  const c = makePalette(opts.colors ?? false);
  const net = (i: number) => (s: string) =>
    opts.colors ? `\x1b[${NET_COLORS[i % NET_COLORS.length]!}m${s}\x1b[0m` : s;

  const fwd = new Map<string, MapEdge[]>();
  for (const edge of model.edges) {
    const from = refNodeId(edge.from);
    if (!fwd.has(from)) fwd.set(from, []);
    fwd.get(from)!.push({ to: refNodeId(edge.to), kind: edge.kind });
  }
  for (const [from, outs] of [...fwd]) {
    if (from.includes(".") && !outs.some((o) => o.kind === "semantic")) {
      fwd.delete(from);
    }
  }

  const fragments = [...model.fragments.keys()].sort();
  const promptTargets = new Map<string, string[]>();
  for (const [from, outs] of fwd) {
    const owner = from.includes(".") ? from.slice(0, from.indexOf(".")) : from;
    if (!promptTargets.has(owner)) promptTargets.set(owner, []);
    promptTargets.get(owner)!.push(...outs.map((o) => o.to));
  }

  let promptOrder = [...model.prompts.keys()].sort();
  let rows: (Row | null)[] = [];
  let rowOf = new Map<string, number>();
  let barycenter: (f: string) => number = () => 0;
  const avg = (xs: number[], fallback: number): number =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback;

  const sources = new Map<string, Source[]>(
    fragments.map((f): [string, Source[]] => [f, []])
  );
  const rebuild = () => {
    rows = leftRows(promptOrder, fwd, c);
    rowOf = new Map<string, number>();
    rows.forEach((r, i) => r && rowOf.set(r.id, i));
    for (const f of fragments) sources.get(f)!.length = 0;
    for (const [from, outs] of fwd) {
      for (const out of outs) {
        if (sources.has(out.to) && rowOf.has(from)) {
          sources.get(out.to)!.push({ from, kind: out.kind });
        }
      }
    }
    barycenter = (f: string) =>
      avg(sources.get(f)!.map((s) => rowOf.get(s.from)!), rows.length);
  };

  rebuild();
  for (let sweep = 0; sweep < 3; sweep++) {
    fragments.sort((a, b) => barycenter(a) - barycenter(b) || (a < b ? -1 : 1));
    const fragIdx = new Map(fragments.map((f, i) => [f, i]));
    promptOrder = [...promptOrder].sort((a, b) => {
      const ka = avg((promptTargets.get(a) || []).map((t) => fragIdx.get(t)!), fragments.length);
      const kb = avg((promptTargets.get(b) || []).map((t) => fragIdx.get(t)!), fragments.length);
      return ka - kb || (a < b ? -1 : 1);
    });
    rebuild();
  }
  fragments.sort((a, b) => barycenter(a) - barycenter(b) || (a < b ? -1 : 1));

  const free: number[] = [];
  for (let y = 0; y < rows.length + 2 * fragments.length; y++) {
    if (!rows[y]) free.push(y);
  }
  const fragRow = new Map<string, number>();
  for (const f of fragments) {
    const b = barycenter(f);
    free.sort((p, q) => Math.abs(p - b) - Math.abs(q - b) || p - q);
    fragRow.set(f, free.shift()!);
  }
  const height = Math.max(rows.length, ...fragRow.values()) + 1;

  const leftW = Math.max(...rows.map((r) => (r ? stripLen(r.plain) : 0))) + 1;
  const busX = new Map<string, number>(
    fragments.map((f, i): [string, number] => [f, leftW + 2 + i * 3])
  );
  const rightX = leftW + 2 + fragments.length * 3 + 1;

  const bits = new Map<number, number>();
  const color = new Map<number, number>();
  const junctions = new Set<number>();
  const key = (x: number, y: number) => y * 10000 + x;
  const add = (x: number, y: number, b: number, ci: number, isBus: boolean) => {
    const k = key(x, y);
    bits.set(k, (bits.get(k) || 0) | b);
    if (isBus || !color.has(k)) color.set(k, ci);
  };
  const hline = (y: number, x1: number, x2: number, ci: number) => {
    for (let x = x1; x <= x2; x++) {
      add(x, y, (x > x1 ? W : 0) | (x < x2 ? E : 0), ci, false);
    }
  };

  fragments.forEach((f, i) => {
    const fr = fragRow.get(f)!;
    const bx = busX.get(f)!;
    const rowsTouched = [fr, ...sources.get(f)!.map((s) => rowOf.get(s.from)!)];
    const lo = Math.min(...rowsTouched);
    const hi = Math.max(...rowsTouched);
    for (let y = lo; y <= hi; y++) {
      add(bx, y, (y > lo ? N : 0) | (y < hi ? S : 0), i, true);
    }
    for (const src of sources.get(f)!) {
      const y = rowOf.get(src.from)!;
      hline(y, stripLen((rows[y] as Row).plain) + 1, bx, i);
      add(bx, y, W, i, true);
      junctions.add(key(bx, y));
    }
    hline(fr, bx, rightX - 2, i);
    add(bx, fr, E, i, true);
  });

  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    const label = row ? row.text : "";
    let line = label;
    let cursor = row ? stripLen(row.plain) : 0;
    const maxX = rightX - 1;
    for (let x = cursor; x <= maxX; x++) {
      const k = key(x, y);
      if (!bits.has(k)) line += " ";
      else if (bits.get(k) === 15 && junctions.has(k)) line += net(color.get(k)!)("●");
      else line += net(color.get(k)!)(GLYPH[bits.get(k)!] ?? "");
    }
    const f = fragments.find((fr) => fragRow.get(fr) === y);
    if (f) {
      const i = fragments.indexOf(f);
      line += net(i)("▶ ") + net(i)(f);
    }
    lines.push(line.replace(/\s+$/, ""));
  }

  const declared = model.edges.filter((e) => e.kind === "uses").length;
  const semantic = model.edges.filter((e) => e.kind === "semantic").length;
  const header =
    `Prompt dependency graph — ${model.prompts.size} prompts, ` +
    `${model.fragments.size} shared fragments (${declared} uses, ${semantic} semantic)`;
  const legend = c.dim(
    "left: prompts + local fragments (⚠ = semantic source) · right: shared fragments · ▶ = depends on"
  );
  return header + "\n" + legend + "\n\n" + lines.join("\n") + "\n";
}
