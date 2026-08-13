# `uberprompt` CLI

Dependency graph + semantic-sync for prompt fragments. Zero-build plain Node ESM;
LLM calls go through the Vercel AI SDK (`ai` + `@ai-sdk/openai`, needed by `infer`).

## Install

First install the dependencies (once, from `packages/cli` — `npm link` alone
does not install them):

```sh
npm install
```

Then run it directly:

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
- **`propose [--dry-run] [--model gpt-5.1]`** — stage 3. Consume lessons with no
  `processedAt` from Mongo, target prompts via the ladder (lineage `appliesTo` →
  catalog LLM pass → `$vectorSearch` over `descriptions_embedding`), and file
  minimal-rewrite proposals (one per prompt+fragment, identical pending dupes
  skipped). Stamps `lesson.processedAt`. `--dry-run` writes nothing. Needs
  `MONGODB_URI`, `MONGODB_DB`, `OPENAI_API_KEY`.
- **`proposals [--all]`** — list pending (default) or all proposals with a
  compact word-level old→new diff.
- **`approve <id>` / `reject <id>`** — approve snapshots the current prompt into
  `prompt_versions` (with `contentHash`), applies `newText` to the target
  fragment, bumps the version, re-embeds the fragment via Voyage
  (`ai.mongodb.com`, voyage-3.5-lite), and marks the proposal `applied` — this
  version bump is what triggers the stage-4 sync check. Reject just flips the
  status. Approve also needs `VOYAGE_API_KEY`.
- **`infer [--apply] [--threshold 0.7]`** — ask the model (`gpt-5-nano`) for
  undeclared **semantic** edges: fragments that restate/paraphrase/constrain the
  same rule such that editing one should trigger review of the other. Prints
  proposals by default; `--apply` merges them into `edges.json` as `semantic`
  edges (`note`, `confidence`, `model`, `inferredAt`), never duplicating an
  existing edge and never touching declared `uses` edges. Needs
  `OPENAI_API_KEY` (env or a repo-root `.env`); exits 1 with a clear message
  if unset.

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
