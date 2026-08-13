# überprompt

**One-liner:** Langfuse-style tracing + prompt management, plus a dependency graph
between prompts and prompt fragments — and an agent that keeps the whole graph
semantically consistent. Loop: **traces → analyze → learn → update prompts**.

Hackathon: MongoDB "Persistent Context Sprint" (Build Fest, Aug 13 2026). Theme:
agent memory + state + retrieval on one platform. ~4h build, 3 finalists demo live.

## Problem

Prompts in a real AI product are a distributed system: shared tone-of-voice
fragments, duplicated output-format rules, agents whose prompts must agree with
each other. Change one prompt and the others silently drift. And nobody closes the
loop from production traces back into prompt improvements — it's all manual.

## What we build

1. **SDK** (`packages/sdk`): define prompts composed of named **fragments**, declare
   dependencies between prompts/fragments, render them, and wrap LLM calls so every
   call emits a trace to MongoDB.
2. **Sync agent** (`apps/agent`): a Claude-powered loop watching MongoDB change
   streams. Two triggers:
   - **Consistency loop** — a prompt/fragment is edited → agent walks the dependency
     graph (structural edges + vector-similarity search for undeclared semantic
     deps) → proposes updates to every affected prompt.
   - **Learning loop** — new traces land → agent analyzes failures/patterns →
     writes **lessons** (persistent agent memory, embedded) → proposes prompt
     updates derived from lessons.
3. **Dashboard** (`apps/web`, Next.js): graph view of prompts + deps, trace viewer,
   and a proposal inbox with diffs → approve/reject. Approving writes a new prompt
   version, which itself triggers the consistency loop.
4. **Demo app** (`apps/demo`): a recruiting-outreach agent with ~5 prompts sharing
   fragments — generates realistic traces (including seeded failures) for the demo.

## Why MongoDB wins the theme

Everything on one platform, no bolt-ons: prompts + versions (documents), dependency
edges (documents), traces (documents), lessons = agent memory (documents +
**Atlas Vector Search** over Voyage embeddings), and **change streams** as the event
bus that wakes the sync agent. The DB *is* the agent's memory and nervous system.

## Data model — THE CONTRACT (edit here first, then code)

Database `uberprompt`, collections:

```ts
// prompts — current version per name lives here; history in prompt_versions
{ _id, name: string, version: number,
  fragments: [{ key: string, text: string, embedding?: number[] }],
  template: string,            // e.g. "{{intro}}\n{{tone}}\n{{task}}" refs fragment keys
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
  sourceTraceIds: ObjectId[], appliesTo: string[],   // prompt names
  status: "active" | "superseded", ts: Date }

// proposals — pending changes awaiting human approval in the dashboard
{ _id, target: { prompt: string, fragment?: string },
  oldText: string, newText: string, reason: string,
  source: { type: "consistency" | "lesson", ref?: ObjectId },
  status: "pending" | "applied" | "rejected", ts: Date }
```

Vector Search indexes: `prompts.fragments.embedding`, `lessons.embedding`
(Voyage embeddings, cosine).

## Demo script (~4 min)

1. Show the prompt graph in the dashboard — 5 prompts, shared fragments, edges.
2. **Consistency loop live:** edit the `tone` fragment ("formal" → "casual, warm").
   Watch the agent light up dependent prompts and file diff proposals. Approve one.
3. **Learning loop live:** run the demo app → traces stream in, some seeded
   failures (candidates replying "too pushy"). Agent analyzes, writes a lesson
   ("avoid pressure language in first outreach"), proposes prompt edits. Approve →
   rerun → better output.
4. Close on the MongoDB story: memory, state, retrieval, events — one platform.

## Scope cuts (4 hours — do not build)

No auth, single project/tenant, no prompt playground, no eval scoring UI (a score
field on traces is enough), no OTel — SDK writes traces directly to Mongo, agent
runs as a plain Node loop (no queue), polling fallback if change streams fight us.

## Workstreams (parallelize across sessions)

- **A — SDK + DB layer**: schemas above, Mongo client, embedding helper, trace write.
- **B — Sync agent**: change-stream listener, consistency + learning loops (Claude
  API tool-use), proposal writer.
- **C — Dashboard**: graph view, traces, proposal inbox with diff + approve.
- **D — Demo app + seed data**: recruiting agent, seeded prompts/edges/failures.

A blocks B/C/D on the schemas — so A lands the contract types first, everyone else
mocks against IDEA.md meanwhile.
