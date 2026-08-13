---
name: sync-loop
description: Run the überprompt operational loop end to end — lessons → proposals → approve → automatic stage-4 sync check → converge until the graph is quiet. Use when asked to "run the loop", "sync the prompts", "process lessons", "converge the graph", or to demo the pipeline.
---

# The überprompt sync loop

Drives stages 2→3→4 from the CLI against the live Atlas DB. Prompts are
canonical in MongoDB (`apps/demo` JSON is seed-only). Stage 4 is NOT a
watcher: `approve` (and `rollback`) call the sync check inline, so one
command per approval drives the whole ripple.

## Prerequisites

- Repo-root `.env` with `MONGODB_URI`, `MONGODB_DB`, `OPENAI_API_KEY`,
  `VOYAGE_API_KEY` (Atlas-issued — only works against
  `https://ai.mongodb.com/v1/embeddings`, never `api.voyageai.com`).
- VPN OFF (Atlas kills the TLS handshake through a VPN) and your egress IP
  allowed in Atlas Network Access.
- `pnpm install --config.minimum-release-age=0` once per checkout.
- Run commands as `node packages/cli/bin/uberprompt.mjs <cmd>` (or `uberprompt`
  after `npm link` in `packages/cli`).

## Embedding-space repair (run first if vector search behaves strangely)

Vectors written through different endpoint/model eras are mutually orthogonal
and silently break all similarity search. If related fragments score ≈0.0, or
`sync` reports zero semantic hits where hits are expected:

```
uberprompt reembed --dry-run   # list what would be re-embedded
uberprompt reembed             # rewrite all vectors, then verify
```

Expect per-prompt `re-embedded <name> vN: k fragment(s) + description` lines,
then an `embedding-space verification:` block where every pair prints `OK`
(known-good on the Mango Republic crew: triage-router.routing-rules vs
escalation-writer.escalation-criteria ≈ 0.86, escalation-writer.context vs
refund-agent.refund-policy ≈ 0.87, unrelated pairs < 0.8). A FAIL exits 1 —
do not proceed until it passes. Only vectors that already exist are rewritten.

## The loop

1. **Check for unprocessed lessons** (stage 2 output) and turn them into
   proposals:

   ```
   uberprompt propose
   ```

   Files minimal-rewrite `pending` proposals via the targeting ladder.
   No unprocessed lessons → "nothing to do".

2. **Review the inbox:**

   ```
   uberprompt proposals
   ```

   Each entry shows target, source (lesson / sync-check), reason, and a
   compact old→new diff. NEVER approve a proposal in status `evaluating` —
   that is another workstream's eval gate.

3. **Human approves** (the human picks the id; sync check runs automatically):

   ```
   uberprompt approve <id>
   ```

   Approve bridges to the SDK's transactional `approveProposal`, then chains
   the sync check. Expected output, in order: `applied … — now vN+1`,
   `snapshot inserted: prompt_versions vN+1`, `contentHash … — fragment
   re-embedded`, then the sync-check block: `graph dependents (uses +
   semantic edges): k`, `semantic discovery ($vectorSearch, cosine >= 0.8,
   top 5): m hit(s)` with `NEW semantic edge` lines for undeclared
   dependencies it just discovered, then a per-dependent `consistent:` /
   `INCONSISTENT:` verdict with `FILED <id>` for each real conflict. Last
   line is either `0 sync-check proposal(s) filed — graph is quiet` or
   `… — approve them to continue the wave`.

   A `Fragment … changed since this proposal was filed` error means the
   proposal went stale under a newer version — check whether the current
   fragment already covers it, then reject.

4. **Iterate:** if the sync check FILED new proposals, go back to step 2 and
   approve (or reject) them. Each approval fires the next wave; waves shrink
   because already-known edges dedupe and already-consistent fragments pass.
   Reject rewrites that put a rule in the wrong layer (e.g. refund policy
   into the shared brand-voice tone fragment) — rejects also converge the
   loop.

5. **Converge:** stop when `uberprompt proposals` shows no pending sync-check
   proposals and the last sync output ended `graph is quiet`.

## Manual / recovery commands

- `uberprompt sync-check <prompt[.fragment]>` (alias: `sync`) — run the sync
  check by hand for a version bump that happened without one (diffs current
  vs latest snapshot). `--dry-run` previews without writing edges or
  proposals.
- `uberprompt rollback <prompt> [--to <version>]` — restore a
  `prompt_versions` snapshot as a NEW version (append-only history), re-embed
  changed fragments, and fire the sync check on the restored text.
- `uberprompt reject <id>` — drop a bad proposal without applying.
- `uberprompt graph` / `uberprompt compare <prompt>` — inspect the edge graph
  and per-version trace metrics.

A worked, real transcript of the whole loop is in `docs/DEMO-RUN.md`.
