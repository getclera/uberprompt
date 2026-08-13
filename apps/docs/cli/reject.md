# uberprompt reject

Mark a pending proposal as rejected.

## Usage

```bash
uberprompt reject <id>
```

Sets the proposal's status to `"rejected"`. The prompt is not modified and no version bump occurs. Rejected proposals are hidden from `uberprompt proposals` by default (use `--all` to see them).

## Examples

Reject a proposal by its ObjectId:

```
$ uberprompt reject 6692f2b3c4d5e6f78901abcd

Rejected: escalation-writer / context
```

Review and reject:

```bash
uberprompt proposals
uberprompt reject 6692f2b3c4d5e6f78901abcd
```

## Prerequisites

Set `MONGODB_URI` in your `.env` file. The proposal must have status `"pending"`.
