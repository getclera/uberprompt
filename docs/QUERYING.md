# Querying the MongoDB database

Connection comes from `.env` in the repo root (gitignored — never commit or print values):

- `MONGODB_URI` — Atlas connection string (password's `!` is URL-encoded as `%21`)
- `MONGODB_DB` — database name, `uberprompt`

## Option 1: MongoDB MCP (Claude sessions)

The repo's Claude setup ships a preconfigured `mongodb` MCP server (connectionId `preconfigured`).
Use `mcp__mongodb__*` tools (`list-collections`, `find`, `aggregate`, `count`, ...) — no setup needed.

## Option 2: Node one-off script

No `mongosh` on the machines so far — use the `mongodb` driver via Node instead.

The driver is a workspace dependency; it resolves in any checkout where `pnpm install` has run
(remember `--config.minimum-release-age=0`, see CLAUDE.md). Run scripts from a package directory
so `mongodb` resolves, e.g. `packages/sdk`:

```js
// query.ts — run with: node query.ts (from a directory where `mongodb` resolves)
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);

const client = new MongoClient(env.MONGODB_URI);
await client.connect();
const db = client.db(env.MONGODB_DB);

const traces = await db.collection('traces').find({ score: { $lt: 0.5 } }).limit(5).toArray();
console.log(traces);

await client.close();
```

## Collections (see IDEA.md for authoritative schemas)

`prompts`, `prompt_versions`, `traces`, `spans`, `lessons`, `proposals`, `eval_runs`, `edges`

Quick census one-liner (from a directory where `mongodb` resolves):

```js
const cols = await db.listCollections().toArray();
for (const c of cols) console.log(c.name, await db.collection(c.name).countDocuments());
```

## Gotchas

- Atlas + VPN don't mix — TLS handshake dies and looks like a bad password. Disconnect VPN first.
- Vector queries (`$vectorSearch`) need the Atlas Vector Search indexes from IDEA.md; plain `find` works regardless.
