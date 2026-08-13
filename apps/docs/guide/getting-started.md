# Getting Started

überPrompt traces your LLM calls and builds a dependency graph between prompts and shared fragments. When a prompt changes, it checks the graph and keeps dependent prompts consistent.

## Prerequisites

- Node.js 20+
- pnpm 9+
- A MongoDB Atlas cluster (or local MongoDB 7+)
- A `MONGODB_URI` connection string in your `.env`

## Install

Clone the repo and install dependencies:

```bash
git clone https://github.com/getclera/-berprompt.git
cd -berprompt
pnpm install --config.minimum-release-age=0
```

The `--config.minimum-release-age=0` flag is required. Some dependencies are younger than pnpm's default 24h supply-chain threshold and the install fails without it.

## Initialize the database

Create the required collections and indexes in your MongoDB database:

```bash
pnpm --filter @uberprompt/cli exec uberprompt init
```

This creates the `spans` collection and a unique index on `traces.traceId` that the rollup pipeline needs.

## Seed the demo data

Load the demo prompts, fragments, edges, and seed traces:

```bash
pnpm --filter demo exec node seed.mjs
```

## Start collecting traces

Run the OTLP/HTTP receiver. Any OpenTelemetry-instrumented app can send spans to it:

```bash
pnpm --filter @uberprompt/cli exec uberprompt collect --port 4318
```

If your app uses `@uberprompt/sdk`, you can skip the collector. Call `registerUberprompt()` at startup and spans go straight to MongoDB.

## Watch traces arrive

Stream recent and incoming traces:

```bash
pnpm --filter @uberprompt/cli exec uberprompt tail
```

## Next steps

- [CLI Reference](/cli/) for all available commands
- [graph](/cli/graph) to visualize the dependency graph
- [affected](/cli/affected) to see what a change impacts
- [infer](/cli/infer) to discover undeclared semantic edges
- [Example run report](https://claude.ai/code/artifact/1220fb44-dbc2-4063-8f70-d0a05f670dda) showing the full pipeline end to end
