---
layout: home

hero:
  name: üBerprompt
  text: Prompt dependency graph & semantic sync
  tagline: Trace, learn, apply, sync — one pipeline for production prompt management
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: CLI Reference
      link: /cli/

features:
  - title: Trace Ingestion
    details: OTLP spans from any language — SDK or standalone collector. Every LLM call lands in MongoDB as a structured span, rolled up into traces automatically.
  - title: Dependency Graph
    details: Declared and semantic edges between prompts and shared fragments. See what depends on what, and what breaks when something changes.
  - title: Semantic Sync
    details: Version bump ripples through the graph, catching contradictions automatically. An agent rewrites affected prompts to stay consistent.
---
