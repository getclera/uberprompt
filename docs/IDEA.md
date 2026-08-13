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

### 3. Apply to prompts (owner: shlok)
Lessons (or a human edit in the dashboard) become concrete changes:
proposal → approval → new prompt version. The only stage that mutates prompts;
every mutation is versioned (bump + snapshot + re-embed changed fragments).
**Stage 3 itself never writes to `prompts`** — it emits evidence-backed proposals;
the version bump happens on approval.

**Targeting ladder** — where does a lesson belong? (in order, no RAG needed today):
1. **Lineage**: the prompt(s) whose traces produced the lesson (`lesson.appliesTo`).
   Ground truth, works even when the concept is absent from the prompt text.
2. **Catalog reasoning**: LLM reads the full prompt catalog (name, purpose
   description, template, fragment keys) and picks other prompts the lesson
   applies to. Full recall at our scale (<50 prompts); no embedding blind spot.
3. **RAG**: vector search of the lesson embedding over embedded *purpose
   descriptions* (`descriptions_embedding`), not literal prompt text — decided
   IN scope, it's cheap.
**Un-benched and shipped:** the culprit rung (fragment+span fault localization with
declared + undeclared blast radius) and the eval gate (pairwise-judged replay +
golden-set scoring behind the `"evaluating"` status) both run in stage 3 today.

**Eval gate scoring:** the judge scores four axes 1–5, but only **taskFit, tone,
specificity** sum into the win/loss delta (`WIN_AXES`). `lessonAdherence` is
recorded and reported as a diagnostic only — a candidate that merely parrots the
lesson without getting better must not clear the gate.

**Approve has exactly one implementation** — `approveProposal` in
`packages/sdk/src/prompt.ts` (version bump + `contentHash` + re-embed + new-version
`prompt_versions` snapshot + `status: "applied"`, all in one transaction).
`uberprompt approve` bridges to it via `packages/sdk/scripts/approve.ts`; the old
duplicate logic in `packages/cli/src/review.mjs` is gone.

**Stage 3→4 handoff (DECIDED, shipped):** stage 4 is a function call, not a
watcher — after a successful approve bridge (and after `rollback`), the CLI
invokes `runSyncCheck(prompt, fragment, newText)` inline (`--no-sync` opts
out). `uberprompt sync <prompt[.fragment]>` reruns it manually for a bump that
happened without one; it diffs current against the latest snapshot with
`version < current`. Change streams remain optional dashboard sugar, not a
dependency of the loop.

Hygiene: minimal-edit rewrites, skip identical pending proposals, group proposals
per prompt (one approval = one version bump). Apply does NOT walk dependencies —
that's stage 4, triggered by the version bump.

### 4. Semantic sync check (needs the dependency graph) — SHIPPED
ONE shared mechanism (`runSyncCheck` in packages/cli/src/sync.mjs), invoked as
a function call at the end of every version bump (approve, rollback, or a
manual `uberprompt sync`) — NOT a change-stream watcher:
1. Collect dependents via a graph walk over the Mongo `edges` collection
   (declared `uses` + known `semantic`, direct + transitive through shared
   fragments).
