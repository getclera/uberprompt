# Stage 4 live convergence run — 2026-08-13 (the on-stage script)

Real commands + real output against the shared Atlas cluster. This is the
transcript to replay on stage: one approve, the sync check ripples, one more
approve, the graph goes quiet. All state below was left in place — it IS the
demo content.

Prerequisites (once per machine): repo-root `.env` with `MONGODB_URI`,
`MONGODB_DB`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`; VPN off;
`pnpm install --config.minimum-release-age=0`.

## Step 0 — repair the embedding space (one-time backfill)

The vector store held two mutually-orthogonal embedding spaces (everything
seeded before ~21:41Z vs everything after — see PIPELINE-TEST.md). Fixed with
the new backfill command:

```
$ uberprompt reembed
re-embedding all vectors via voyage-3.5-lite (6 prompts, 3 lessons):
  re-embedded billing-agent v1: 4 fragment(s) + description
  re-embedded escalation-writer v1: 4 fragment(s) + description
  re-embedded satisfaction-summarizer v1: 2 fragment(s) + description
  re-embedded tech-support-agent v2: 4 fragment(s) + description
  re-embedded triage-router v1: 2 fragment(s) + description
  live-triage-router v1: no existing embeddings — skipped
  re-embedded lesson 6a7e3a0bb3d9ee3079df3665
  re-embedded lesson 6a7e40a40e6e3d1d94efeebe
  lesson 6a7e48bff26a86e687350cea: no embedding or text — skipped
re-embedded 16 fragment(s), 5 description(s), 2 lesson(s)

embedding-space verification:
  tech-support-agent.task vs triage-router.routing-rules: 0.849 (expected >= 0.8) OK
  tech-support-agent.task vs escalation-writer.escalation-criteria: 0.832 (expected >= 0.8) OK
  tech-support-agent.task vs satisfaction-summarizer.output-format: 0.752 (expected < 0.8) OK
```

The verification pairs reproduce PIPELINE-TEST.md's known-good measurements
(0.849 / 0.830 / 0.754) exactly — the space is whole again. `reembed` only
touches vectors that already exist, so the `live-triage-router` smoke prompt
(never embedded) stays out of the search space.

## Wave 1 — approve the pending lesson proposal

The pending stage-3 proposal `6a7e405c…` tightens `escalation-writer.context`
("refund ranges are internal triage estimates, never state amounts as
approved/issued"). One command runs the whole 3→4 seam:

```
$ uberprompt approve 6a7e405c535a1671b6a752d5
applied 6a7e405c535a1671b6a752d5: escalation-writer.context — v1 -> v2
  snapshot reused: prompt_versions 6a7e39e03344152a58f73bf5 (v1)
  snapshot created: prompt_versions 6a7e49c3d1df27bf444e20d2 (v2)
  fragment re-embedded (voyage-3.5-lite)

sync check: escalation-writer.context changed — walking the graph
  graph dependents (uses + semantic edges): 0
  semantic discovery ($vectorSearch, cosine >= 0.8, top 5): 2 hit(s)
    billing-agent.refund-policy  cosine 0.848
      NEW semantic edge escalation-writer.context -> refund-policy (confidence 0.848)
    billing-agent.task  cosine 0.839
      NEW semantic edge billing-agent.task -> escalation-writer.context (confidence 0.839)
  consistency check (gpt-5.1) over 2 dependent fragment(s):
    billing-agent.refund-policy  [semantic]
      INCONSISTENT: New context allows rough internal refund range estimates for specialists and adds a stronger prohibition abou…
      FILED 6a7e49c5d1df27bf444e20d5 for billing-agent.refund-policy
    billing-agent.task  [semantic]
      consistent: The billing-agent task fragment describes how the agent should handle refunds with respect to policy and lead…
1 sync-check proposal(s) filed — approve them to continue the wave
```

What happened: the declared graph had NO edge for this fragment, but vector
discovery surfaced `escalation-writer.context -> refund-policy` (0.848) — the
exact undeclared dependency `apps/demo/expected-semantic-edges.json` names as
the answer key for this fragment. Both discoveries were persisted as
`kind:"semantic"` edges; the LLM found one real contradiction and filed one
sync-check proposal; the other neighbor honestly passed.

## Wave 2 — approve the sync-check proposal; the ripple returns and stops

```
$ uberprompt approve 6a7e49c5d1df27bf444e20d5
applied 6a7e49c5d1df27bf444e20d5: billing-agent.refund-policy — v1 -> v2
  snapshot created: prompt_versions 6a7e49e0d04ebe72dbc7d383 (v1)
  snapshot created: prompt_versions 6a7e49e1d04ebe72dbc7d384 (v2)
  fragment re-embedded (voyage-3.5-lite)

