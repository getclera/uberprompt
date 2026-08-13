# Mango Republic Crew — demo prompt set

A small, realistic crew of prompts for **Mango Republic**, a mango wholesaler and
importer that sells crates and pallets to supermarkets, juice factories, and
restaurants. It seeds the überprompt dependency graph with a spread of shared
fragments, prompt-local fragments, and — deliberately — two **undeclared semantic
dependencies** the sync agent is meant to discover on its own.

The crew:

- **triage-router** — classifies an inbound message into `order | refund | quality | escalation`, outputs JSON.
- **order-agent** — handles new orders, reorders, pallet/crate pricing, and delivery slots.
- **refund-agent** — handles credit notes and refunds for shipments that arrived in bad shape.
- **quality-agent** — handles quality complaints (overripe on arrival, cold-chain break, wrong ripeness grade) and ripening-room advice.
- **escalation-writer** — writes internal escalation summaries for the sales director.
- **satisfaction-summarizer** — summarizes resolved conversations + sentiment.

## File format

Two directories, one JSON file per unit. Both shapes mirror the `prompts`
collection contract in [`docs/IDEA.md`](../../docs/IDEA.md).

### Shared fragment — `fragments/*.json`

Reusable text shared across prompts. One fragment per file.

```json
{ "key": "brand-voice", "version": 1, "text": "…" }
```

### Prompt — `prompts/*.json`

```json
{
  "name": "refund-agent",
  "version": 1,
  "template": "{{brand-voice}}\n{{task}}\n{{refund-policy}}",
  "fragments": [ { "key": "task", "text": "…" } ],
  "uses": ["brand-voice", "refund-policy", "output-format"]
}
```

- `template` — the assembled prompt, referencing fragment keys as `{{key}}`.
  Keys resolve against **both** the prompt's local `fragments` and the shared
  fragments named in `uses`. Runtime inputs (e.g. `{{ticket}}`, `{{message}}`)
  are declared as local fragments with empty `text`, filled per call.
- `fragments` — **prompt-local** fragments only. Shared fragments are not
  duplicated here; they live in `fragments/` and are pulled in via `uses`.
- `uses` — the shared fragment keys this prompt depends on (the declared `uses`
  edges in the graph).

### Version semantics

`version` is an integer, starts at `1`, and is **bumped on every text change**
to the fragment or prompt. This mirrors the `prompts` collection contract: the
current version lives here, and each change freezes an immutable snapshot in
`prompt_versions`.

A local fragment with empty `text` is a **runtime input slot** (`{{ticket}}`,
`{{message}}`, …), filled at render time. Embedding and semantic-edge inference
skip empty-text fragments.

## Shared-fragment usage matrix

| Prompt | brand-voice | refund-policy | escalation-criteria | output-format |
|---|:---:|:---:|:---:|:---:|
| triage-router | | | | ✓ |
| order-agent | ✓ | | | ✓ |
| refund-agent | ✓ | ✓ | | ✓ |
| quality-agent | ✓ | | | ✓ |
| escalation-writer | ✓ | | ✓ | ✓ |
| satisfaction-summarizer | | | | ✓ |

## Intentional undeclared semantic dependencies

These are **not** in any `uses` list. The prompt restates shared knowledge in
its own words, so the declared graph misses the link — the sync agent must find
it via fragment similarity, and flag drift when the shared source changes.

1. **triage-router → escalation-criteria.** The local `routing-rules` fragment
   paraphrases the shared escalation criteria (food-safety triggers, churn risk
   on a high-value account, three-plus repeated contacts, legal/press/health-
   authority threats) inline instead of referencing `escalation-criteria`.
2. **escalation-writer → refund-policy.** The local `context` fragment loosely
   restates parts of the refund policy (48-hour claim window, per-crate
   crediting, large credits needing sales-director approval, never promise an
   amount) without using the shared `refund-policy` fragment.

## Demo scenarios

Scripted, reversible edits for the stage demo live in `scenarios/`:

```
node apps/demo/scenarios/apply.mjs raise-escalation-threshold          # apply
node apps/demo/scenarios/apply.mjs raise-escalation-threshold --revert # undo
```

`raise-escalation-threshold` bumps the churn-risk threshold in
`escalation-criteria` from $50,000 to $100,000 per year (version bump included).
The declared graph only reaches `escalation-writer`; the sync agent must *infer*
that `triage-router.routing-rules` paraphrases the old threshold and propose the
fix. Each scenario's `expected` block is the acceptance test for the inference,
and `ticket.json` is a $70k FreshMart churn probe whose routing flips from
`escalation` to `order` once the inferred proposal is applied.
