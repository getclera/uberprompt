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

### Worktrees — ALL code changes go in a worktree, never the primary repo

- The primary checkout stays on `main` and is never modified. Even "quick"
  one-file fixes go through a worktree. No size/urgency exception — "it's one
  line", "main already has uncommitted changes here", "a worktree feels like
  overhead" are all invalid justifications.
- **The only exception is an explicit, unambiguous instruction to edit the
  primary repo** (the user naming `main`/the primary checkout and saying to
  change it there). A terse or ambiguous prompt is not permission — ask instead
  of guessing.
- Create worktrees with the `EnterWorktree` tool, then rename the auto branch
  to `<name>/<task>` (`git branch -m`).
- Never run git commands in the primary repo while working in a worktree.
- **Never `git stash`** — worktrees share one stash stack; a stash pushed in
  one surfaces in the others. Commit to a scratch branch or export a patch
  (`git diff > patch`) instead.
- Doc-only fixes to `docs/` may still go straight to main (see below).

- Work on short-lived branches (`<name>/<task>`), one task per branch.
- Open a PR as soon as there's anything reviewable and **merge fast** — a PR should
  live minutes, not hours. Small diffs, atomic commits (stage specific files, never
  `git add -A`).
- **Sync from `main` constantly**: rebase/pull main into your branch after every
  merge you see land. Resolve conflicts immediately yourself — never leave a
  conflicted branch sitting; if a conflict touches the IDEA.md contract, the
  IDEA.md version wins.
- **NEVER force-push `main` — no exceptions, it overwrites teammates' code.**
  `--force-with-lease` is allowed only on your own feature branch (e.g. after a
  rebase), never on main, never on a branch someone else may be using.
- **NEVER push directly to `main` — everything goes through a PR**, docs included.
  Rebase your branch on origin/main, push the branch, open the PR, merge fast.
- Secrets live in `.env` (gitignored). Never commit or print credential values.

## Keep the main session free — delegate everything heavy

Your main Claude session is the **orchestrator**: it plans, reviews, merges, and
talks to you. It should never be blocked grinding on a long task.

- Fan out implementation, debugging, and broad searches to **subagents** (Agent
  tool / background tasks) or **Codex** agents. Run independent subtasks in
  parallel, in one message.
- Anything expected to take more than ~2 minutes of tool-grinding → delegate it and
  keep the main session responsive for the next instruction. This includes infra
  chores (DB setup, env wiring, installs) — NOT just feature code.
- Ready-made subagents live in `.claude/agents/`: **builder** (code → PR),
  **ops** (infra/DB/env chores), **reviewer** (PR review vs contract). Use them.
- The main session's job between delegations: answer the human, review results,
  merge, update docs. If the main session is running a shell loop, it's doing it
  wrong.
- Subagents work in their own worktrees/branches; the main session reviews and
  merges their output.

## Stack (decided — don't relitigate mid-hackathon)

TypeScript everywhere. pnpm monorepo: `packages/sdk`, `apps/web` (Next.js dashboard),
`apps/agent` (sync agent), `apps/demo` (demo app that generates traces).
MongoDB Atlas (one platform: documents + Atlas Vector Search + change streams).
Embeddings: Voyage AI (`VOYAGE_API_KEY`, voyage-3.5-lite, 1024d).
LLM: **OpenAI via the Vercel AI SDK** (`ai` + `@ai-sdk/openai`, `OPENAI_API_KEY` in
.env) — there is NO Anthropic key; don't write raw `openai` or `@anthropic-ai/sdk`
call paths. Default model **`gpt-5.1`**; cheap variant for bulk/low-stakes calls is
**`gpt-5.4-mini`** (`gpt-5.1-mini` does NOT exist on this key — 404s, verified).
CLI `infer` uses `gpt-5-nano`. AI SDK calls are auto-traced to Mongo when the app
runs `registerUberprompt()` (`@uberprompt/tracing`).

## Environment gotchas (verified the hard way — don't rediscover)

- **VOYAGE_API_KEY is Atlas-issued**: it 403s on `api.voyageai.com`. Use
  `https://ai.mongodb.com/v1/embeddings` (same request shape, 1024d verified).
  `packages/sdk/src/embeddings.ts` now points there (fixed); override with
  `VOYAGE_EMBEDDINGS_URL` if the host ever moves.
- Fresh `pnpm install` fails on `ai@7.0.65` (younger than pnpm's 24h
  supply-chain default): use `pnpm install --config.minimum-release-age=0`.
- Atlas + VPN don't mix (TLS handshake dies, looks like bad password) — see
  TASKS.md setup notes. Password's `!` must be `%21` in the URI.
Backend first — dashboard is parked.

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

## Debugging discipline (ported from clera-platform)

- **Evidence before root cause.** A hypothesis needs DB/code/log proof before
  being voiced — never assume data differences or timing explain a bug.
- **Never blame cache.** "Stale cache" is not a root cause; trace the code path.
- **Never blame deployment.** 95% of the time it's a code bug — deployment-state
  theories require direct evidence before being voiced.
- **Format only files you edited** — never run a repo-wide formatter. If a
  formatter widens your diff beyond what you touched, `git checkout --` those
  files before committing.
