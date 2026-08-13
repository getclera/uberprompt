# Task board — claim before you start, check off when merged

Claim = put your name in [ ] and push. One branch per task.
NOTE (aligned): we build along the 4 pipeline stages in IDEA.md. Salvage from the
branches listed in IDEA.md instead of rewriting.

## Setup
- [ ] (talwe — HUMAN) Atlas cluster, db `uberprompt`, vector indexes, `.env` (MONGODB_URI, ANTHROPIC_API_KEY, VOYAGE_API_KEY)
- [x] MongoDB MCP server wired in `.mcp.json` (project scope, `mongodb-mcp-server@latest`).
      It reads `MDB_MCP_CONNECTION_STRING` from your shell env — export it (same value as
      `MONGODB_URI`) before launching Claude, then approve the server when prompted.
- [ ] (unclaimed) Re-land monorepo + SDK from `claude/sdk-scaffold` once plan is locked
- [x] (felix/claude) Demo example: support-crew prompt/fragment/edge/trace JSON files

## The four main tasks
- [ ] (unclaimed) 1 — Trace ingestion: SDK tracedCall + demo app generating traces
- [ ] (unclaimed) 2 — Analyze/learn: trace batches → lessons (embedded, deduped)
- [ ] (shlok) 3 — Apply: lesson → culprit → candidate → **eval gate** → proposal.
      Stage 3 emits proposals only; it never writes `prompts`. OWNER CHANGE: IDEA.md
      had `owner: talwe` — talwe, ack or push back on this PR before it merges.
- [ ] (felix — in progress) 4 — Semantic sync check: dependency graph walk after every apply → consistency proposals
- [ ] (unclaimed) Dashboard: pipeline view of the 4 stages + graph + proposal inbox

## Demo
- [ ] (unclaimed) Wire end-to-end, dry-run the 4-min script in IDEA.md
