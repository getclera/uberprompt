# uberprompt tail

Print recent traces and stream new ones as they arrive.

## Usage

```bash
uberprompt tail
```

Prints the most recent traces from the `traces` collection, then opens a MongoDB change stream to display new traces in real time as they are ingested.

## Output

Each trace is printed as a single line with key fields:

```
$ uberprompt tail

[12:34:01] triage-router v3  model=gpt-5.1  latency=1240ms  tokens=850  ok
[12:34:03] faq-responder v2  model=gpt-5.1  latency=890ms   tokens=620  ok
[12:34:05] escalation-writer v1  model=gpt-5.1  latency=2100ms  tokens=1420  error: timeout
  ⏳ watching for new traces...
[12:35:12] refund-checker v4  model=gpt-5.1  latency=1050ms  tokens=780  ok
```

Traces without a prompt binding (from OTLP sources that don't use the SDK) show the operation name instead of a prompt name.

## How it works

1. Queries the `traces` collection for recent documents, sorted by `ts` descending
2. Prints each trace summary
3. Opens a change stream on `traces` with `fullDocument: "updateLookup"`
4. Prints each new or updated trace as it arrives
5. Runs until interrupted (Ctrl+C)

## Prerequisites

Run [`uberprompt init`](/cli/init) first to create the required collections and indexes.

Set `MONGODB_URI` in your `.env` file.
