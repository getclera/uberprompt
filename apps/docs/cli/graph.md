# uberprompt graph

Render the prompt dependency graph as a 2D map in the terminal.

## Usage

```bash
uberprompt graph [node]
```

Without arguments, renders the full graph: prompts on the left, shared fragments on the right, connected by colored edge buses.

With a `node` argument (a prompt name or fragment key), shows the impact tree for that specific node -- its direct and transitive dependencies and dependents.

## Flags

| Flag | Description |
|------|-------------|
| `--tree` | Render as an indented tree instead of a 2D map |
| `--json` | Output the graph as JSON |
| `--no-color` | Disable colored output |

## Examples

Full graph:

```
$ uberprompt graph

  PROMPTS                    FRAGMENTS
  ─────────────────────────  ────────────────────
  triage-router         ──── brand-voice
  escalation-writer     ─┬── refund-policy
  refund-checker        ─┤   escalation-criteria
  resolution-summarizer ─┴── output-format
  faq-responder         ────
```

Impact tree for a single node:

```
$ uberprompt graph refund-policy --tree

refund-policy
├── used by: escalation-writer
├── used by: refund-checker
└── semantic: resolution-summarizer (0.82)
```

JSON output:

```bash
uberprompt graph --json | jq '.edges[] | select(.kind == "semantic")'
```