2. Collect undeclared dependents via `$vectorSearch` of the changed fragment's
   new embedding against `fragments_embedding` (existing-text vs existing-text
   — the absent-concept problem can't occur here). Cutoff: cosine >= 0.80
   capped at top-5 (0.75 measured too noisy — unrelated fragments hit ~0.75).
   Insert discovered `kind:"semantic"` edges with confidence/model/inferredAt.
3. LLM (gpt-5.1) checks each dependent fragment for contradiction with the
   change; minimal rewrite → `source: sync-check` proposal → back through
   stage 3 (identical pending duplicates skipped).
4. Waves repeat via human approvals, shrinking, until the graph is quiet.
Live convergence run + on-stage transcript: docs/DEMO-RUN.md.

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

### MongoDB features we leverage (beyond basic documents + vector search)

1. **Compound vector search filters** — vector indexes on `lessons` and `prompts`
   include `filter` fields (`status`, `appliesTo`) so stage 3 RAG searches only
   active lessons and can scope by prompt name. Array-of-string filter fields do
   element-match.

2. **$jsonSchema validators** — every collection gets `validationLevel: "strict"`,
   `validationAction: "error"` at creation time. Enforces required fields, bsonType,
   enum constraints (e.g. `status: enum ["ok","error"]` on spans). Catches bad
   inserts immediately — aligns with "error loudly" rule.

3. **TTL indexes** — auto-expire telemetry: spans 30d (`ingestedAt`), traces 90d
   (`ts`). Never TTL lessons (durable memory, lifecycle via `status` field).

4. **Aggregation pipeline for dashboard analytics:**
   - `$facet` — single query powering multiple dashboard panels (latency
     percentiles, error rates, token usage by prompt).
   - `$densify` + `$fill` — zero-filled time series for charts, no client-side
     gap-patching.
   - `$setWindowFields` — rolling 1h avg latency per prompt, moving error rate
     over trailing N traces.
   - `$bucket` — latency distribution histograms.
   - `$percentile` (approximate) — p50/p95/p99 latency in one pass.

5. **`$graphLookup`** — recursive traversal of `edges` collection for stage 4
   transitive dependent discovery. Cycle detection is native (no special code).
   `depthField` maps to sync-check "shrinking waves". Caveat: `$vectorSearch`
   cannot nest inside `$graphLookup` — declared + undeclared dependent discovery
   stays two separate queries composed in app code.

6. **Change streams (resumable)** — resume tokens persisted in a `sync_state`
   collection (stays "one platform"). Use `startAfter` (not `resumeAfter` —
   survives invalidate events). Used by `uberprompt tail` for live trace
   streaming; for stage 4 they are optional dashboard sugar only — the sync
   check itself runs as a function call inside approve. Pipeline filtering
   projects only needed fields to stay under 16MB event limit.

7. **Wildcard indexes** on `spans.attributes` and `spans.resource` — supports
   ad-hoc queries on arbitrary OTel attributes. Prerequisite: sanitize dotted
   OTel keys (e.g. `gen_ai.request.model`) to `gen_ai__request__model` at ingest
   time — MongoDB parses dots as nested path traversal.

8. **Materialized views via `$merge`** — spans→traces rollup (`on: "traceId"`,
   `whenMatched: "replace"`). Second view: per-prompt daily error rates into
   `prompt_error_rates_daily`.

### If time allows

- **Atlas Search + `$rankFusion`** — full-text search indexes on prompt
  fragments, lesson text, and trace outputs. `$rankFusion` (GA on Atlas 8.0+)
  fuses text + vector results via reciprocal rank fusion — upgrades stage 2
  lesson dedup (catches near-duplicates sharing terms but embedding differently)
  and powers a dashboard search bar.

## Data model — THE CONTRACT (edit here first, then code)

Database `uberprompt`, collections:

```ts
// prompts — current version per name; history in prompt_versions
{ _id, name: string, version: number,
  description: string,         // one-line purpose, auto-generated at definePrompt
  descriptionEmbedding?: number[],
  fragments: [{ key: string, text: string, embedding?: number[] }],
  template: string,            // "{{intro}}\n{{tone}}\n{{task}}" refs fragment keys
  updatedAt: Date, updatedBy: string }

// prompt_versions — immutable, append-only snapshots
// (same shape + { promptName, frozenAt, contentHash })
// contentHash = sha256 of { template, fragments:[{key,text}] }, fragments sorted by key
// so the hash tracks content, not the caller's iteration order. Version identity is
// deterministic: re-running definePrompt with unchanged text never bumps a version, and
// takes an early return that skips the description + embedding API calls entirely.
// Legacy docs written before this get their hash backfilled in place, without a bump.

// edges — dependency graph; fragment-only endpoint = shared fragment
// (matches apps/demo/edges.json + expected-semantic-edges.json)
{ _id, from: { prompt?: string, fragment?: string },
  to:   { prompt?: string, fragment?: string },
  kind: "uses" | "semantic",   // "uses" = declared in SDK; "semantic" = agent-found
  note?: string,
  // semantic edges only — inference provenance:
  confidence?: number, model?: string, inferredAt?: Date }

// spans — raw OTel spans, one per LLM call / tool execution / step.
// Written by the OTel SpanExporter (in-process SDK) or the OTLP collector (CLI).
{ _id, traceId: string, spanId: string, parentSpanId?: string,
  name: string,              // "ai.generateText", "ai.generateText.doGenerate", ...
  kind: string, service: string,
  startTime: Date, endTime: Date, durationMs: number,
  status: "ok" | "error", statusMessage?: string,
  genAi?: {                  // hot fields promoted out of GenAI SemConv attributes
    operation?, provider?, requestModel?, responseModel?, responseId?,
    finishReasons?: string[], toolName?, toolCallId?,
    usage?: { inputTokens?, outputTokens?, totalTokens?,
              cacheReadInputTokens?, cacheCreationInputTokens? } },
  prompt?: { name, version, versionId: ObjectId, contentHash },
  input?: unknown, output?: string,  // promoted at normalize time, see note below
  attributes: object,        // raw OTel attrs, dotted keys verbatim
  resource: object, ingestedAt: Date }

// traces — rollup, one per root operation span. Derived from `spans` by an
// aggregation with $merge, so it is idempotent and batch-order independent.
// Every field the earlier flat trace doc had survives, so stage 2 is unaffected —
// except promptName/promptVersion, now optional (an OTLP source may carry no
// prompt binding). Filter on { promptName: { $exists: true } }.
{ _id, traceId: string, service: string, operation: string,
  promptName?: string, promptVersion?: number,
  promptVersionId?: ObjectId,  // FK -> prompt_versions._id
  contentHash?: string,
  input: unknown, output: string,
  meta: { provider?: string, model: string, latencyMs: number, tokens?: object },
  spanCount: number, score?: number, error?: string, ts: Date }

// lessons — the agent's persistent memory
{ _id, text: string, reason?: string, embedding: number[],
  sourceTraceIds: ObjectId[], appliesTo: string[],
  status: "active" | "superseded", processedAt?: Date, ts: Date }

// proposals — pending changes awaiting approval
{ _id, target: { prompt: string, fragment?: string },
  oldText: string, newText: string, reason: string,
  source: { type: "lesson" | "sync-check" | "human-edit", ref?: ObjectId },
  status: "evaluating" | "pending" | "applied" | "rejected", ts: Date,
  culprit?: { fragment: string, span: string,      // span is verbatim from oldText
              traceIds: ObjectId[], sharedWith: string[] },
  evals?: { runIds: ObjectId[], passed: boolean,
            baselineAvg: number, candidateAvg: number } }

// eval_runs — one doc per (proposal, attempt); the evidence behind a proposal
{ _id, proposalId: ObjectId, lessonId: ObjectId | null,
  target: { prompt: string, fragment: string }, attempt: number,
  candidateText: string,
  cases: [{ caseId: string, kind: "replay" | "golden",
            input: object, baselineOutput: string, candidateOutput: string,
            baseline: Rubric, candidate: Rubric,   // Rubric = 4 axes, 1-5 each;
            // delta sums WIN_AXES only (taskFit+tone+specificity), lessonAdherence is diagnostic
            delta: number, verdict: "win" | "tie" | "loss", critique: string }],
  summary: { replayWins: number, replayLosses: number, goldenRegressions: number,
             baselineAvg: number, candidateAvg: number, passed: boolean },
  judgeModel: string, genModel: string, ts: Date }
```

`proposals.status` gains `"evaluating"` (candidate under eval, not yet surfaced).
`"pending"` keeps its meaning — passed the gate, awaiting human approval — so the
dashboard inbox query is unchanged. Eval generations are **never** written to
`traces`: stage 2 would otherwise learn from stage 3's own eval output.

Vector Search indexes (Voyage, cosine): `fragments_embedding` on
`prompts.fragments.embedding`, `lessons_embedding` on `lessons.embedding`,
`descriptions_embedding` on `prompts.descriptionEmbedding`.

### Prompt-version references ("foreign keys")

Mongo enforces no referential integrity — no FK constraints, no cascade, and
`$jsonSchema` validators check shape only, never existence. We get the same guarantee
by construction instead:

- `traces.promptVersionId` / `spans.prompt.versionId` reference `prompt_versions._id`;
  join with `$lookup` (and `$graphLookup` for the stage-4 graph walk).
- `prompt_versions` is immutable and append-only, and the version doc is resolved
  **before** any span can reference it — so a reference can never dangle.
  (Open: whether stage 1 may create a missing version doc or must error and leave all
  writes to stage 3. Decide before `packages/tracing` lands.)
- `promptName` + `promptVersion` + `contentHash` are denormalized onto traces/spans, so
  "group traces by prompt version" (stage 2) needs no join at all.
- Indexes: `prompt_versions {promptName:1, version:1}` unique, `{contentHash:1}`;
  `traces {traceId:1}` unique (the `$merge` key), `{promptName:1, ts:-1}`,
  `{promptVersionId:1, ts:-1}`; `spans {traceId:1, startTime:1}`, `{spanId:1}` unique.

Live Atlas state as of this PR: `spans` does not exist yet, and `traces` has no unique
index on `traceId` — without it `$merge` appends duplicate rollups instead of updating
in place. Both are created by the stage 1 `init` subcommand.

### Trace ingestion — one path, OTLP

Capture is standard OpenTelemetry, so anything that speaks OTLP can feed the graph:

- **SDK:** `registerUberprompt()` wires a `NodeTracerProvider` + `MongoSpanExporter` and
  registers `@ai-sdk/otel`'s integration with AI SDK 7 (`ai@7`'s core has no OTel; the
  integration is the separate `@ai-sdk/otel` package — verified against `ai@7.0.65`).
  Prompt binding rides an `AsyncLocalStorage` via that integration's `enrichSpan` hook,
  stamping `uberprompt.prompt.*` attributes onto every span of the call.
