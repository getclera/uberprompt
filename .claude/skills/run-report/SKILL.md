---
name: run-report
description: Regenerate the überprompt pipeline run report — a published dark-theme Artifact telling the story of one full run (traces → lesson → targeting → apply → semantic sync → convergence) from live Mongo data. Use when the user says "make the run report", "regenerate the run report", "visualize the run", "visualize the pipeline", or after a pipeline run finishes.
---

# run-report — regenerable pipeline-run artifact

Produces the demo-quality run report at the existing artifact URL. A fresh session
with zero conversation context should be able to follow this file end to end.

## 0. Prerequisites (do these BEFORE writing any HTML)

1. Load the `artifact-design` skill (page design calibration).
2. Load the `artifact-diagramming` skill (the dependency graph is hand-authored inline SVG).
3. Load the `dataviz` skill (stat tiles / any chart; use its status palette on dark).
4. Mongo access: `MONGODB_URI` + `MONGODB_DB` in the repo-root `.env` (read-only for
   this task; never print the URI). `mongosh` is typically NOT installed — use node
   with the workspace driver:

```js
const { MongoClient } = require('<repo-root>/packages/sdk/node_modules/mongodb');
require('fs').readFileSync('<repo-root>/.env','utf8').split('\n')
  .forEach(l => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2]; });
```

## 1. Gather the run's data (all queries against db `uberprompt`)

Pick `T` = the run's start (the `ts` of the run's lesson, or the user-given window).
Exclude smoke/test prompts everywhere: `live-triage-router`, `rollback-smoke`, and
any name containing `__stale`. The real crew is exactly: `triage-router`,
`billing-agent`, `tech-support-agent`, `escalation-writer`, `satisfaction-summarizer`
plus shared fragments `brand-voice`, `refund-policy`, `escalation-criteria`,
`output-format`.

| Beat | Query |
|---|---|
| Lessons of the run | `lessons.find({ ts: { $gte: T } })` — text, reason, `sourceTraceIds.length` (evidence count), `appliesTo` (lineage), status, `processedAt` |
| Trace census | `traces.aggregate([{ $match: { promptName: { $exists: true } } }, { $group: { _id: "$promptName", n: { $sum: 1 }, err: { $sum: { $cond: [{ $ifNull: ["$error", false] }, 1, 0] } } } }])` |
| Proposals + diffs | `proposals.find({ ts: { $gte: T } }).sort({ ts: 1 })` — `target`, `status` (`evaluating/pending/applied/rejected`), `source.type` (`lesson` / `sync-check` / `human-edit`), `source.ref`, `oldText`, `newText`, `reason` |
| Eval-gate census | `eval_runs.find({ ts: { $gte: T } })` — per proposal: `summary.baselineAvg`, `summary.candidateAvg`, `summary.passed`, `summary.goldenRegressions` |
| Edges | `edges.find({})` — `kind: "uses"` (declared) vs `kind: "semantic"` (agent-discovered; carries `confidence`, `model`, `inferredAt`). Semantic edges are the stage-4 payoff — label each with its similarity/confidence |
| Version bumps | Current versions from `prompts.find({}, { name: 1, version: 1 })`. Quirk: `prompt_versions` snapshots the PRE-change version at approve time, so it runs one behind — the applied diff for prompt P is `prompts` (current doc) vs the latest older `prompt_versions` snapshot for P, or simply the applied proposal's `oldText`/`newText` |
| Wave grouping | Group proposals by `source.type` + timestamp order: `source.type: "lesson"` proposals = wave 0 (initial targeting/apply); each `source.type: "sync-check"` cluster after an applied bump = ripple wave 1, 2, … A wave that files 0 proposals = convergence |

Targeting-ladder attribution (section 3): a proposal whose `target.prompt` is in the
lesson's `appliesTo` = rung 1 (lineage); other lesson-sourced proposals = rung 2
(catalog); rung 3 (RAG over `descriptions_embedding`) rarely adds targets — report
it as "cleared" with the prompts it did not flag.

## 2. The artifact — structure and design intents

One dark, single-theme page (deliberate stage-demo choice), mono for labels/data,
sans for prose, ~1100px column, six numbered sections top to bottom:

1. **The run at a glance** — 7 stat tiles: traces analyzed, lesson mined, prompts
   targeted, proposals filed/applied, versions bumped, dependents checked, waves to
   convergence. Accent the bump tile (amber) and the convergence tile (green).
2. **The learning** — the lesson as a card: quoted text, reason, evidence
   ("n failing traces"), lineage (`appliesTo`, which prompt's traces produced it),
   status + timestamps. Sibling lessons of the same day get a secondary card.
3. **Targeting** — the 3-rung ladder rendered as rungs (lineage / catalog / RAG),
   each listing which prompts it caught (with the gate verdict: rejected/applied,
   real baseline→candidate eval scores) vs cleared. Close with the eval-gate census
   strip (filed / eval runs / rejected / applied / pending).
4. **The dependency graph** — the centerpiece, hand-authored inline SVG (no
   libraries). Prompts as one row of rect nodes, shared fragments as a row of pill
   nodes below. Visual states: **changed** node amber border + glow + `v1 → v2` tag;
   **checked-and-consistent** nodes calm green border + "✓ checked · consistent";
   **unaffected** nodes at ~0.4 opacity. Edge styles: solid gray = `uses`
   (declared), dashed cyan = `semantic` (vector-discovered), each dashed edge
   labeled with its cosine/confidence score. Legend row below with all five
   encodings. Must read in 5 seconds from a stage.
5. **What changed** — diffs grouped by wave: "wave 0 · initial apply" (lesson
   source), "wave 1 · sync-check ripple", … Each diff card: `prompt.fragment`,
   version bump `vN → vN+1`, source tag, status tag, then old text with `<del>` and
   new text with `<ins>` (red/green tints, mono). Sync-check rows that found no
   contradiction render as "✓ consistent — no rewrite needed" with the LLM verdict
   quote. Pending proposals go in a "queued · next run" list.
6. **Converged** — versions-after-the-run table (bumped row accented), the pending
   inbox count as a hero number (`N → 0`), and a data-provenance footer.

**Honesty rule:** everything from the queries renders unmarked; any value that is
expected-but-not-yet-landed (e.g. semantic edges not yet persisted) gets a small
dashed `◌ projected` chip, and the footer lists exactly which values are projected.
Never invent numbers — projected values must come from a measured source (e.g.
`apps/demo/expected-semantic-edges.json`, the answer key) and be labeled.

## 3. Publish

Write the page to a scratch file (e.g. `/tmp/uberprompt-run-report/run-report.html`),
then publish with the Artifact tool:

- title `überprompt — run report`, favicon `🔁` — keep both stable across regens.
- **Reuse the existing URL**: if this conversation hasn't published it, call the
  Artifact tool with `action: "list"`, find the artifact titled
  "überprompt — run report", and pass its URL as `url` when publishing. Only if
  none exists, publish fresh (which mints the URL future regens reuse).
- Do not commit the generated HTML; only this skill lives in the repo.
