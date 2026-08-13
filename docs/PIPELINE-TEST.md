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

Per the user mid-run: Felix supplies a **function** (pass a prompt, get its
dependents/dependencies back) — there is no change-stream listener to find.

**Felix's function, located on main** (`packages/cli/src/graph.mjs`):
`buildGraph(model)` + `dependentsOf(graph, node)` / `dependenciesOf(graph, node)`.
They are **pure functions over a model object** `{ prompts: Map, edges: [] }` —
`buildGraph` never reads `model.fragments` and touches no files. The file-based
part is only the loader: `loadModel(dir)` (`load.mjs`) builds that model from
`apps/demo` JSON, and `runNodeAffected(model, repoRoot, input, opts)`
(`node-affected.mjs`) is the CLI wrapper. Node ids: `"prompt"`, `"shared-frag"`,
`"prompt.local-frag"`; edge entries `{from, to, kind, note?, confidence?}` —
**exactly the shape of the Mongo `edges` docs**, since `edges.json` mirrors the
collection. So the file/Mongo mismatch is confined to the loader, and the adapter
is genuinely thin.

Everything else checked, for completeness: `packages/sdk/queries.ts` has Mongo-side
building blocks (`getDependents` via `$graphLookup`, `findSimilarFragments` via
`$vectorSearch`) but its only watcher is `watchLessons` (stage 2→3);
`apps/agent/src/apply/*` is the benched eval-gate code; all `felix/*` branches are
fully merged (no hidden stage-4 branch); the pre-alignment salvage
`claude/sync-agent` loop watches `prompts` and calls a dead Claude path.

## The integration prototype — `uberprompt sync-check` (this PR)

`packages/cli/src/sync-check.mjs`, wired as a CLI subcommand. Shape:

```
approve (bump) → sync-check <prompt>:
  diff current prompts doc vs latest older prompt_versions snapshot
  → changed fragments (old/new text)
  → modelFromMongo(prompts, edges)  — the thin adapter (~8 lines)
  → buildGraph + dependentsOf(node) — Felix's function, unchanged
  → LLM consistency check per dependent fragment (gpt-5.1, structured tool call)
  → file proposals { source: { type: "sync-check", ref: <snapshot _id> } }
    (skips identical pending; --dry-run; --against <p.f> to force-check a node)
```

Live run against the real bump:

```
$ uberprompt sync-check tech-support-agent
tech-support-agent v1 -> v2: 1 changed fragment(s): task
  tech-support-agent.task: 0 dependent fragment(s) to check
0 sync-check proposal(s) filed — graph is quiet
```

Zero dependents is **correct** for the declared graph: none of the 7 `uses` edges
point at `tech-support-agent.task`, and no semantic edges exist yet. The LLM check
path was exercised with `--against` on the answer-key neighbors — real verdicts:

```
$ uberprompt sync-check tech-support-agent --against triage-router.routing-rules --dry-run
    triage-router.routing-rules  [forced]
      consistent: Both fragments require escalation whenever the customer mentions
      lawyers, legal action, or a regulator…
$ uberprompt sync-check tech-support-agent --against escalation-writer.escalation-criteria --dry-run
      consistent: Both fragments require escalation whenever there is a legal threat…
```

Both honest "consistent" — the applied change *agrees* with the escalation
criteria, so the converge loop terminates in wave 1 with the graph quiet. The
dependents walk over Mongo-shaped edges (prompt-level dependents expanding into
their non-empty fragments, changed-prompt exclusion, `uses`+`semantic` mixing) is
covered by `packages/cli/test/sync-check.test.mjs` — suite: 24 pass.

### Recommended final wiring

`approve` (review.mjs) after the version bump → call `runSyncCheck(prompt)` inline
(same process, no event bus needed) → sync-check proposals land as `pending` →
human approves → that approve triggers sync-check again → waves shrink until
quiet. The version-bump *diff signal* comes from `prompt_versions` (current doc vs
latest older snapshot), which works today precisely because approve freezes the
pre-change version. Change streams remain optional sugar for a live dashboard, not
a dependency of the loop.

### The semantic layer is still missing — measured

Before this PR's prototype, the bump fired into a void (0 sync-check proposals,
0 semantic edges, no `sync_state`). The prototype closes the declared-graph part
of the loop; what remains missing is the **undeclared-dependent layer**:

- Declared dependents of the changed fragment: 0 of the 7 `uses` edges point at
  `tech-support-agent.task` (edges cover 4 prompts → brand-voice /
  escalation-criteria / output-format; `billing-agent` has no edges at all).
- Undeclared dependents that vector discovery SHOULD surface — measured, not
  guessed: embedding the candidate texts fresh (same space as the new fragment
  embedding), cosine vs the changed fragment:
  - `triage-router.routing-rules` **0.849**
  - `escalation-writer.escalation-criteria` **0.830**
  — exactly the pair `apps/demo/expected-semantic-edges.json` names as the answer
  key. Once found, they belong in `edges` as `kind:"semantic"` docs, and
  `sync-check` picks them up with zero further code (the walk already mixes
  `uses` and `semantic`).

## Seam bugs found (beyond "stage 4 was not wired")

1. **IDEA.md's trigger contract is stale.** It says stage 4 watches
   `prompt_versions` *inserts* — but `runApprove` (packages/cli/src/review.mjs)
   only snapshots the PRE-change version, and in this run even that was a no-op
   ("snapshot reused"): **zero inserts** fired. With the function-call wiring
   (user's clarification) no event is needed — approve should invoke sync-check
   inline — so IDEA.md's "stage 3→4 handoff" section should be updated to the
   call shape. Residual: `prompt_versions` never holds the *current* version
   until the next approve, so version history is permanently one behind.

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

1. Update IDEA.md's "stage 3→4 handoff" to the function-call shape (approve →
   `runSyncCheck` inline; change streams optional dashboard sugar), and chain the
   call at the end of `runApprove` (~3 lines) so the demo needs one command, not
   two.
2. Re-embed backfill for the stale space (all 6 prompts + lesson 1), and add an
   embedding-space canary so this class of drift errors loudly next time.
3. Add the undeclared-dependent layer to `sync-check`: `findSimilarFragments`
   (packages/sdk) over the changed fragment's new embedding, threshold ~0.80+ or
   top-k, persist hits as `kind:"semantic"` edges — the walk then picks them up
   unchanged. Blocked by (2).
4. Run the converge loop for real: approve the remaining pending proposal
   (`escalation-writer.context`), `sync-check escalation-writer`, approve any
   sync-check proposals, repeat until quiet.
5. Decide file-writeback (or explicitly declare Mongo the runtime source of truth
   and the demo files seed-only).

State left in the DB (intentionally, real progress): tech-support-agent at v2
with the escalation-routing sentence applied and proposal `6a7e40ee…` marked
applied; `6a7e405c…` still pending; Shlok's evaluating proposal untouched.