- **CLI:** `uberprompt collect` runs an OTLP/HTTP receiver on :4318 and writes through the
  exact same normalize + rollup core — any language, no SDK import.

Why the rollup is computed in Mongo rather than in the exporter: usage and model live on
child spans, the root span ends last, and export batches arrive in arbitrary order.
Recomputing from `spans` with `$merge` is idempotent and order-independent, and the CLI
collector reuses it unchanged.

**Gotchas found while building this, all verified against `ai@7.0.65` / `@ai-sdk/otel@1.0.65`:**

- Span names follow **GenAI SemConv**, not the old AI SDK names: `invoke_agent`, `chat`,
  `step N`, `execute_tool <name>`. Nothing is called `ai.generateText.doGenerate` anymore.
- **Token usage is double-counted if you naively sum spans.** The root `invoke_agent` span
  carries the whole call's aggregate *and* each child `chat` span carries its own. The
  rollup therefore prefers the root's usage and only falls back to summing children.
- `input`/`output` are promoted onto `SpanDoc` at normalize time rather than read from
  `attributes` in the pipeline, because attribute keys contain literal dots
  (`gen_ai.input.messages`) which Mongo would read as a nested path. Dotted keys also
  cannot be expanded into nested objects, since `ai.prompt` is a string while
  `ai.prompt.messages` also exists — they would collide.
