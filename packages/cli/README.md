# `uberprompt` CLI

Dependency graph + semantic-sync for prompt fragments, plus the stage-2 learn
loop. Zero-build plain Node ESM; dependencies are `@anthropic-ai/sdk` (`infer`),
`mongodb` and `openai` (`learn`).

## Install

Run it directly:

```sh
node packages/cli/bin/uberprompt.mjs <command>
```

or link it globally (from `packages/cli`):

```sh
npm link          # exposes `uberprompt` on PATH
uberprompt <command>
```

All commands take `--dir <path>` (a demo dir containing `prompts/`, `fragments/`,
`edges.json`). Default: `<repo-root>/apps/demo`.

## Commands

- **`graph`** — print each shared fragment with its dependents. Declared `uses`
  edges are plain; discovered `semantic` edges are marked `⚠` with confidence.
  `--json` for machine output.
- **`affected <node>`** — node mode: pass one prompt (`billing-agent`), shared
  fragment (`escalation-criteria`), or local fragment
  (`triage-router.routing-rules`) and get both directions with backing files:
  what depends on it (affected by a change) and what it depends on.
- **`affected [--base <ref>] [--staged]`** — git mode: map git-changed
  prompt/fragment files to graph nodes and report the affected dependents (with via-path + edge
  kind). Default compares the working tree against `HEAD`. Always exits 0.
  `--json` for machine output.
- **`infer [--apply] [--threshold 0.7]`** — ask the model (`claude-opus-5`) for
  undeclared **semantic** edges: fragments that restate/paraphrase/constrain the
  same rule such that editing one should trigger review of the other. Prints
  proposals by default; `--apply` merges them into `edges.json` as `semantic`
  edges (`note`, `confidence`, `model`, `inferredAt`), never duplicating an
  existing edge and never touching declared `uses` edges. Needs
  `ANTHROPIC_API_KEY` (env or a repo-root `.env`); exits 1 with a clear message
  if unset.
- **`learn [--limit 50] [--model gpt-5.1] [--dry-run]`** — stage 2 of the
  pipeline (the demo's "hit analyze" button; on-demand, no daemon). Loads the
  most recent unanalyzed `traces` with a prompt binding
  (`{ promptName: { $exists: true } }`, minus traces already referenced by a
  lesson's `sourceTraceIds`), asks the model for recurring failure patterns
  (error field, score < 0.5, negative user replies in outputs), then per
  candidate lesson: embeds the text via Voyage (`voyage-3.5-lite`, 1024 dims),
  dedupes with `$vectorSearch` against the `lessons_embedding` index (skip when
  similarity > 0.92 vs an active lesson), and inserts into `lessons` per the
  IDEA.md contract. Prints a summary: traces analyzed / lessons written /
  deduped. `--dry-run` prints candidates without embedding or writing. Needs
  `MONGODB_URI` and `OPENAI_API_KEY` (+ `VOYAGE_API_KEY` unless `--dry-run`)
  from env or the repo-root `.env`; exits 1 naming any missing var.
  Embeddings default to `https://ai.mongodb.com/v1/embeddings` (Atlas-issued
  Voyage keys only work there, not on `api.voyageai.com`); set `VOYAGE_API_URL`
  to override for a direct Voyage key.

## Example — the raise-escalation-threshold scenario

```sh
# 1. Raise the churn threshold $5k -> $10k in the shared escalation-criteria.
node apps/demo/scenarios/apply.mjs raise-escalation-threshold

# 2. The declared graph only reaches escalation-writer.
node packages/cli/bin/uberprompt.mjs affected
#   changed: escalation-criteria
#     -> escalation-writer  [uses]

# 3. Infer discovers that triage-router's local routing-rules paraphrases the
#    same threshold, and adds the semantic edge.
node packages/cli/bin/uberprompt.mjs infer --apply
#   Applied 1 semantic edge(s): triage-router.routing-rules -> escalation-criteria

# 4. affected now also flags triage-router (via the inferred edge).
node packages/cli/bin/uberprompt.mjs affected
#   changed: escalation-criteria
#     -> escalation-writer            [uses]
#     -> triage-router.routing-rules  [semantic] ⚠
#     -> triage-router                [contains]

# revert when done
node apps/demo/scenarios/apply.mjs raise-escalation-threshold --revert
```
