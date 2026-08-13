# Task board — claim before you start, check off when merged

Claim = put your name in [ ] and push. One branch per task.

## Phase 0 — contract (blocks everything)
- [x] (talwe/claude — PR claude/sdk-scaffold) `packages/sdk`: TS types for all collections in IDEA.md + Mongo client + `.env.example`
- [ ] (talwe — HUMAN: needs Atlas account) Atlas: cluster, database `uberprompt`, vector indexes, connection string in shared .env

## Phase 1 — parallel build
- [x] (talwe/claude — PR claude/sdk-scaffold) A: SDK — definePrompt/fragments, deps, render, traced LLM call wrapper
- [ ] (claude agent — in progress) B: agent — change-stream listener + consistency loop (edit → ripple proposals)
- [ ] (claude agent — in progress) B2: agent — learning loop (traces → lessons → proposals)
- [ ] (claude agent — in progress) C: dashboard — prompt graph view + fragment editor
- [ ] (claude agent — in progress) C2: dashboard — proposal inbox (diff, approve/reject) + trace list
- [ ] (claude agent — in progress) D: demo app — recruiting-outreach prompts + seed script + failure traces

## Phase 2 — demo
- [ ] (unclaimed) Wire full demo flow end-to-end, dry-run the 4-min script (IDEA.md)
- [ ] (unclaimed) Polish dashboard for stage (dark theme, big fonts)
