import {
  edgesCol,
  embed,
  promptsCol,
  promptVersionsCol,
  proposalsCol,
  type EdgeDoc,
  type PromptDoc,
  type PromptFragment,
} from "@uberprompt/sdk";
import { proposeConsistencyFix } from "./claude";

const DEBOUNCE_MS = 30_000;
const POLL_MS = 3_000;
const SEMANTIC_MIN_SCORE = 0.75;

const lastHandled = new Map<string, number>();

export async function startConsistencyLoop(): Promise<void> {
  try {
    const stream = promptsCol().watch(
      [{ $match: { operationType: { $in: ["update", "replace"] } } }],
      { fullDocument: "updateLookup" },
    );
    console.log("[consistency] watching prompts via change stream");
    for await (const change of stream) {
      const doc = "fullDocument" in change ? change.fullDocument : undefined;
      if (doc) {
        handlePromptUpdate(doc).catch((err) => console.error("[consistency] ERROR handling update:", err));
      }
    }
  } catch (err) {
    console.error("[consistency] change stream unavailable, falling back to 3s polling:", err);
    await pollPrompts();
  }
}

async function pollPrompts(): Promise<void> {
  let lastSeen = new Date();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const updated = await promptsCol().find({ updatedAt: { $gt: lastSeen } }).toArray();
      lastSeen = new Date();
      for (const doc of updated) {
        handlePromptUpdate(doc).catch((err) => console.error("[consistency] ERROR handling update:", err));
      }
    } catch (err) {
      console.error("[consistency] ERROR polling prompts:", err);
    }
  }
}

async function handlePromptUpdate(doc: PromptDoc): Promise<void> {
  const last = lastHandled.get(doc.name) ?? 0;
  if (Date.now() - last < DEBOUNCE_MS) {
    console.log(`[consistency] debounced update to "${doc.name}" (within 30s)`);
    return;
  }
  lastHandled.set(doc.name, Date.now());
  console.log(`[consistency] prompt "${doc.name}" updated to v${doc.version}`);

  const previous = await promptVersionsCol().findOne({ promptName: doc.name, version: doc.version - 1 });
  if (!previous) {
    console.log(`[consistency] no previous snapshot for "${doc.name}" v${doc.version - 1}, skipping`);
    return;
  }

  const prevByKey = new Map(previous.fragments.map((f) => [f.key, f.text]));
  const changed = doc.fragments.filter((f) => prevByKey.has(f.key) && prevByKey.get(f.key) !== f.text);
  if (changed.length === 0) {
    console.log(`[consistency] no fragment text changes in "${doc.name}"`);
    return;
  }

  for (const fragment of changed) {
    const oldText = prevByKey.get(fragment.key) ?? "";
    console.log(`[consistency] fragment "${doc.name}.${fragment.key}" changed, finding dependents`);
    await processEditedFragment(doc, fragment, oldText).catch((err) =>
      console.error(`[consistency] ERROR processing "${doc.name}.${fragment.key}":`, err),
    );
  }
}

async function processEditedFragment(doc: PromptDoc, fragment: PromptFragment, oldText: string): Promise<void> {
  const structural = await edgesCol()
    .find({
      "to.prompt": doc.name,
      $or: [{ "to.fragment": { $exists: false } }, { "to.fragment": fragment.key }],
    })
    .toArray();
  const dependents = new Set(structural.map((e) => e.from.prompt).filter((p) => p !== doc.name));
  console.log(`[consistency] ${dependents.size} structural dependent(s): ${[...dependents].join(", ") || "none"}`);

  const vector = fragment.embedding ?? (await embed(fragment.text));
  const semantic = await findSemanticDependents(doc.name, vector);
  for (const hit of semantic) {
    console.log(`[consistency] semantic dependent "${hit.prompt}.${hit.fragment}" (score ${hit.score.toFixed(3)})`);
    dependents.add(hit.prompt);
    await ensureSemanticEdge(
      { prompt: doc.name, fragment: fragment.key },
      { prompt: hit.prompt, fragment: hit.fragment },
    );
  }

  for (const dependentName of dependents) {
    await proposeFixFor(doc, fragment, oldText, dependentName).catch((err) =>
      console.error(`[consistency] ERROR proposing fix for "${dependentName}":`, err),
    );
  }
}

