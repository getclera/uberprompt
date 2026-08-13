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
- [x] (felix/claude) Demo scenario runner (apply.ts, raise-escalation-threshold)
- [x] (felix/claude) `uberprompt` CLI: infer / affected / graph (packages/cli)
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
        `approveProposal` (sdk); `review.ts`'s duplicate — which never wrote
        `contentHash` and never inserted the new-version snapshot — is deleted.
  - Gotcha: the CLI's tsx bridges must spawn from a package dir, not the repo
    root — the root has no `node_modules/.bin/tsx`. `tracing-cmd.ts` still spawns
    from the root, so `uberprompt init|collect|tail` hits `Command "tsx" not found`.
- [x] (felix + talwe+claude) 4 — Semantic sync check: `runSyncCheck`
      (packages/cli/src/sync-check.ts, extends felix's prototype) runs inline
      after every successful approve bridge and rollback (function call, not a
      watcher; `--no-sync` opts out) and manually via
      `uberprompt sync-check <prompt[.fragment]>` (alias `sync`). Dependents =
      Mongo `edges` graph walk (buildGraph/dependentsOf over a thin adapter,
      shared-node aware) ∪ `$vectorSearch` discovery (cosine >= 0.80, top 5)
      with new `kind:"semantic"` edges persisted straight into the `edges`
      collection (confidence/model/inferredAt). gpt-5.1 consistency check
      files `source:"sync-check"` proposals for real conflicts. Plus:
      `uberprompt reembed` (embedding-space backfill + verify) and
      `uberprompt rollback <prompt> [--to N]` — restores a snapshot as a new
      version (append-only) and fires the sync check.
  - (felix) Semantic edges now survive a demo reset: `seed-demo` reseeds the
    `kind:"semantic"` edges from `edges.json` (idempotent delete+insert) and
    `uberprompt infer --apply` upserts each applied edge into the `edges`
    collection keyed by (from.prompt, from.fragment, to.fragment, kind) when
    MONGODB_URI is set — file-only with a printed note otherwise. Closes the
    `infer --apply doesn't reach Mongo` gap for the CLI path too.
  - (felix) Full-chain e2e on the Mango demo against live Atlas: reseed →
    lesson → propose → approve refund-agent.refund-policy → infer found both
    answer-key semantic edges → sync-check walked them, filed + approved the
    escalation-writer.context fix → wave-2 quiet. Bug found+fixed: sync-check
    now walks the bare shared-fragment node when a shared key changes.
- [ ] (PARKED — backend first, per talwe) Dashboard: pipeline view of the 4 stages + graph + proposal inbox (salvage exists in stopped-agent worktrees)

## Demo
- [x] (talwe+claude — done) Wire end-to-end: LIVE convergence runs recorded
      verbatim in `docs/DEMO-RUN.md` (feeds docs/DEMO.md's video). On the
      Mango Republic crew: 4 waves to convergence, 6 semantic edges
      discovered (incl. both planted answer-key deps at 0.868/0.862), 2 real
      conflicts fixed, 1 false positive + 2 stale/redundant proposals stopped
      at the human gate. NOTE: a reset/rehearsal loop restored the cluster to
      pristine v1 at 23:04Z (proposals/lessons/semantic edges wiped) — that
      is the intended pre-video state; the runs live on in DEMO-RUN.md.
      Operational loop taught to any session via
      `.claude/skills/sync-loop/SKILL.md`.
  - Stage 3 verified live (Aug 13): approved proposal `6a7e40ee…` for real —
    tech-support-agent v1→v2, fragment re-embedded, proposal `applied`. Full run +
    evidence in `docs/PIPELINE-TEST.md`.
  - Stage 3→4 seam (details + measurements in PIPELINE-TEST.md): felix's graph
    functions (`buildGraph`/`dependentsOf`, packages/cli/src/graph.ts) are pure
    over `{prompts, edges}` — new `uberprompt sync-check <prompt>` feeds them
    from Mongo via a thin adapter, diffs current vs latest `prompt_versions`
    snapshot, LLM-checks dependents, files `source:"sync-check"` proposals.
    Ran live on the v2 bump: 0 declared dependents (correct), forced checks on
    the answer-key neighbors judged consistent — loop converges quiet in wave 1.
  - Seam items above all closed by the stage-4 PR: sync check chained onto
    approve (and rollback), IDEA.md states the function-call handoff,
    `uberprompt reembed` repaired the split embedding space (verified
    0.849/0.832 known-good pairs), and apps/demo JSON is officially seed-only
    (Mongo canonical — no write-back).
