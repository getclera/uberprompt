# uberprompt sync-check

Check the dependents of a changed prompt for contradictions. File a consistency proposal for each one found.

## Usage

```bash
uberprompt sync-check <prompt> [--against <p.f>] [--dry-run] [--model <m>]
```

This is stage 4 of the pipeline. Run it after a version bump, whether from `approve`, a human edit, or a prior sync-check. It:

1. Diffs the current prompt version against the latest `prompt_versions` snapshot to find changed fragments
2. Walks `edges` (declared `uses` + discovered `semantic`) via `$graphLookup` to collect transitive dependents
3. Runs vector search to discover undeclared semantic dependents and persists new `kind:"semantic"` edges
4. Asks an LLM whether each dependent fragment contradicts the change
5. Files a `"sync-check"` proposal (minimal rewrite) for each contradiction
6. Repeats until a wave finds no new contradictions

## Flags

| Flag | Description |
|------|-------------|
| `--against <p.f>` | Also check this prompt.fragment as a dependent (format: `prompt-name.fragment-key`) |
| `--dry-run` | Print proposals without writing them to the database |
| `--model <m>` | LLM to use for contradiction checking and rewrite generation (default: `gpt-5.1`) |

## Examples

Run sync-check after approving a change to refund-checker:

```
$ uberprompt sync-check refund-checker

Diffing refund-checker v3 → v4...
  changed fragment: refund-policy

Walking dependents...
  declared:  escalation-writer (uses)
  semantic:  resolution-summarizer (0.82)

Checking for contradictions...
  escalation-writer / context: contradiction found
    filed proposal [6693a1...]
  resolution-summarizer / summary-rules: ok

1 sync-check proposal filed
```

Include an extra fragment to check:

```bash
uberprompt sync-check refund-checker --against faq-responder.returns-faq
```

Preview without writing:

```bash
uberprompt sync-check refund-checker --dry-run
```

## Prerequisites

Run [`uberprompt init`](/cli/init) first. Set `MONGODB_URI` in your `.env` file.
