# Getting Started

überPrompt is a prompt management pipeline that traces LLM calls, builds a dependency graph between prompts and shared fragments, and keeps them semantically in sync.

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

The `--config.minimum-release-age=0` flag is required because some dependencies are newer than pnpm's default 24h supply-chain threshold.

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

Run the OTLP/HTTP receiver to accept spans from any OpenTelemetry-instrumented application:

```bash
pnpm --filter @uberprompt/cli exec uberprompt collect --port 4318
```

Or, if your app uses the `@uberprompt/sdk`, call `registerUberprompt()` at startup to write spans directly to MongoDB without a separate collector.

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
