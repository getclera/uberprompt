# überprompt

**One-liner:** Langfuse-style tracing + prompt management, plus a dependency graph
between prompts and prompt fragments — and an agent loop that keeps the whole graph
semantically in sync. **Pipeline: traces → analyze/learn → apply → semantic check.**

Hackathon: MongoDB "Persistent Context Sprint" (Build Fest, Aug 13 2026). Theme:
agent memory + state + retrieval on one platform. ~4h build, 3 finalists demo live.

## Problem

Prompts in a real AI product are a distributed system: shared tone-of-voice
fragments, duplicated output-format rules, agents whose prompts must agree with
each other. Change one prompt and the others silently drift. And nobody closes the
loop from production traces back into prompt improvements — it's all manual.

## The four main tasks (the pipeline)

### 1. Trace ingestion
Apps call LLMs through the SDK wrapper; every call writes a trace (prompt name +
version, input, output, model, latency, score/error) to Mongo. Dumb, complete,
cheap — this is the raw signal feed.

### 2. Analyze / learn
An agent consumes trace batches and mines what's going wrong / recurring. Output:
**lessons** — durable, embedded memory entries, vector-deduped against existing
lessons. Lessons are knowledge, not yet action.

### 3. Apply to prompts (owner: talwe)
Lessons (or a human edit in the dashboard) become concrete changes:
proposal → approval → new prompt version. The only stage that mutates prompts;
every mutation is versioned (bump + snapshot + re-embed changed fragments).

**Targeting ladder** — where does a lesson belong? (in order, no RAG needed today):
1. **Lineage**: the prompt(s) whose traces produced the lesson (`lesson.appliesTo`).
   Ground truth, works even when the concept is absent from the prompt text.
2. **Catalog reasoning**: LLM reads the full prompt catalog (name, purpose
   description, template, fragment keys) and picks other prompts the lesson
   applies to. Full recall at our scale (<50 prompts); no embedding blind spot.
3. **RAG** (only if the catalog ever outgrows context): vector search over
   embedded *purpose descriptions*, not literal prompt text. Skip for hackathon.

Hygiene: minimal-edit rewrites, skip identical pending proposals, group proposals
per prompt (one approval = one version bump). Apply does NOT walk dependencies —
that's stage 4, triggered by the version bump.

### 4. Semantic sync check (needs the dependency graph)
ONE shared mechanism, built once, fired on every version bump (from any source —
lesson apply, human edit, or a prior sync-check apply):
1. Collect dependents via declared `uses` edges.
2. Collect undeclared dependents via vector search: changed fragment's embedding
   vs all other fragment embeddings (existing-text vs existing-text — the
   absent-concept problem can't occur here). Insert `kind:"semantic"` edges found.
3. LLM checks each dependent fragment for contradiction with the change; minimal
   rewrite → consistency proposal → back through stage 3.
4. Waves repeat, shrinking, until the graph is quiet.

Division of labor: targeting answers "where does this *lesson* belong?"; sync
check answers "what did this *edit* break?". Both emit proposals.

Open questions (default in parens): stage-2 trigger — continuous or on-demand
button (on-demand for the demo); dashboard shows the 4 stages as an explicit
pipeline view (yes).

## Why MongoDB wins the theme

Everything on one platform, no bolt-ons: prompts + versions (documents), dependency
edges (documents), traces (documents), lessons = agent memory (documents +
**Atlas Vector Search** over Voyage embeddings), and **change streams** as the event
bus that wakes the agent. The DB *is* the agent's memory and nervous system.

## Data model — THE CONTRACT (edit here first, then code)

Database `uberprompt`, collections:

```ts
// prompts — current version per name; history in prompt_versions
{ _id, name: string, version: number,
  fragments: [{ key: string, text: string, embedding?: number[] }],
  template: string,            // "{{intro}}\n{{tone}}\n{{task}}" refs fragment keys
  updatedAt: Date, updatedBy: string }

// prompt_versions — immutable snapshots (same shape + { promptName, frozenAt })

// edges — dependency graph
{ _id, from: { prompt: string, fragment?: string },
  to:   { prompt: string, fragment?: string },
  kind: "uses" | "semantic",   // "uses" = declared in SDK; "semantic" = agent-found
  note?: string }

// traces
{ _id, promptName: string, promptVersion: number,
  input: object, output: string,
  meta: { model: string, latencyMs: number, tokens?: object },
  score?: number, error?: string, ts: Date }

// lessons — the agent's persistent memory
{ _id, text: string, embedding: number[],
  sourceTraceIds: ObjectId[], appliesTo: string[],
  status: "active" | "superseded", ts: Date }

// proposals — pending changes awaiting approval
{ _id, target: { prompt: string, fragment?: string },
  oldText: string, newText: string, reason: string,
  source: { type: "lesson" | "sync-check" | "human-edit", ref?: ObjectId },
  status: "pending" | "applied" | "rejected", ts: Date }
```

Vector Search indexes: `fragments_embedding` on `prompts.fragments.embedding`,
`lessons_embedding` on `lessons.embedding` (Voyage, cosine).

## Prompt files (demo source format)

Source of truth for the demo lives as versioned JSON files, seeded into Mongo:

- `apps/demo/fragments/<key>.json` — `{ key, version, text }`; shared fragments,
  canonical (brand-voice, refund-policy, escalation-criteria, output-format).
- `apps/demo/prompts/<name>.json` — `{ name, version, template,
  fragments: [local {key,text}], uses: [shared keys] }`.
- `apps/demo/edges.json` — declared `uses` edges.
- `apps/demo/expected-semantic-edges.json` — ground truth the stage-4 inference
  must discover (e.g. triage-router routing-rules ↔ escalation-criteria;
  escalation-writer context ↔ refund-policy).
- `apps/demo/traces.seed.json` — seed traces (incl. the seeded failures).

Version = integer, bumped on every text change. The seed script inlines shared
fragments into each prompt's `fragments` array to match the Mongo contract shape.
A local fragment with empty `text` is a **runtime input slot** (`{{ticket}}`,
`{{message}}`, …) — embedding and semantic-edge inference skip empty fragments.

## Demo script (~4 min)

1. Prompt graph in the dashboard — 5 support prompts (Acme Cloud), shared fragments, edges.
2. Run the demo app → **stage 1**: traces stream in, some seeded failures.
3. Hit analyze → **stage 2**: agent writes a lesson ("never promise a refund
   amount before checking the account").
4. **Stage 3**: lesson becomes a proposal; approve the diff → new prompt version.
5. **Stage 4**: sync check ripples through the graph, files consistency proposals
   for dependent prompts; approve → graph goes quiet. Rerun app → better output.
6. Close on MongoDB: memory, state, retrieval, events — one platform.

## Scope cuts (4 hours — do not build)

No auth, single tenant, no playground, no eval UI, no OTel. Agent runs as a plain
Node loop; polling fallback if change streams fight us.

## Salvage branches (from the pre-alignment build — reuse, don't rewrite)

`claude/sdk-scaffold` (SDK: types, Mongo client, embeddings, definePrompt,
tracedCall), `claude/sync-agent` (loops — needs restructuring into stages 2+4),
`claude/demo-app` (recruiting prompts + seeded failures). Closed PRs #2/#3 hold
the diffs.
