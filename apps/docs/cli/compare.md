# uberprompt compare

Per-prompt version comparison: traces, error rate, score, latency, tokens, and version-over-version delta.

## Usage

```bash
uberprompt compare [prompt]
```

Without arguments, compares the two most recent versions of every prompt that has traces. With a `prompt` argument, shows the comparison for that prompt only.

For each version pair the output shows trace count, error rate, average score, p50/p95 latency, average token usage, and the delta between versions. The delta tells you whether the new version helped.

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Output machine-readable JSON |

## Examples

Compare all prompts:

```
$ uberprompt compare

refund-checker
  v2 (38 traces)  err=2.6%  score=4.1  p50=980ms  tokens=740
  v3 (24 traces)  err=0.0%  score=4.6  p50=1020ms tokens=810
  delta            err -2.6%  score +0.5  p50 +40ms  tokens +70

escalation-writer
  v1 (52 traces)  err=5.8%  score=3.8  p50=1850ms tokens=1380
  v2 (19 traces)  err=0.0%  score=4.3  p50=1720ms tokens=1290
  delta            err -5.8%  score +0.5  p50 -130ms tokens -90
```

Compare a single prompt:

```bash
uberprompt compare refund-checker
```

JSON output for CI integration:

```bash
uberprompt compare --json | jq '.[] | select(.delta.errorRate < 0)'
```

## Prerequisites

Requires traces in the database. Set `MONGODB_URI` in your `.env` file.
