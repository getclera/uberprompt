# uberprompt infer

Ask a model to discover undeclared semantic edges between fragments.

## Usage

```bash
uberprompt infer
```

Reads all prompt and fragment files, sends their texts to the model (`gpt-5-nano`), and identifies pairs of fragments that are semantically related but have no declared `uses` edge. Discovered edges are written back to `apps/demo/edges.json` with `kind: "semantic"`.

## Flags

| Flag | Description |
|------|-------------|
| `--threshold <n>` | Minimum confidence score (0-1) to accept an edge (default: 0.7) |
| `--apply` | Write discovered edges to `edges.json` immediately |
| `--json` | Output results as JSON |

## Examples

Preview inferred edges without writing:

```
$ uberprompt infer

Inferred semantic edges:
  escalation-criteria ↔ refund-policy        (0.85)
  brand-voice ↔ output-format                (0.72)

2 edges found above threshold (0.70)
Run with --apply to write to edges.json
```

Apply with a higher threshold:

```bash
uberprompt infer --threshold 0.85 --apply
```

## How it works

1. Loads all fragment texts from `apps/demo/fragments/` and inline fragments from `apps/demo/prompts/`
2. Skips fragments with empty text (runtime input slots like `{{ticket}}`)
3. Sends fragment pairs to the model for semantic similarity assessment
4. Filters results by the confidence threshold
5. With `--apply`, merges new edges into `edges.json` (existing edges are preserved)
