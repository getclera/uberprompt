# Überprompt

## What we do

- Tracing
- Evals
- Auto updating prompts
- Dependency prompt management

## CLI quickstart

One command, from the repo root:

```sh
npm i -g ./packages/cli
```

That puts `uberprompt` on your PATH (installs its one dependency too). Then:

```sh
uberprompt graph                          # dependency graph
uberprompt affected escalation-criteria   # what depends on this / what it depends on
uberprompt affected                       # impact of your uncommitted changes
uberprompt infer --apply                  # discover undeclared semantic edges (needs ANTHROPIC_API_KEY)
```

Run it from anywhere inside the repo (it finds `apps/demo` via git). Hacking on
the CLI itself? Use `cd packages/cli && npm link` instead — that symlinks, so
your edits apply live.

Details + examples: `packages/cli/README.md`.
