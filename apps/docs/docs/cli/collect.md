# uberprompt collect

Run an OTLP/HTTP receiver that accepts OpenTelemetry spans and writes them to MongoDB.

## Usage

```bash
uberprompt collect [--port <n>] [--service <name>]
```

Starts an HTTP server that accepts OTLP span exports on the standard `/v1/traces` endpoint. Incoming spans are normalized and written to the `spans` collection, then rolled up into the `traces` collection using the same pipeline as the in-process SDK exporter.

This lets any application that speaks OTLP -- regardless of language or framework -- feed traces into the dependency graph.

## Flags

| Flag | Description |
|------|-------------|
| `--port <n>` | Port to listen on (default: `4318`, the OTLP/HTTP standard) |
| `--service <name>` | Default service name for spans that don't carry one |

## Examples

Start the collector on the default port:

```
$ uberprompt collect

OTLP receiver listening on :4318
```

Use a custom port and service name:

```bash
uberprompt collect --port 9999 --service my-agent
```

Point an OpenTelemetry SDK at it:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
node my-app.js
```

## Prerequisites

Run [`uberprompt init`](/cli/init) first to create the required collections and indexes.

Set `MONGODB_URI` in your `.env` file.
