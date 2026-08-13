# uberprompt affected

Show which prompts are affected by changes to prompt or fragment files.

## Usage

```bash
uberprompt affected [node]
```

**With a node argument:** shows the dependencies and dependents of that prompt or fragment, along with the backing files on disk.

**Without a node argument:** detects git-changed prompt and fragment files, then walks the dependency graph to find all transitively affected prompts.

## Flags

| Flag | Description |
|------|-------------|
| `--base <ref>` | Git ref to diff against (default: `HEAD`) |
| `--staged` | Only consider staged changes |
| `--json` | Output as JSON |

## Examples

Check what a specific fragment affects:

```
$ uberprompt affected refund-policy

refund-policy
  file: apps/demo/fragments/refund-policy.json
  dependents:
    escalation-writer  (uses)
    refund-checker     (uses)
    resolution-summarizer (semantic, 0.82)
```

Find all prompts affected by uncommitted changes:

```
$ uberprompt affected

Changed files:
  M apps/demo/fragments/refund-policy.json

Affected prompts:
  escalation-writer     (via refund-policy, uses)
  refund-checker        (via refund-policy, uses)
  resolution-summarizer (via refund-policy, semantic)
```

Check what would be affected by staged changes only:

```bash
uberprompt affected --staged
```

Diff against a specific branch:

```bash
uberprompt affected --base main
```
