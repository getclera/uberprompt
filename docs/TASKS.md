# Task board — claim before you start, check off when merged

Claim = put your name in [ ] and push. One branch per task.

## Phase 0 — contract (blocks everything)
- [ ] (talwe/claude — in progress) `packages/sdk`: TS types for all collections in IDEA.md + Mongo client + `.env.example`
- [ ] (talwe — HUMAN: needs Atlas account) Atlas: cluster, database `uberprompt`, vector indexes, connection string in shared .env

## Phase 1 — parallel build
- [ ] (talwe/claude — in progress, bundled with Phase 0) A: SDK — definePrompt/fragments, deps, render, traced LLM call wrapper
- [ ] (unclaimed) B: agent — change-stream listener + consistency loop (edit → ripple proposals)
- [ ] (unclaimed) B2: agent — learning loop (traces → lessons → proposals)
- [ ] (unclaimed) C: dashboard — prompt graph view + fragment editor
- [ ] (unclaimed) C2: dashboard — proposal inbox (diff, approve/reject) + trace list
- [ ] (unclaimed) D: demo app — recruiting-outreach prompts + seed script + failure traces

## Phase 2 — demo
- [ ] (unclaimed) Wire full demo flow end-to-end, dry-run the 4-min script (IDEA.md)
- [ ] (unclaimed) Polish dashboard for stage (dark theme, big fonts)
