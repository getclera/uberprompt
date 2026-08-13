# Task board — claim before you start, check off when merged

Claim = put your name in [ ] and push. One branch per task.
NOTE (aligned): we build along the 4 pipeline stages in IDEA.md. Salvage from the
branches listed in IDEA.md instead of rewriting.

## Setup
- [x] (talwe+claude) Atlas cluster `cluster0.u7elw1` up, db `uberprompt` + 6 collections + 3 vector indexes (fragments/descriptions/lessons, 1024d cosine) created; MONGODB_URI in .env; MongoDB MCP in .mcp.json (needs session restart + approve)
  - Verified from a client (Aug 13): MongoDB 8.0.29, `ReplicaSetWithPrimary` (3 servers),
    read/write confirmed, **change streams available** — so the IDEA.md event bus works.
    Org: "SF .local Build Fest".
  - The password contains a `!`, which must be percent-encoded as `%21` inside the URI —
    otherwise auth fails with code 18 and looks like a wrong password.
  - **Gotcha — disconnect your VPN.** With a VPN up, Atlas sees the tunnel's exit IP and
    kills the connection during the TLS handshake: TCP to all 3 shards opens, handshake
    returns 0 bytes, auth never runs. It looks exactly like a paused cluster or a bad
    password, and is neither. Also add your current egress IP under Network Access
    (`curl https://api.ipify.org`) — it changes when you switch networks.
  - Still missing for stage 1: the `spans` collection, and a **unique index on
    `traces.traceId`** (the `$merge` key — without it the rollup duplicates instead of
    updating). Created by the stage 1 `init` subcommand.
- [ ] (talwe — HUMAN) still missing in .env: ANTHROPIC_API_KEY, VOYAGE_API_KEY
- [ ] (shlok — PR open, branch `shlok/sdk-reland`) Re-land monorepo + SDK from `claude/sdk-scaffold`, reconciled with the current contract
- [x] (felix/claude) Demo example: support-crew prompt/fragment/edge/trace JSON files
- [x] (felix/claude) Demo scenario runner (apply.mjs, raise-escalation-threshold)
- [ ] (felix/claude — in progress) `uberprompt` CLI: infer / affected / graph (packages/cli)
- [x] (felix/claude) CLI graph visualization: `uberprompt graph [node]` map/tree/impact views + tests
  - Evaluated external renderers for the map (beautiful-mermaid, diagonjs, d2, graph-easy):
    all break down or spaghetti on our dense bipartite graph, or need a non-npm binary.
    Decision: keep the custom renderer; readability via two-sided barycenter ordering.

