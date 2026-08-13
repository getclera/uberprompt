# Stage 3→4 live pipeline test — 2026-08-13

End-to-end run of stage 3 (`propose/proposals/approve/reject`, PR #23) against the
live Atlas DB, plus a precise survey of what exists at the stage 3→4 seam on main.
All numbers below are from real command output against the shared cluster.

## What was run

### 1. Install + CLI boot

`pnpm install --config.minimum-release-age=0` → 53 packages, done in 1.1s.
`node packages/cli/bin/uberprompt.mjs --help` → prints full usage, exit 0.

The earlier `ERR_MODULE_NOT_FOUND` on main is **not a main bug**: `bin/uberprompt.mjs`
eagerly imports `src/graph-cmd.mjs` → `src/render.mjs` → external `archy`, so *any*
invocation (even `--help`) throws module-not-found in a checkout without a workspace
install. After `pnpm install` it runs clean. Remedy is just the install (with the
`minimum-release-age=0` flag per CLAUDE.md).

### 2. Proposals inspected

`uberprompt proposals` listed 2 pending, both sanity-checked against their source
lessons in Mongo:

- `6a7e405c…` → `escalation-writer.context`, from lesson `6a7e3a0b…` ("never promise
  a refund amount before verifying charges"; lineage `billing-agent`, extended to
  escalation-writer via the catalog rung). Correct fragment, but a wordy rewrite —
  restates the "never state approved/issued" rule twice. Left pending.
- `6a7e40ee…` → `tech-support-agent.task`, from lesson `6a7e40a4…` ("route to
  escalation whenever the customer mentions lawyers/legal action/regulator";
  lineage `triage-router`, extended to tech-support-agent). Minimal one-sentence
  insertion into the core task sentence. **Approved.**

### 3. Approve — verified in Mongo

```
applied 6a7e40eed3f9a0f2d56aa934: tech-support-agent.task — v1 -> v2
  snapshot reused: prompt_versions 6a7e39e43344152a58f73bfb (v1)
  fragment re-embedded (voyage-3.5-lite)
```

Verified directly against the cluster afterwards:

- `prompts.tech-support-agent`: `version: 2`, `updatedBy: "cli"`,
  `updatedAt: 2026-08-13T22:22:12.706Z`, new sentence present in `task` text.
- `task.embedding`: 1024 dims, unit norm; re-embedding the same text again returns
  the identical vector (cosine 1.0000) — the approve path is deterministic.
- Proposal `6a7e40ee…` status `applied`. Proposal census after:
  1 pending / 1 evaluating (untouched, Shlok's) / 11 rejected / 1 applied.
- `prompt_versions` for tech-support-agent: **still only v1** (see seam bug #1).

## The stage 3→4 seam — what actually exists

Stage 4 does **not** exist on main, and not on any unmerged branch either:

- `packages/cli` `affected`/`graph`/`infer` are file-based over `apps/demo` JSON +
  git diffs. After the real Mongo bump, `uberprompt affected` printed
  `No prompt or fragment changes detected (HEAD).` — nothing consumes Mongo bumps.
- `packages/sdk/src/queries.ts` has the building blocks (`getDependents` via
  `$graphLookup` over `edges`, `findSimilarFragments` via `$vectorSearch`,
  `findLiteralMatches`, `$rankFusion` variant) but the only change-stream watcher
  is `watchLessons` (stage 2→3). Nothing watches `prompt_versions` or `prompts`.
- `apps/agent/src/apply/*` on main is the benched stage-3 eval-gate/culprit code.
- All `felix/*` branches on origin are **fully merged into main** — stage 4 lives
  on none of them. The only consistency loop anywhere is the pre-alignment salvage
  `claude/sync-agent` (`apps/agent/src/consistency.ts`): watches `prompts`
  update/replace (not `prompt_versions` inserts), 30s debounce, 3s polling
  fallback — and calls a Claude API path that cannot run (no Anthropic key).

### Gap demonstration: the bump fired into a void

After the approve (22:22:12Z), verified on the live cluster:

- 0 proposals with `source.type: "sync-check"`, 0 `kind: "semantic"` edges,
  no `sync_state` collection. Nothing consumed the bump; no converge loop to run.
- Declared dependents of the changed fragment: 0 of the 7 `uses` edges point at
  `tech-support-agent.task` (edges cover 4 prompts → brand-voice /
  escalation-criteria / output-format; `billing-agent` has no edges at all).
- Undeclared dependents that SHOULD have been flagged — measured, not guessed:
  embedding the candidate texts fresh (same space as the new fragment embedding),
  cosine vs the changed fragment:
  - `triage-router.routing-rules` **0.849**
  - `escalation-writer.escalation-criteria` **0.830**
  — exactly the pair `apps/demo/expected-semantic-edges.json` names as the answer
  key. A working stage 4 had real material to find.

## Seam bugs found (beyond "stage 4 not built")

1. **The documented trigger never fires.** IDEA.md: stage 4 watches
   `prompt_versions` *inserts*. But `runApprove` (packages/cli/src/review.mjs)
   only snapshots the PRE-change version — and in this run the v1 snapshot already
   existed ("snapshot reused"), so the approve produced **zero inserts** into
   `prompt_versions`. Even a first-time approve inserts the OLD version, never the
   new one. Either approve must also insert the NEW version snapshot (matches
   IDEA.md "bump + snapshot"), or stage 4 must watch `prompts` updates instead.
   Decide in IDEA.md first; the snapshot fix is ~10 lines in review.mjs.

2. **The vector store is split across two incompatible embedding spaces.**
   Everything embedded ≤21:41Z today (all 6 prompts' fragment embeddings and
   `descriptionEmbedding`s, lesson 1) is mutually coherent (identical texts 1.0,
   related pairs 0.58–0.71) but **orthogonal (≈0.0) to everything embedded
   ≥22:09Z** (lesson 2, the fragment re-embedded by this approve) through the very
   same `ai.mongodb.com/v1/embeddings` + `voyage-3.5-lite` request. Measured:
   fresh embed of the seed brand-voice text vs its stored vector = **−0.03**;
   the new task embedding vs stored escalation-criteria = **−0.02** (should be
   0.83). Consequence: stage 4's undeclared-dependent discovery, stage 3's RAG
   rung (new-lesson embedding vs stored `descriptions_embedding` ≈ 0), and
   stage 2's lesson dedup (new vs old lessons) all silently return noise until
   the stale vectors are re-embedded. Cause is endpoint-side model drift or a
   different env in the seeding session — indistinguishable from here; the fix is
   the same either way: **re-embed backfill** (6 prompts: fragments +
   descriptions; lesson 1) plus recording embedding-space identity (model name +
   a stored canary vector checked at startup).

3. **Mongo and the demo files have diverged.** Approve rewrites the fragment in
   `prompts` but does not write back `apps/demo/prompts/tech-support-agent.json`
   (still v1, no new sentence). The file-first tooling (`affected`, `graph`,
   `infer` → edges.json) therefore reasons over stale text. Fine if stage 4 is
   Mongo-native; the demo script should not mix the two silently.

4. **Threshold note for stage 4:** in the current space, an unrelated fragment
   (`satisfaction-summarizer.output-format`) already scores 0.754 against the
   changed fragment. The salvage loop's 0.75 cutoff would flag it. Use ~0.80+ or
   top-k with an LLM contradiction check (which IDEA.md step 3 has anyway).

## Remaining work for the demo loop

1. Settle seam contract in IDEA.md: approve inserts NEW-version snapshot into
   `prompt_versions`; stage 4 watches those inserts (resume tokens in
   `sync_state`, `startAfter`). Then fix `runApprove` accordingly.
2. Re-embed backfill for the stale space (all 6 prompts + lesson 1), and add an
   embedding-space canary so this class of drift errors loudly next time.
3. Build stage 4 itself (nothing to salvage cleanly — `claude/sync-agent` has the
   loop skeleton but wrong trigger + dead Claude call path): on version bump,
   `getDependents` (declared) + `findSimilarFragments` (undeclared, persist
   `kind:"semantic"` edges) + LLM contradiction check → `source.type:"sync-check"`
   proposals → back through `uberprompt proposals/approve`.
4. Run the converge loop for real: approve the remaining pending proposal
   (`escalation-writer.context`) and the sync-check proposals stage 4 files,
   until no new ones appear.
5. Decide file-writeback (or explicitly declare Mongo the runtime source of truth
   and the demo files seed-only).

State left in the DB (intentionally, real progress): tech-support-agent at v2
with the escalation-routing sentence applied and proposal `6a7e40ee…` marked
applied; `6a7e405c…` still pending; Shlok's evaluating proposal untouched.
