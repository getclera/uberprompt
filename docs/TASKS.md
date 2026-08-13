# Task board — claim before you start, check off when merged

Claim = put your name in [ ] and push. One branch per task.
NOTE (aligned): we build along the 4 pipeline stages in IDEA.md. Salvage from the
branches listed in IDEA.md instead of rewriting.

## Setup
- [x] (talwe+claude) Atlas cluster `cluster0.u7elw1` up, db `uberprompt` + 6 collections + 3 vector indexes (fragments/descriptions/lessons, 1024d cosine) created; MONGODB_URI in .env; MongoDB MCP in .mcp.json (needs session restart + approve)
- [ ] (talwe — HUMAN) still missing in .env: ANTHROPIC_API_KEY, VOYAGE_API_KEY
- [ ] (shlok — PR open, branch `shlok/sdk-reland`) Re-land monorepo + SDK from `claude/sdk-scaffold`, reconciled with the current contract
- [x] (felix/claude) Demo example: support-crew prompt/fragment/edge/trace JSON files
- [x] (felix/claude) Demo scenario runner (apply.mjs, raise-escalation-threshold)
- [ ] (felix/claude — in progress) `uberprompt` CLI: infer / affected / graph (packages/cli)

## The four main tasks
- [ ] (unclaimed) 1 — Trace ingestion: SDK tracedCall + demo app generating traces
- [ ] (unclaimed) 2 — Analyze/learn: trace batches → lessons (embedded, deduped)
- [ ] (unclaimed) 3 — Apply: proposals → approval → versioned prompt writes
- [ ] (felix — in progress) 4 — Semantic sync check: dependency graph walk after every apply → consistency proposals
- [ ] (unclaimed) Dashboard: pipeline view of the 4 stages + graph + proposal inbox

## Demo
- [ ] (unclaimed) Wire end-to-end, dry-run the 4-min script in IDEA.md