## The four main tasks
- [ ] (julian) 1 — Trace ingestion: OTLP → `spans` → `traces` rollup, SDK + CLI, demo app traces
  - [x] `packages/tracing`: normalize, rollup ($merge), MongoSpanExporter, registerUberprompt,
    OTLP wire decode, index bootstrap. Verified against the live cluster both ways —
    `pnpm --filter @uberprompt/tracing smoke` (AI SDK 7 in-process, multi-step + tool call)
    and `smoke:otlp` (raw OTLP payload, 7/7 assertions).
  - [x] `uberprompt init` / `collect` / `tail` on the existing CLI. Verified live: `init`
    created 6 indexes; `collect` ingested a real HTTP OTLP POST (service read from the
    payload's resource attrs, tokens + latency correct); `tail` printed history and then
    streamed a new trace as it landed, via change stream.
  - [ ] Demo app emitting real traces (needs ANTHROPIC_API_KEY).
  - Stage 2 note: `traces` now has `promptName` optional — filter `{ promptName: { $exists: true } }`.
- [x] (claude builder) 2 — Analyze/learn: `uberprompt learn` mines traces (`promptName` exists, error/low-score first) → per-prompt LLM lesson mining → Voyage embed → `$vectorSearch` dedup vs active lessons (≥0.92 merges trace ids via `$addToSet` instead of inserting; this is the stage's idempotency). Verified: 33/33 CLI tests + live Atlas dry-run (14 traces → 7 lessons, 3 healthy groups, 0 writes).
  - Gotcha: the LIVE `lessons_embedding` index has no `filter` fields (create-indexes.ts declares status/appliesTo but was never re-applied) — `$vectorSearch` with `filter` errors, so `learn` fetches 5 candidates and filters `status: "active"` in code.
- [x] (talwe+claude — done, pending merge) 3 — Apply per IDEA.md: `uberprompt
      propose / proposals / approve|reject`. Targeting ladder (lineage → catalog LLM
      pass → $vectorSearch over `descriptions_embedding`), minimal-rewrite pending
      proposals, approve = prompt_versions snapshot (+contentHash) + fragment rewrite +
      version bump + Voyage re-embed + status "applied". Verified end-to-end against
      live Atlas with a synthetic lesson (cleaned up after; billing-agent restored to v1).
  - [x] (shlok) Stage 3 agent (`apps/agent`): targeting ladder, culprit diagnosis with
        undeclared blast radius, eval gate, lessons change-stream watcher — un-benched
        from PR #8, now the live stage-3 path.
  - [x] (shlok) Eval gate correctness: golden-only prompts can pass (a replay-less
        target used to fail unconditionally), judge failures count as ties instead of
        losses, baseline outputs are reused across retry attempts, and the win delta
        drops `lessonAdherence` so lesson-parroting alone can't clear the gate.
  - [x] (shlok) One approve path: `uberprompt approve` bridges to
        `approveProposal` (sdk); `review.mjs`'s duplicate — which never wrote
        `contentHash` and never inserted the new-version snapshot — is deleted.
  - Gotcha: the `.mjs` CLI's tsx bridges must spawn from a package dir, not the repo
    root — the root has no `node_modules/.bin/tsx`. `tracing-cmd.mjs` still spawns
    from the root, so `uberprompt init|collect|tail` hits `Command "tsx" not found`.
- [x] (felix — verified e2e on Mango, Aug 13) 4 — Semantic sync check: dependency graph walk after every apply → consistency proposals
  - Full-chain e2e on the Mango Republic demo against live Atlas: DB wiped + reseeded
    (6 prompts, 14 traces incl. 3 seeded failures) → lesson from failing refund traces →
    `propose` filed 4 → `approve` refund-agent.refund-policy → v2 + snapshot + re-embed →
    `uberprompt infer` found BOTH answer-key semantic edges (0.92 / 0.85–0.88, gpt-5-nano),
    applied + pushed to `edges` collection → `sync-check refund-agent` walked the semantic
    edge, judged escalation-writer.context INCONSISTENT, filed a `source:"sync-check"`
    proposal → approved → escalation-writer v2 → wave-2 sync-check quiet. Loop closed.
  - Bug found+fixed on the way: sync-check addressed a changed shared fragment as
    `<prompt>.<key>` — a node no edge points at — so dependents were never found.
    Now detects shared keys via `uses` edges and walks the bare shared node.
  - Semantic edges reach Mongo via a manual insert for now — `infer` writes edges.json
    only; wiring `infer --apply` to also upsert the `edges` collection is open.
- [ ] (PARKED — backend first, per talwe) Dashboard: pipeline view of the 4 stages + graph + proposal inbox (salvage exists in stopped-agent worktrees)

## Demo
- [ ] (talwe+claude — in progress) Wire end-to-end, dry-run the 4-min script in IDEA.md
  - Stage 3 verified live (Aug 13): approved proposal `6a7e40ee…` for real —
    tech-support-agent v1→v2, fragment re-embedded, proposal `applied`. Full run +
    evidence in `docs/PIPELINE-TEST.md`.
  - Stage 3→4 seam (details + measurements in PIPELINE-TEST.md): felix's graph
    functions (`buildGraph`/`dependentsOf`, packages/cli/src/graph.mjs) are pure
    over `{prompts, edges}` — new `uberprompt sync-check <prompt>` feeds them
    from Mongo via a thin adapter, diffs current vs latest `prompt_versions`
    snapshot, LLM-checks dependents, files `source:"sync-check"` proposals.
    Ran live on the v2 bump: 0 declared dependents (correct), forced checks on
    the answer-key neighbors judged consistent — loop converges quiet in wave 1.
  - Still open at the seam: chain sync-check onto approve; all embeddings
    written before ~21:41Z Aug 13 (6 prompts + lesson 1) are orthogonal to the
    current endpoint's space — semantic-edge discovery returns noise until
    re-embedded; apps/demo JSON diverged from Mongo after the apply (files
    still v1).
