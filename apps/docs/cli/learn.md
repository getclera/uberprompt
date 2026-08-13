# uberprompt learn

Stage 2 of the pipeline: mine production traces into durable lessons. Lessons are the agent's persistent memory.

## Usage

```bash
uberprompt learn [--limit <n>] [--model <m>] [--dedup-threshold <t>] [--dry-run]
```

Reads recent traces that carry a prompt binding (`promptName`). Traces with an `error` or a `score` below 0.5 come first, most recent first. Traces are grouped by prompt, and one LLM call per group mines durable lessons, not one-off incident reports. Each lesson is embedded via Voyage and vector-deduped against existing active lessons before insert.

## Flags

| Flag | Description |
|------|-------------|
| `--limit <n>` | Maximum traces to read (default: 100) |
| `--model <m>` | LLM used for mining (default: `gpt-5.1`) |
| `--dedup-threshold <t>` | Cosine similarity above which a mined lesson counts as a duplicate (default: 0.92) |
| `--dry-run` | Run the full pipeline including dedup, but write nothing |

## Examples

Preview what a run would learn:

```
$ uberprompt learn --dry-run --limit 20

refund-agent: 4 trace(s)
  lesson: Never promise or state that a specific refund/credit amount has been approved…
    would insert as new lesson

satisfaction-summarizer: 2 trace(s)
  healthy — no lessons

dry-run: 14 trace(s) read, 7 lesson(s) mined, 7 would be inserted, 0 merged into duplicates
```

Run for real with a stricter dedup cutoff:

```bash
uberprompt learn --dedup-threshold 0.95
```

## How it works

1. Selects up to `--limit` traces with `{ promptName: { $exists: true } }`: error/low-score traces first, then the rest, both newest first
2. Groups traces by `promptName` and asks the model for durable lessons per group. A healthy group yields zero lessons
3. Embeds each lesson text (Voyage, 1024-d)
4. `$vectorSearch` on the `lessons_embedding` index finds the nearest active lesson. At or above the threshold the new lesson is **not** inserted; the existing lesson gains the new `sourceTraceIds` and `appliesTo` entries via `$addToSet`
5. Otherwise inserts `{ text, reason, embedding, sourceTraceIds, appliesTo, status: "active", ts }`

Vector dedup is the stage's idempotency mechanism: re-running `learn` over the same traces merges into existing lessons instead of duplicating them. Traces are never mutated. `processedAt` is never set here. Stage 3 (`uberprompt propose`) stamps it when it consumes the lesson.

## Environment

Requires `MONGODB_URI`, `MONGODB_DB`, `OPENAI_API_KEY`, and `VOYAGE_API_KEY` in the repo-root `.env`.
