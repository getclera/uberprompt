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

## The four main tasks
- [ ] (julian) 1 — Trace ingestion: OTLP → `spans` → `traces` rollup, SDK + CLI, demo app traces
  - [x] `packages/tracing`: normalize, rollup ($merge), MongoSpanExporter, registerUberprompt,
    OTLP wire decode, index bootstrap. Verified against the live cluster both ways —
    `pnpm --filter @uberprompt/tracing smoke` (AI SDK 7 in-process, multi-step + tool call)
    and `smoke:otlp` (raw OTLP payload, 7/7 assertions).
  - [ ] `init` / `collect` / `tail` subcommands on the existing `packages/cli`.
  - [ ] Demo app emitting real traces (needs ANTHROPIC_API_KEY).
  - Stage 2 note: `traces` now has `promptName` optional — filter `{ promptName: { $exists: true } }`.
- [ ] (claude builder — in progress) 2 — Analyze/learn: trace batches → lessons (embedded, deduped), as `uberprompt learn` CLI subcommand
- [ ] (unclaimed) 3 — Apply: proposals → approval → versioned prompt writes
- [ ] (felix — in progress) 4 — Semantic sync check: dependency graph walk after every apply → consistency proposals
- [ ] (PARKED — backend first, per talwe) Dashboard: pipeline view of the 4 stages + graph + proposal inbox (salvage exists in stopped-agent worktrees)

## Demo
- [ ] (unclaimed) Wire end-to-end, dry-run the 4-min script in IDEA.md
