# Demo plan — 1-minute Mango Republic video

## Prompt & decisions

- Initial prompt: "lets setup the demo, so we can demo it in 1 minute. write a demo plan"
- Q&A:
  - Timing? → **60s final VIDEO**; record ~2 min, cut in edit. No strict live timing.
  - LLM calls live? → **Pre-run is fine**; it's a recording, retakes allowed.
  - Kick off setup? → Yes, via agents (seed, probe runner, rehearsal, reset script).
  - Terminal-only (dashboard parked).

## The story (one sentence)

Editing one shared policy fragment silently breaks an agent that only *paraphrases*
it — überprompt finds the hidden dependency via embeddings, fixes the prompt, and
the same customer ticket visibly changes lanes.

## Recording script (~2 min take, cut to 60s)

Three prepped tmux panes: **A** = commands, **B** = `uberprompt tail` (live traces),
**C** = probe-ticket runner. Pauses between steps are fine — cut in edit.

| t | Action (pane) | Say |
|---|---|---|
| 0:00 | A: `uberprompt graph` (already on screen) | "Six support agents of a mango wholesaler, four shared prompt fragments. These are the *declared* dependencies." |
| 0:10 | A: `node apps/demo/scenarios/apply.ts raise-escalation-threshold` + reseed | "Business decision: only escalate churn on accounts above $100k, was $50k. We edit the shared escalation policy." |
| 0:20 | C: run FreshMart probe ticket ($70k churn risk) | "This $70k cancellation ticket should now be a normal sales conversation — but the router still escalates it. Why? It *paraphrased* the old policy; no declared edge." |
| 0:30 | A: `uberprompt sync-check <prompt>` | "Sync agent embeds the changed fragment, vector-searches every other fragment in Atlas — finds the paraphrase, files a fix proposal." |
| 0:45 | A: `uberprompt proposals` + `uberprompt approve <id>` | "Here's the minimal diff on the router's routing rules. Approve — version bump, snapshot, re-embed." |
| 0:55 | C: rerun same probe ticket | "Same ticket, lane flips escalation → order. Graph is consistent again. All state — prompts, versions, edges, embeddings, traces — one MongoDB." |

LLM latency doesn't matter on video — long waits get cut; a failed call means a
retake, so the reset script (task 5) is the critical piece.

## Setup status

- Probe runner: `node apps/demo/scenarios/run-ticket.ts` — loads triage-router
  from Mongo, calls gpt-5.1, prints lane. Verified: FreshMart $70k ticket →
  `escalation` (confidence 0.97) on v1 state, ~1.3s.
- Reset: `node apps/demo/scenarios/reset.ts` — reverts scenario file edits,
  wipes demo collections, reseeds v1 prompts/edges/traces. Verified live.
- Still open: mid-part rehearsal (scenario apply → push v2 to Mongo with
  prompt_versions snapshot → `uberprompt sync-check` finds the routing-rules
  paraphrase → approve → probe flips to `order`), timings for those steps.

## Setup tasks (before stage)

1. **Env + Atlas ready**: `.env` complete (MONGODB_URI, OPENAI_API_KEY,
   VOYAGE_API_KEY), no VPN, indexes created (`pnpm -F @uberprompt/sdk create-indexes`).
2. **Seed**: `pnpm -F @uberprompt/sdk seed-demo` with the Mango Republic set;
   verify prompts/fragments/edges/traces in Atlas.
3. **Verify the flip end-to-end once** (rehearsal, timed):
   scenario apply → reseed → probe ticket (escalates) → sync-check → approve →
   probe ticket (orders). Record actual wall-clock of each step; if sync-check
   or infer exceed ~15s, decide pre-warm strategy.
4. **Probe-ticket runner**: confirm what runs `scenarios/raise-escalation-threshold/ticket.json`
   against triage-router live (and that its trace shows in `tail`). Build a tiny
   runner if missing — this is the only possibly-missing piece.
5. **Reset script**: one command that restores v1 state (revert scenario, reseed,
   clear proposals/lessons) so the demo is repeatable back-to-back.
6. **tmux layout**: 3 panes prepped, commands in shell history, font size up.

## Risks

- Scenario edits files but sync-check reads Mongo — the apply→reseed→snapshot
  ordering must be verified so sync-check sees a version diff (task 3).
- Repeatability: every retake needs clean v1 state — reset script must be solid.
- Atlas + VPN kills TLS — record with VPN off.

---
Plan file: [docs/DEMO.md](docs/DEMO.md)
