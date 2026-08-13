# Hackathon submission — MongoDB Persistent Context Sprint

**überprompt** — by Talwinder, Shlok, Felix & Julian (Build Fest, Aug 13 2026)

## Blurb

Your prompts are a team. überprompt keeps them semantically in sync.

Prompts in a real AI product are a distributed system: shared tone-of-voice
fragments, duplicated policy rules, agents whose prompts must agree with each
other. Change one and the others silently drift. And nobody closes the loop from
production traces back into prompt improvements — every AI team does it by hand,
reading logs and pasting edits.

überprompt closes that loop on MongoDB Atlas, end to end. Apps emit standard
OpenTelemetry spans (via our SDK hook or plain OTLP from any language); spans
land in Mongo and roll up into traces pinned to the exact prompt version that
produced them. An analyzer mines trace batches into lessons — durable, embedded
memory entries, vector-deduped against what the system already knows. Lessons
become minimal-edit proposals, targeted at the right prompts by a
lineage → LLM-catalog → vector-RAG ladder. A human approves the diff; the version
bumps, an immutable content-hashed snapshot freezes, the fragment re-embeds.

Then the part nobody else does: the bump ripples. überprompt walks the prompt
dependency graph — declared edges plus semantic edges discovered by vector
similarity, the dependencies nobody wrote down — LLM-checks each dependent for
contradiction, and files consistency proposals until the graph goes quiet.

Atlas is the whole nervous system: documents for prompts and versions, three
Vector Search indexes for memory, targeting, and discovery, change streams with
persisted resume tokens as the event bus, `$graphLookup` for the ripple,
`$merge` for the trace rollup. Memory, state, retrieval, events — one platform,
zero bolt-ons.

## Why it wins

- **Technical depth** — a real OTel→Atlas ingestion pipeline (idempotent
  `$merge` rollup, content-addressed prompt versioning with append-only
  snapshots), vector-discovered *undeclared* prompt dependencies that the
  declared graph provably misses —
  all verified live in [PIPELINE-TEST.md](PIPELINE-TEST.md) with real output.
- **Impact** — closes the traces → lessons → edits → consistency loop that
  every AI team runs manually today; prompt drift across agents stops being a
  code-review problem and becomes a system property.
- **MongoDB-native** — documents, Atlas Vector Search (3 indexes), change
  streams, `$graphLookup`, `$merge`, `$jsonSchema` validators, TTL and wildcard
  indexes; the database *is* the agent's memory — no vector-DB sidecar, no
  queue, no bolt-ons.
