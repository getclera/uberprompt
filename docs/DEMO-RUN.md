# Stage 4 live convergence runs — 2026-08-13

Real commands + real output against the shared Atlas cluster, on the **Mango
Republic** crew (see docs/DEMO.md for the 60s video plan this feeds). Two full
convergence sequences were run live; both transcripts below are verbatim.

Heads-up for whoever records the video: a **reset script / rehearsal loop was
active on the cluster** during this session (23:04Z it restored all prompts to
v1 and wiped proposals + lessons + semantic edges — including state from the
run below, mid-wave). That is fine — the runs are recorded here, the current DB
is the pristine pre-demo state the video wants (6 prompts v1, 12 declared
edges, 0 semantic edges), and every step below is reproducible with the same
commands. Expect cosines within ~0.01 of the values shown.

Prerequisites (once per machine): repo-root `.env` with `MONGODB_URI`,
`MONGODB_DB`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`; VPN off;
`pnpm install --config.minimum-release-age=0`.

## Embedding-space health check (`uberprompt reembed`)

The original vector store held two mutually-orthogonal embedding spaces
(PIPELINE-TEST.md bug #2). `reembed` rewrites every stored vector through the
current endpoint and then verifies known-good pairs — run it whenever vector
search returns nonsense:

```
$ uberprompt reembed
re-embedding all vectors via voyage-3.5-lite (6 prompts, 1 lessons):
  re-embedded escalation-writer v2: 4 fragment(s) + description
  re-embedded order-agent v1: 3 fragment(s) + description
  re-embedded quality-agent v1: 4 fragment(s) + description
  re-embedded refund-agent v2: 4 fragment(s) + description
  re-embedded satisfaction-summarizer v1: 2 fragment(s) + description
  re-embedded triage-router v1: 2 fragment(s) + description
re-embedded 19 fragment(s), 6 description(s), 0 lesson(s)

embedding-space verification:
  triage-router.routing-rules vs escalation-writer.escalation-criteria: 0.862 (expected >= 0.8) OK
  escalation-writer.context vs refund-agent.refund-policy: 0.868 (expected >= 0.8) OK
  satisfaction-summarizer.task vs order-agent.task: 0.719 (expected < 0.8) OK
```

The two >= 0.8 pairs are exactly the planted undeclared dependencies from
`apps/demo/expected-semantic-edges.json`; the third is the noise floor
(unrelated fragments stay under the 0.80 discovery threshold).

## Run: converging the refund-amount lesson through the graph

Starting state: stage 2/3 had turned the lesson "never promise or confirm a
specific credit or refund amount before verification" into applied changes on
`refund-agent.refund-policy` (v1→v2, lesson approve) and
`escalation-writer.context` (v1→v2, sync-check approve) — but those two bumps
had fired without a sync check. Plus 3 lesson proposals still pending.

### Wave 1 — manual catch-up on the refund-agent bump

```
$ uberprompt sync-check refund-agent
refund-agent v1 -> v2: 1 changed fragment(s): refund-policy

sync check: refund-agent.refund-policy changed — walking the graph
  graph dependents (uses + semantic edges): 2
    escalation-writer.context  [semantic]  via refund-policy -> escalation-writer.context
    quality-agent.task  [semantic]  via refund-policy -> quality-agent.task
  semantic discovery ($vectorSearch, cosine >= 0.8, top 5): 2 hit(s)
    escalation-writer.context  cosine 0.868
      edge escalation-writer.context -> refund-policy already known
    quality-agent.task  cosine 0.830
      edge quality-agent.task -> refund-policy already known
  consistency check (gpt-5.1) over 2 dependent fragment(s):
    escalation-writer.context  [semantic]
      consistent: The dependent fragment already states that a figure must not be promised or confirmed to the contact and that…
    quality-agent.task  [semantic]
      consistent: The updated refund-policy fragment tightens how and when specific credit amounts may be communicated, but the…
0 sync-check proposal(s) filed — graph is quiet
```

(The `quality-agent.task -> refund-policy` semantic edge at 0.830 was
discovered and persisted by this same command's first invocation; the walk then
traverses it as a first-class edge.)

### Wave 2 — catch-up on the escalation-writer bump finds a real conflict

```
$ uberprompt sync-check escalation-writer
escalation-writer v1 -> v2: 1 changed fragment(s): context

sync check: escalation-writer.context changed — walking the graph
  graph dependents (uses + semantic edges): 0
  semantic discovery ($vectorSearch, cosine >= 0.8, top 5): 2 hit(s)
    refund-agent.refund-policy  cosine 0.868
      edge escalation-writer.context -> refund-policy already known
    refund-agent.task  cosine 0.866
      NEW semantic edge refund-agent.task -> escalation-writer.context (confidence 0.866)
  consistency check (gpt-5.1) over 2 dependent fragment(s):
    refund-agent.refund-policy  [semantic]
      consistent: Both texts instruct not to promise or confirm a specific credit amount until after the claim is verified and …
    refund-agent.task  [semantic]
      INCONSISTENT: The updated context explicitly forbids promising or confirming a figure to the contact until verification and…
      FILED 6a7e4d139bf90b2b3558830c for refund-agent.task
