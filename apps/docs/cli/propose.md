# uberprompt propose

Turn unprocessed lessons into pending proposals.

## Usage

```bash
uberprompt propose [--dry-run] [--model <m>]
```

Reads lessons that have no `processedAt` timestamp and generates prompt-change proposals. Each lesson is matched to target prompts by the targeting ladder, in order:

1. **Lineage**: the prompts whose traces produced the lesson (`lesson.appliesTo`)
2. **Catalog reasoning**: an LLM reads the full prompt catalog and picks other prompts the lesson applies to
3. **RAG**: vector search of the lesson embedding against prompt description embeddings

Proposals are written to the `proposals` collection with status `"pending"`. Identical pending proposals are skipped. Proposals for the same prompt are grouped, so one approval produces one version bump.

## Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Print proposals without writing them to the database |
| `--model <m>` | LLM to use for catalog reasoning and rewrite generation (default: `gpt-5.1`) |

## Examples

Generate proposals from all unprocessed lessons:

```
$ uberprompt propose

Processing 2 unprocessed lessons...

Lesson: "never promise a credit amount before checking the delivery record"
  lineage: refund-checker
  catalog: escalation-writer (LLM match)
  Filed 2 proposals

Lesson: "always include order number in escalation context"
  lineage: triage-router
  Filed 1 proposal

3 proposals filed
```

Preview without writing:

```bash
uberprompt propose --dry-run
```

## Prerequisites

Requires lessons in the database (produced by `uberprompt learn`). Set `MONGODB_URI` in your `.env` file.