interface SemanticHit {
  prompt: string;
  fragment: string;
  score: number;
}

async function findSemanticDependents(editedPrompt: string, vector: number[]): Promise<SemanticHit[]> {
  try {
    const results = await promptsCol()
      .aggregate<{ name: string; fragments: PromptFragment[]; score: number }>([
        {
          $vectorSearch: {
            index: "fragments_embedding",
            path: "fragments.embedding",
            queryVector: vector,
            numCandidates: 100,
            limit: 6,
          },
        },
        { $project: { name: 1, fragments: 1, score: { $meta: "vectorSearchScore" } } },
      ])
      .toArray();
    return results
      .filter((r) => r.name !== editedPrompt && r.score > SEMANTIC_MIN_SCORE)
      .slice(0, 5)
      .map((r) => ({ prompt: r.name, fragment: closestFragmentKey(r.fragments, vector), score: r.score }));
  } catch (err) {
    console.error("[consistency] ERROR in $vectorSearch (Atlas index missing?), structural only:", err);
    return [];
  }
}

function closestFragmentKey(fragments: PromptFragment[], vector: number[]): string {
  let bestKey = fragments[0]?.key ?? "";
  let bestSim = -Infinity;
  for (const f of fragments) {
    if (!f.embedding) continue;
    const sim = cosine(f.embedding, vector);
    if (sim > bestSim) {
      bestSim = sim;
      bestKey = f.key;
    }
  }
  return bestKey;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function ensureSemanticEdge(from: EdgeDoc["from"], to: EdgeDoc["to"]): Promise<void> {
  const existing = await edgesCol().findOne({
    "from.prompt": from.prompt,
    "from.fragment": from.fragment,
    "to.prompt": to.prompt,
    "to.fragment": to.fragment,
  });
  if (existing) return;
  await edgesCol().insertOne({ from, to, kind: "semantic", note: "agent-discovered via vector search" });
  console.log(`[consistency] inserted semantic edge ${from.prompt}.${from.fragment} -> ${to.prompt}.${to.fragment}`);
}

async function proposeFixFor(
  doc: PromptDoc,
  fragment: PromptFragment,
  oldText: string,
  dependentName: string,
): Promise<void> {
  const dependent = await promptsCol().findOne({ name: dependentName });
  if (!dependent) {
    console.error(`[consistency] dependent prompt "${dependentName}" not found`);
    return;
  }
  const fix = await proposeConsistencyFix({
    editedPrompt: doc.name,
    editedFragment: fragment.key,
    oldText,
    newText: fragment.text,
    dependent: { name: dependent.name, fragments: dependent.fragments.map((f) => ({ key: f.key, text: f.text })) },
  });
  if (!fix.fragment) {
    console.log(`[consistency] "${dependentName}" needs no change (${fix.reason})`);
    return;
  }
  const target = dependent.fragments.find((f) => f.key === fix.fragment);
  if (!target) {
    console.error(`[consistency] Claude picked unknown fragment "${fix.fragment}" in "${dependentName}"`);
    return;
  }
  if (target.text === fix.newText) {
    console.log(`[consistency] proposed text for "${dependentName}.${fix.fragment}" is unchanged, skipping`);
    return;
  }
  const duplicate = await proposalsCol().findOne({
    "target.prompt": dependentName,
    "target.fragment": fix.fragment,
    newText: fix.newText,
    status: "pending",
  });
  if (duplicate) {
    console.log(`[consistency] identical pending proposal exists for "${dependentName}.${fix.fragment}", skipping`);
    return;
  }
  await proposalsCol().insertOne({
    target: { prompt: dependentName, fragment: fix.fragment },
    oldText: target.text,
    newText: fix.newText,
    reason: fix.reason,
    source: { type: "consistency" },
    status: "pending",
    ts: new Date(),
  });
  console.log(`[consistency] PROPOSAL filed for "${dependentName}.${fix.fragment}": ${fix.reason}`);
}
