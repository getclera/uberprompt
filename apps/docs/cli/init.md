# uberprompt init

Create the trace-ingestion collections and indexes required by the pipeline.

## Usage

```bash
uberprompt init
```

Connects to the MongoDB database in `MONGODB_URI` and creates the following if they don't exist:

**Collections:**
- `spans`: raw OpenTelemetry spans, one per LLM call or tool execution
- `traces`: rollup documents, one per root operation (derived from spans via `$merge`)

**Indexes:**
- `traces.traceId`: unique, required for the `$merge` rollup to be idempotent
- `spans.traceId` + `spans.startTime`: compound, for span lookups
- `spans.spanId`: unique

Without the unique `traceId` index on `traces`, the rollup pipeline appends duplicate documents instead of updating in place.

## Example

```
$ uberprompt init

Connected to MongoDB
Created collection: spans
Created index: spans.spanId_1 (unique)
Created index: spans.traceId_1_startTime_1
Created index: traces.traceId_1 (unique)
Done
```

## Prerequisites

Set `MONGODB_URI` in your `.env` file at the repo root:

```
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/uberprompt
```

If the password contains special characters (like `!`), URL-encode them (`!` becomes `%21`).