sync check: billing-agent.refund-policy changed — walking the graph
  graph dependents (uses + semantic edges): 1
    escalation-writer.context  [semantic]  via refund-policy -> escalation-writer.context
  semantic discovery ($vectorSearch, cosine >= 0.8, top 5): 1 hit(s)
    escalation-writer.context  cosine 0.866
      edge escalation-writer.context -> refund-policy already known
  consistency check (gpt-5.1) over 1 dependent fragment(s):
    escalation-writer.context  [semantic]
      consistent: The dependent fragment already allows only rough/triage refund range estimates, explicitly says they are not …
0 sync-check proposal(s) filed — graph is quiet
```

The moment to point at on stage: the graph walk now traverses the semantic
edge wave 1 just inserted (`via refund-policy -> escalation-writer.context`),
vector discovery re-finds the same pair (0.866) and dedupes it, and the LLM
confirms the two fragments now agree. **Convergence in 2 waves.**

## Catch-up — manual sync on the earlier bump that fired into the void

`tech-support-agent` v1→v2 was approved before stage 4 existed
(PIPELINE-TEST.md). The manual command closes that loop:

```
$ uberprompt sync tech-support-agent
tech-support-agent v1 -> v2: 1 changed fragment(s): task

sync check: tech-support-agent.task changed — walking the graph
  graph dependents (uses + semantic edges): 0
  semantic discovery ($vectorSearch, cosine >= 0.8, top 5): 5 hit(s)
    escalation-writer.brand-voice  cosine 0.864
      NEW semantic edge tech-support-agent.task -> brand-voice (confidence 0.864)
    billing-agent.brand-voice  cosine 0.863
      edge tech-support-agent.task -> brand-voice already known
    triage-router.routing-rules  cosine 0.849
      NEW semantic edge triage-router.routing-rules -> tech-support-agent.task (confidence 0.849)
    satisfaction-summarizer.task  cosine 0.848
      NEW semantic edge satisfaction-summarizer.task -> tech-support-agent.task (confidence 0.848)
    escalation-writer.escalation-criteria  cosine 0.832
      NEW semantic edge tech-support-agent.task -> escalation-criteria (confidence 0.832)
  consistency check (gpt-5.1) over 5 dependent fragment(s):
    escalation-writer.brand-voice  [semantic]
      consistent: The new task text adds an escalation rule about legal mentions, but this does not contradict the brand-voice …
    billing-agent.brand-voice  [semantic]
      consistent: The new task fragment adds a specific escalation rule for mentions of legal action. The dependent brand-voice…
    triage-router.routing-rules  [semantic]
      consistent: Both fragments instruct routing/escalation whenever the customer mentions lawyers, legal action, or a regulat…
    satisfaction-summarizer.task  [semantic]
      consistent: The new behavior about escalating tickets mentioning legal issues applies to the tech-support-agent’s handlin…
    escalation-writer.escalation-criteria  [semantic]
      consistent: Both fragments require escalation when there is any mention of lawyers, legal action, or regulators. The new …
0 sync-check proposal(s) filed — graph is quiet
```

This surfaces the escalation cluster from the answer key
(`triage-router.routing-rules` at 0.849 and `escalation-criteria` at 0.832 —
the two known-good similarities), links them into the graph as semantic
edges, and honestly reports all five neighbors consistent (the earlier change
*agrees* with the escalation criteria). Note the dedupe: the second
brand-voice copy maps to the same shared-fragment edge and is skipped.

## End state (left in place, on purpose)

- `escalation-writer` v2, `billing-agent` v2, `tech-support-agent` v2 — each
  with complete pre+post `prompt_versions` snapshots (except
  tech-support-agent's v2 snapshot, whose approve predates the fix).
- 6 `kind:"semantic"` edges in `edges` with `confidence`/`model`/`inferredAt`,
  including both answer-key relationships.
- Proposals: the 2 sync-relevant ones `applied`; 2 `pending` brand-voice
  proposals from the stage-2/3 loop running in parallel (left for that
  workstream); Shlok's `evaluating` proposal untouched.

Rollback (verified separately on a scratch prompt, cleaned up after):
`uberprompt rollback <prompt> [--to <version>]` restores a snapshot as a NEW
version (v1 → v2 → rollback → v3 with v1's contentHash — append-only history)
and fires the same sync check.
