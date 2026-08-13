# uberprompt approve

Apply a pending proposal: snapshot the current version, rewrite the fragment, bump the version, and re-embed via Voyage.

## Usage

```bash
uberprompt approve <id>
```

Takes a proposal ObjectId and applies the change. The approval flow:

1. Snapshots the current prompt state to `prompt_versions` (with `contentHash`)
2. Rewrites the target fragment with the proposal's `newText`
3. Bumps the prompt's `version` number
4. Re-embeds the changed fragment via Voyage AI
5. Sets the proposal status to `"applied"`

The version bump may trigger a downstream [sync-check](/cli/sync-check) if change-stream consumers are running.

## Examples

Approve a proposal by its ObjectId:

```
$ uberprompt approve 6692f1a3b2c4d5e6f7890123

Approved: refund-checker v3 → v4
  fragment: refund-policy
  snapshot: prompt_versions 6692f1a3b2c4d5e6f7890124
  embedding: updated (1024d)
```

Typical workflow -- list then approve:

```bash
uberprompt proposals
uberprompt approve 6692f1a3b2c4d5e6f7890123
```

## Prerequisites

Set `MONGODB_URI` and `VOYAGE_API_KEY` in your `.env` file. The proposal must have status `"pending"`.