- In AI SDK 7 both `finishReason` and `usage` are **objects**, not scalars:
  `{ unified, raw }` and `{ inputTokens: { total, noCache, cacheRead, cacheWrite }, … }`.
  Returning the old flat shapes from a mock silently yields empty usage.

Package layout for this (extends the Stack section in CLAUDE.md):

```
packages/sdk       shared core — every workstream imports it (types, db, prompt, embeddings)
packages/tracing   ingestion core — normalize, rollup, exporter, register, OTLP decode
packages/cli       existing CLI (felix: infer / affected / graph) — stage 1 adds
                   init / collect / tail as subcommands, logic stays in packages/tracing
```

`tracing` depends on `sdk`; `cli` depends on `tracing`; nothing depends on `cli`. Keeping
ingestion out of `packages/sdk` is deliberate — it keeps stage 1 off the file stage 3 edits.
Note that `packages/cli` is currently plain `.mjs` while the stack is otherwise TypeScript;
stage 1's subcommands stay thin so the language boundary sits at the CLI edge only.

### Interfaces between stages

- Stage 2 → 3: the `lessons` collection IS the interface — stage 2 inserts,
  stage 3 consumes new lessons and stamps `processedAt` after filing proposals.
  `processedAt` is stamped whether the eval gate passed or rejected — a lesson is
  processed once, and the outcome lives on its proposals.
  Trigger: `apply watch` tails a **change stream** on `lessons` and persists the
  **resume token**, so a restart continues from the last lesson it saw instead of
  replaying or skipping. On boot it also drains the backlog (`status: "active"`,
  no `processedAt`), which covers lessons written while it was down. That is the
  no-cold-start property, made concrete.
- Stage 3 targeting tier 3 (RAG): $vectorSearch lesson.embedding against
  `descriptions_embedding` (function-level match, not literal text).
- Dependency interface (fragment-level, used by stage 4):
  `getDependents({prompt, fragment}, {semantic?, minScore?})` → affected targets
  with kind "uses"|"semantic" (+score); semantic mode runs vector discovery and
  persists new semantic edges. Inverse helper: `getDependencies(target)`.
  Diff helper: `diffVersions(promptName, vNew)` → changed fragments old/new text
  (computed from prompt_versions).

## Prompt files (demo seed fixtures)

