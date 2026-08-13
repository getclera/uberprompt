# Überprompt

## What we do

- Tracing
- Evals
- Auto updating prompts
- Dependency prompt management

## CLI quickstart

One command, from the repo root:

```sh
cd packages/cli && npm link
```

That symlinks `uberprompt` onto your PATH (and installs its one dependency).
Because it is a symlink into your checkout, every `git pull` updates the CLI
automatically — no reinstall. Then:

```sh
uberprompt graph                          # dependency graph
uberprompt affected escalation-criteria   # what depends on this / what it depends on
uberprompt affected                       # impact of your uncommitted changes
uberprompt infer --apply                  # discover undeclared semantic edges (needs OPENAI_API_KEY)
```

Run it from anywhere inside the repo (it finds `apps/demo` via git). If a later
pull adds a new dependency to `packages/cli/package.json`, run `npm install`
there once. Prefer a fixed copy instead of the live symlink? `npm i -g ./packages/cli`.

Details + examples: `packages/cli/README.md`.
