---
layout: home

hero:
  name: "<span class=\"u-pink\">über</span>Prompt"
  text: Prompt dependency graph & semantic sync
  tagline: Trace, learn, apply, sync. One pipeline for production prompt management.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: CLI Reference
      link: /cli/

features:
  - title: Trace Ingestion
    details: OTLP spans from any language, via the SDK or the standalone collector. Every LLM call lands in MongoDB as a span and rolls up into a trace.
    link: /cli/collect
    linkText: See collect →
  - title: Dependency Graph
    details: Declared and semantic edges between prompts and shared fragments. See what depends on what, and what breaks when something changes.
    link: /cli/graph
    linkText: See graph →
  - title: Semantic Sync
    details: After a version bump, sync-check walks the graph and finds prompts that now contradict the change. It files a minimal rewrite for each one.
    link: /cli/infer
    linkText: See infer →
---