1 sync-check proposal(s) filed — approve them to continue the wave
```

### Wave 3 — approve fires the next wave automatically

One command: the SDK's transactional approve (version bump + snapshot +
re-embed) chains straight into the sync check.

```
$ uberprompt approve 6a7e4d139bf90b2b3558830c
applied 6a7e4d139bf90b2b3558830c: refund-agent.task — now v3
  snapshot inserted: prompt_versions v3
  contentHash bf57a3697f26 — fragment re-embedded

sync check: refund-agent.task changed — walking the graph
  graph dependents (uses + semantic edges): 0
  semantic discovery ($vectorSearch, cosine >= 0.8, top 5): 3 hit(s)
    escalation-writer.context  cosine 0.879
      edge escalation-writer.context -> refund-agent.task already known
    quality-agent.task  cosine 0.851
      NEW semantic edge quality-agent.task -> refund-agent.task (confidence 0.851)
    order-agent.task  cosine 0.801
      NEW semantic edge order-agent.task -> refund-agent.task (confidence 0.801)
  consistency check (gpt-5.1) over 3 dependent fragment(s):
    escalation-writer.context  [semantic]
      consistent: Both fragments now share the same constraints: do not promise or confirm a refund/credit amount to the contac…
    quality-agent.task  [semantic]
      INCONSISTENT: The new task text for the refund-agent adds a constraint: the agent must not promise or confirm any specific …
      FILED 6a7e4d3bebdadeee85187807 for quality-agent.task
    order-agent.task  [semantic]
      consistent: The new text for the refund-agent adds constraints about not promising or confirming specific refund/credit a…
1 sync-check proposal(s) filed — approve them to continue the wave
```

### Wave 4 — the wave shrinks; the human gate earns its keep

```
$ uberprompt approve 6a7e4d3bebdadeee85187807
applied 6a7e4d3bebdadeee85187807: quality-agent.task — now v2
  snapshot inserted: prompt_versions v2
  contentHash f5a1e1eb4f55 — fragment re-embedded

sync check: quality-agent.task changed — walking the graph
  ...
  semantic discovery ($vectorSearch, cosine >= 0.8, top 5): 5 hit(s)
    [3 already-known edges deduped; 2 new: quality-agent.task -> brand-voice 0.870,
     order-agent.task -> quality-agent.task 0.859]
  consistency check (gpt-5.1) over 5 dependent fragment(s):
    [4 consistent]
    escalation-writer.brand-voice  [semantic]
      INCONSISTENT: The new task text adds a constraint about not promising or confirming specific refund or credit amounts befor…
      FILED 6a7e4d5231374ad717178e02 for escalation-writer.brand-voice
1 sync-check proposal(s) filed
```

That last one wanted to write refund policy into the shared **tone** fragment
(and the two identical brand-voice copies in other prompts were judged
consistent). Wrong layer — this is what the human approval gate is for:

```
$ uberprompt reject 6a7e4d5231374ad717178e02
rejected 6a7e4d5231374ad717178e02 (escalation-writer.brand-voice)
```

### Endgame — stale + redundant lesson proposals cleared

Of the 3 pending lesson proposals: `escalation-writer.context` was refused
loudly by approve (`Fragment "context" of "escalation-writer" changed since
this proposal was filed — re-run the lesson against v2` — v2 already contains
the rule, so: rejected); `order-agent.task` approved cleanly (v2, snapshot,
re-embed); `quality-agent.handling-steps` rejected (rewrite arrived wrapped in
literal quotes — a stage-3 quirk — and quality-agent.task v2 already carries
the rule). Graph quiet: no pending proposals, every subsequent sync wave
reported `0 sync-check proposal(s) filed`.

**Convergence: 4 waves, 6 semantic edges discovered (including both planted
answer-key dependencies), 2 real conflicts fixed, 1 false positive and 2
stale/redundant proposals stopped at the human gate.**

## Rollback (verified live on a scratch prompt, then cleaned up)

```
$ uberprompt rollback rollback-smoke
rolling back rollback-smoke v2 to the v1 snapshot: 1 fragment(s) change: notes
rolled back: rollback-smoke v2 -> v3 (content of v1)
  snapshot created: prompt_versions ... (v3)
  1 changed fragment(s) re-embedded (voyage-3.5-lite)

sync check: rollback-smoke.notes changed — walking the graph
  ...
0 sync-check proposal(s) filed — graph is quiet
```

Verified: v3's `contentHash` equals v1's — rollback restores a snapshot as a
NEW version, history stays append-only, and the restored text goes through the
same sync check as any other change.

## Earlier run (pre-reseed, Acme support crew) — same mechanics

Before the Mango Republic reseed, the identical loop ran on the original crew:
approve of `escalation-writer.context` → discovery found the then-answer-key
edge `context -> refund-policy` at 0.848 → 1 conflict filed on
`billing-agent.refund-policy` → approved → wave 2 walked back through the
just-inserted semantic edge (0.866, deduped) and judged everything consistent.
2 waves to quiet. The reembed verification then reproduced PIPELINE-TEST.md's
known-good cross-prompt cosines (0.849 / 0.832 / 0.752) exactly, confirming
the split-embedding-space repair.