**DECIDED: prompts live canonically in MongoDB.** The JSON files under
`apps/demo` are seed fixtures only — they bootstrap the DB and never receive
write-back; after seeding, `prompts`/`prompt_versions`/`edges` in Mongo are
the single runtime source of truth (approve/rollback/sync mutate Mongo only,
so the files go stale by design).

The demo crew is **Mango Republic**, a mango wholesaler selling crates/pallets to
supermarkets, juice factories, and restaurants. Six prompts:

| Prompt | Job | Shared `uses` |
|---|---|---|
| `triage-router` | Classifies inbound into `order \| refund \| quality \| escalation`, JSON out | output-format |
| `order-agent` | New orders, reorders, pallet pricing, delivery slots | brand-voice, output-format |
| `refund-agent` | Credit notes / refunds for bad shipments | brand-voice, refund-policy, output-format |
| `quality-agent` | Quality complaints (overripe, cold-chain, wrong grade), ripening advice | brand-voice, output-format |
| `escalation-writer` | Internal escalation summaries for the sales director | brand-voice, escalation-criteria, output-format |
| `satisfaction-summarizer` | Summarizes resolved conversations + sentiment | output-format |

Planted undeclared semantic deps (what stage 4 must infer): `triage-router`'s
local `routing-rules` paraphrases escalation-criteria (incl. the $50k/year churn
threshold); `escalation-writer`'s local `context` restates refund-policy.

The seed fixture files:

- `apps/demo/fragments/<key>.json` — `{ key, version, text }`; shared fragments,
  canonical (brand-voice, refund-policy, escalation-criteria, output-format).
- `apps/demo/prompts/<name>.json` — `{ name, version, template,
  fragments: [local {key,text}], uses: [shared keys] }`.
- `apps/demo/edges.json` — the dependency graph, one central file (mirrors the
  `edges` collection; edges are pair-owned, so no per-prompt storage). Declared
  `uses` edges plus inferred `semantic` edges written by `uberprompt infer`.
- `apps/demo/expected-semantic-edges.json` — ground truth the stage-4 inference
  must discover (e.g. triage-router routing-rules ↔ escalation-criteria;
  escalation-writer context ↔ refund-policy).
- `apps/demo/traces.seed.json` — seed traces (incl. the seeded failures).
- `apps/demo/golden/<prompt-name>.json` — `[{ id, input, intent }]`; the eval gate's
  regression set for that prompt. Lives in-repo next to the prompt it protects, not
  in Mongo: a golden case and the fragment it guards change together.

File-first tooling: `packages/cli` ships the **`uberprompt` CLI** — `infer`
(`gpt-5-nano` infers semantic edges from fragment texts → edges.json), `affected`
(git-diff changed prompt/fragment files → transitive graph walk → impacted
prompts), `graph` (print the graph). The stage-4 agent and the CLI share the
same edges.json semantics.

Version = integer, bumped on every text change. The seed script inlines shared
fragments into each prompt's `fragments` array to match the Mongo contract shape.
A local fragment with empty `text` is a **runtime input slot** (`{{ticket}}`,
`{{message}}`, …) — embedding and semantic-edge inference skip empty fragments.

## Demo script (~4 min)

1. Prompt graph in the dashboard — 6 support prompts (Mango Republic, a mango wholesaler), shared fragments, edges.
2. Run the demo app → **stage 1**: traces stream in, some seeded failures.
3. Hit analyze → **stage 2**: agent writes a lesson ("never promise a credit
   amount before checking the delivery record").
4. **Stage 3**: lesson becomes a proposal; approve the diff → new prompt version.
5. **Stage 4**: sync check ripples through the graph, files consistency proposals
   for dependent prompts; approve → graph goes quiet. Rerun app → better output.
6. Close on MongoDB: memory, state, retrieval, events — one platform.

## Scope cuts (4 hours — do not build)

No auth, single tenant, no playground, no eval UI, no OTel. Agent runs as a plain
Node loop; polling fallback if change streams fight us.

("No eval UI" still holds — the stage-3 eval gate is headless. It writes `eval_runs`
and a summary on the proposal; the dashboard renders that scorecard inside the
existing proposal inbox rather than getting its own eval surface.)

## Salvage branches (from the pre-alignment build — reuse, don't rewrite)

`claude/sdk-scaffold` (SDK: types, Mongo client, embeddings, definePrompt,
tracedCall), `claude/sync-agent` (loops — needs restructuring into stages 2+4),
`claude/demo-app` (recruiting prompts + seeded failures). Closed PRs #2/#3 hold
the diffs.
