# überprompt — hackathon repo

MongoDB "Persistent Context Sprint" hackathon, Aug 13 2026, ~4h build window.

**Before doing anything: read `docs/IDEA.md`.** It is the single source of truth for
the idea, architecture, and data model. `docs/TASKS.md` is the live task board.

## Session sync protocol (multiple people run Claude sessions in parallel)

- `docs/IDEA.md` is the contract. The MongoDB collection schemas defined there are
  shared interfaces between workstreams — if you need to change one, edit IDEA.md
  first, get it merged, and note it in your task-board entry.
- Claim work in `docs/TASKS.md` (name next to task), push the claim before starting,
  check off tasks as you finish.

## Docs are the team's shared memory — keep them current, always

The docs are how humans AND every Claude session stay in sync. A change that isn't
reflected in the docs doesn't exist for the rest of the team. After anything you do,
update the matching doc **in the same PR / push** — never "later":

- Finished, started, or abandoned a task → update `docs/TASKS.md` (claim/check/unclaim).
- Made or changed a decision (architecture, scope, naming, stack, schema) →
  update `docs/IDEA.md`; schema changes go there BEFORE the code change.
- Learned something the next session needs (gotcha, workaround, env quirk,
  "X doesn't work, we do Y instead") → add it to the relevant doc or CLAUDE.md.
- Anything went differently than the docs say → fix the doc so it matches reality.
  Stale docs are worse than no docs.

End-of-turn check for every session: "does main's docs still describe reality?"
If not, push the doc fix (doc-only fixes may go straight to main).

## Git workflow — merge early, merge often

- Work on short-lived branches (`<name>/<task>`), one task per branch.
- Open a PR as soon as there's anything reviewable and **merge fast** — a PR should
  live minutes, not hours. Small diffs, atomic commits (stage specific files, never
  `git add -A`).
- **Sync from `main` constantly**: rebase/pull main into your branch after every
  merge you see land. Resolve conflicts immediately yourself — never leave a
  conflicted branch sitting; if a conflict touches the IDEA.md contract, the
  IDEA.md version wins.
- Never force-push shared branches. Doc-only fixes may go straight to main.
- Secrets live in `.env` (gitignored). Never commit or print credential values.

## Keep the main session free — delegate everything heavy

Your main Claude session is the **orchestrator**: it plans, reviews, merges, and
talks to you. It should never be blocked grinding on a long task.

- Fan out implementation, debugging, and broad searches to **subagents** (Agent
  tool / background tasks) or **Codex** agents. Run independent subtasks in
  parallel, in one message.
- Anything expected to take more than ~2 minutes of tool-grinding → delegate it and
  keep the main session responsive for the next instruction.
- Subagents work in their own worktrees/branches; the main session reviews and
  merges their output.

## Stack (decided — don't relitigate mid-hackathon)

TypeScript everywhere. pnpm monorepo: `packages/sdk`, `apps/web` (Next.js dashboard),
`apps/agent` (sync agent), `apps/demo` (demo app that generates traces).
MongoDB Atlas (one platform: documents + Atlas Vector Search + change streams).
Embeddings: Voyage AI. LLM: Claude API (`@anthropic-ai/sdk`), model `claude-opus-5`,
adaptive thinking (default — don't pass a `thinking` config or sampling params).

## Code standards (ported from clera-platform, hackathon-weight)

- **Startup, not enterprise — keep it simple.** Handle only the important cases;
  error loudly instead of adding silent fallbacks. No speculative abstraction, no
  "might need it later" plumbing. Smallest change that solves the real problem —
  but fully implement what you do build (no TODOs/placeholders).
- **Zero comments.** Names + types say WHAT, the PR body says WHY.
- **No `any`** — use `unknown`, `Record<string, unknown>`, or real types.
- **Max ~400 lines per file.** Split into `index/handlers/types` when growing.
- **Search before create** — grep `packages/sdk` before adding a util/type; reuse
  over fork.
- **No silent PASS.** Before claiming something works, show the command you ran and
  its real output (typecheck, script run, curl). "It should work" doesn't count.
- Rebase `origin/main` before every push.
