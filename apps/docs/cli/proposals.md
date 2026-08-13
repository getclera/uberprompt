# uberprompt proposals

List pending proposals with a compact old-to-new diff.

## Usage

```bash
uberprompt proposals [--all]
```

Displays all proposals with status `"pending"`, showing the target prompt and fragment, the reason for the change, and a compact inline diff of the old and new text.

## Flags

| Flag | Description |
|------|-------------|
| `--all` | Include `applied` and `rejected` proposals too, not just pending |

## Examples

List pending proposals:

```
$ uberprompt proposals

[6692f1...] refund-checker / refund-policy  (pending)
  reason: never promise a credit amount before checking the delivery record
  - "We will issue a credit of $X for your order."
  + "We will review your delivery record and determine the appropriate resolution."

[6692f2...] escalation-writer / context  (pending)
  reason: always include order number in escalation context
  - "Customer reported an issue with their order."
  + "Customer reported an issue with order {{orderNumber}}."

2 pending proposals
```

Include historical proposals:

```
$ uberprompt proposals --all

[6692f1...] refund-checker / refund-policy  (pending)
  ...
[6692e0...] triage-router / routing-rules  (applied)
  ...
[6692d8...] faq-responder / tone  (rejected)
  ...
```

## Prerequisites

Set `MONGODB_URI` in your `.env` file.
