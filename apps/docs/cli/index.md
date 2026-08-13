# CLI Reference

The `uberprompt` CLI provides file-first tooling for prompt dependency management, trace ingestion, and semantic edge inference.

## Installation

The CLI lives in `packages/cli` and is available as `@uberprompt/cli`:

```bash
pnpm --filter @uberprompt/cli exec uberprompt <command>
```

Or link it globally:

```bash
cd packages/cli && pnpm link --global
uberprompt <command>
```

## Global options

| Flag | Description |
|------|-------------|
| `--help` | Show help for any command |
| `--json` | Output machine-readable JSON (supported by `graph`, `affected`, `infer`) |
| `--no-color` | Disable colored terminal output |

## Commands

| Command | Description |
|---------|-------------|
| [`graph`](/cli/graph) | Render the prompt dependency graph |
| [`affected`](/cli/affected) | Show prompts affected by file changes |
| [`infer`](/cli/infer) | Discover undeclared semantic edges |
| [`init`](/cli/init) | Create trace-ingestion collections and indexes |
| [`collect`](/cli/collect) | Run an OTLP/HTTP span receiver |
| [`tail`](/cli/tail) | Print recent traces and stream new ones |
| [`compare`](/cli/compare) | Compare prompt versions by traces, error rate, latency |
| [`propose`](/cli/propose) | Generate proposals from unprocessed lessons |
| [`proposals`](/cli/proposals) | List pending proposals with inline diffs |
| [`approve`](/cli/approve) | Apply a proposal (snapshot, rewrite, version bump) |
| [`reject`](/cli/reject) | Mark a pending proposal as rejected |
| [`sync-check`](/cli/sync-check) | Check dependents for contradictions after a version bump |

## Environment

The CLI reads `MONGODB_URI` from `.env` at the repo root for commands that interact with the database (`init`, `collect`, `tail`, `compare`, `propose`, `proposals`, `approve`, `reject`, `sync-check`).

The `graph`, `affected`, and `infer` commands operate on the local file system (`apps/demo/` prompt and edge files) and do not require a database connection.
