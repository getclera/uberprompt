import { loadEnv, requireEnv, connect } from "./store.mjs";

const CONTEXT_WORDS = 5;

export function compactDiff(oldText, newText) {
  const a = oldText.split(/\s+/).filter(Boolean);
  const b = newText.split(/\s+/).filter(Boolean);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const pre = a.slice(Math.max(0, prefix - CONTEXT_WORDS), prefix).join(" ");
  const post = a.slice(a.length - suffix, a.length - suffix + CONTEXT_WORDS).join(" ");
  const oldMid = a.slice(prefix, a.length - suffix).join(" ");
  const newMid = b.slice(prefix, b.length - suffix).join(" ");
  const preEll = prefix > CONTEXT_WORDS ? "… " : "";
  const postEll = a.length - suffix + CONTEXT_WORDS < a.length ? " …" : "";
  const wrap = (mid) =>
    `${preEll}${pre}${pre ? " " : ""}[${mid || "∅"}]${post ? " " : ""}${post}${postEll}`;
  return { removed: wrap(oldMid), added: wrap(newMid) };
}

function renderProposal(p) {
  const target = p.target.fragment
    ? `${p.target.prompt}.${p.target.fragment}`
    : p.target.prompt;
  const source = p.source?.ref ? `${p.source.type} ${p.source.ref}` : p.source?.type;
  const ts = p.ts instanceof Date ? p.ts.toISOString() : String(p.ts);
  const { removed, added } = compactDiff(p.oldText, p.newText);
  console.log(`${p._id}  [${p.status}]  ${target}`);
  console.log(`  source: ${source}  ts: ${ts}`);
  console.log(`  reason: ${p.reason}`);
  console.log(`  - ${removed}`);
  console.log(`  + ${added}`);
}

export async function runProposals(repoRoot, opts) {
  const env = loadEnv(repoRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB"]);
  const { client, db } = await connect(env);
  try {
    const filter = opts.all ? {} : { status: "pending" };
    const docs = await db.collection("proposals").find(filter).sort({ ts: 1 }).toArray();
    if (docs.length === 0) {
      console.log(opts.all ? "No proposals." : "No pending proposals.");
      return 0;
    }
    for (const p of docs) {
      renderProposal(p);
      console.log("");
    }
    console.log(`${docs.length} proposal(s)${opts.all ? "" : " pending"}`);
    return 0;
  } finally {
    await client.close();
  }
}
