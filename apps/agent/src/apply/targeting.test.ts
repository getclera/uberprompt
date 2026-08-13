import { test } from "node:test";
import assert from "node:assert/strict";
import type { LessonDoc } from "@uberprompt/sdk";
import {
  RAG_MIN_SCORE,
  targetPrompts,
  type CatalogEntry,
  type DescriptionHit,
  type TargetingDeps,
} from "./targeting";

function makeLesson(overrides: Partial<LessonDoc> = {}): LessonDoc {
  return {
    text: "Never promise a specific refund amount before checking the account.",
    reason: "Three billing traces promised wrong amounts.",
    embedding: [0.1, 0.2, 0.3],
    sourceTraceIds: [],
    appliesTo: ["billing-agent"],
    status: "active",
    ts: new Date(),
    ...overrides,
  };
}

function makeCatalog(): CatalogEntry[] {
  return [
    {
      name: "billing-agent",
      description: "Handles billing tickets",
      template: "{{task}}\n{{refund-policy}}",
      fragmentKeys: ["task", "refund-policy"],
    },
    {
      name: "escalation-writer",
      description: "Writes escalation summaries",
      template: "{{context}}\n{{format}}",
      fragmentKeys: ["context", "format"],
    },
    {
      name: "triage-router",
      description: "Routes tickets to queues",
      template: "{{routing-rules}}",
      fragmentKeys: ["routing-rules"],
    },
  ];
}

interface FakeSetup {
  deps: TargetingDeps;
  llmPrompts: string[];
  searchedEmbeddings: number[][];
}

function makeDeps(
  catalogTargets: Array<{ prompt: string; reason: string }>,
  ragHits: DescriptionHit[],
  catalog: CatalogEntry[] = makeCatalog(),
): FakeSetup {
  const llmPrompts: string[] = [];
  const searchedEmbeddings: number[][] = [];
  const deps: TargetingDeps = {
    callJson: async <T>(prompt: string) => {
      llmPrompts.push(prompt);
      return { targets: catalogTargets } as T;
    },
    fetchCatalog: async () => catalog,
    searchDescriptions: async (embedding) => {
      searchedEmbeddings.push(embedding);
      return ragHits;
    },
  };
  return { deps, llmPrompts, searchedEmbeddings };
}

test("lineage-only: appliesTo prompts come back when no other rung fires", async () => {
  const { deps } = makeDeps([], []);
  const hits = await targetPrompts(makeLesson({ appliesTo: ["billing-agent", "triage-router"] }), deps);
  assert.deepEqual(
    hits.map((h) => ({ prompt: h.prompt, rung: h.rung })),
    [
      { prompt: "billing-agent", rung: "lineage" },
      { prompt: "triage-router", rung: "lineage" },
    ],
  );
});

test("dedupe: a lineage prompt is not re-emitted by catalog or rag", async () => {
  const { deps } = makeDeps(
    [
      { prompt: "billing-agent", reason: "restates the refund rule" },
      { prompt: "escalation-writer", reason: "summarizes refund outcomes" },
    ],
    [
      { prompt: "billing-agent", score: 0.95 },
      { prompt: "triage-router", score: 0.88 },
    ],
  );
  const hits = await targetPrompts(makeLesson(), deps);
  assert.deepEqual(
    hits.map((h) => ({ prompt: h.prompt, rung: h.rung })),
    [
      { prompt: "billing-agent", rung: "lineage" },
      { prompt: "escalation-writer", rung: "catalog" },
      { prompt: "triage-router", rung: "rag" },
    ],
  );
});

test("a catalog prompt is not re-emitted by rag", async () => {
  const { deps } = makeDeps(
    [{ prompt: "escalation-writer", reason: "restates the refund rule" }],
    [{ prompt: "escalation-writer", score: 0.9 }],
  );
  const hits = await targetPrompts(makeLesson({ appliesTo: [] }), deps);
  assert.deepEqual(
    hits.map((h) => h.rung),
    ["catalog"],
  );
});

test("result is ordered lineage then catalog then rag", async () => {
  const { deps } = makeDeps(
    [{ prompt: "escalation-writer", reason: "r" }],
    [{ prompt: "triage-router", score: 0.83 }],
  );
  const hits = await targetPrompts(makeLesson(), deps);
  assert.deepEqual(
    hits.map((h) => h.rung),
    ["lineage", "catalog", "rag"],
  );
});

test("a hallucinated prompt name from the catalog LLM is dropped", async () => {
  const { deps } = makeDeps(
    [
      { prompt: "refund-bot-9000", reason: "made up" },
      { prompt: "escalation-writer", reason: "real" },
    ],
    [],
  );
  const hits = await targetPrompts(makeLesson(), deps);
  assert.deepEqual(
    hits.map((h) => h.prompt),
    ["billing-agent", "escalation-writer"],
  );
});

test("a rag hit naming a prompt outside the catalog is dropped", async () => {
  const { deps } = makeDeps([], [{ prompt: "ghost-prompt", score: 0.99 }]);
  const hits = await targetPrompts(makeLesson({ appliesTo: [] }), deps);
  assert.deepEqual(hits, []);
});

test("a rag hit below the score floor is dropped", async () => {
  const { deps } = makeDeps(
    [],
    [
      { prompt: "triage-router", score: RAG_MIN_SCORE - 0.01 },
      { prompt: "escalation-writer", score: RAG_MIN_SCORE },
    ],
  );
  const hits = await targetPrompts(makeLesson({ appliesTo: [] }), deps);
  assert.deepEqual(
    hits.map((h) => ({ prompt: h.prompt, rung: h.rung, score: h.score })),
    [{ prompt: "escalation-writer", rung: "rag", score: RAG_MIN_SCORE }],
  );
});

test("every hit carries a human-readable reason", async () => {
  const { deps } = makeDeps(
    [{ prompt: "escalation-writer", reason: "restates the refund rule in its own words" }],
    [{ prompt: "triage-router", score: 0.83 }],
  );
  const hits = await targetPrompts(makeLesson(), deps);
  assert.equal(hits.length, 3);
  for (const hit of hits) {
    assert.ok(hit.reason.length > 0);
  }
  assert.equal(hits[0]?.reason, "produced the failing traces behind this lesson");
  assert.equal(hits[1]?.reason, "restates the refund rule in its own words");
  assert.equal(hits[2]?.reason, "0.83 similarity to lesson");
});

test("empty appliesTo still yields catalog and rag hits", async () => {
  const { deps, searchedEmbeddings } = makeDeps(
    [{ prompt: "billing-agent", reason: "owns the refund flow" }],
    [{ prompt: "triage-router", score: 0.8 }],
  );
  const lesson = makeLesson({ appliesTo: [] });
  const hits = await targetPrompts(lesson, deps);
  assert.deepEqual(
    hits.map((h) => ({ prompt: h.prompt, rung: h.rung })),
    [
      { prompt: "billing-agent", rung: "catalog" },
      { prompt: "triage-router", rung: "rag" },
    ],
  );
  assert.deepEqual(searchedEmbeddings, [lesson.embedding]);
});

test("duplicate appliesTo entries collapse to one lineage hit", async () => {
  const { deps } = makeDeps([], []);
  const hits = await targetPrompts(
    makeLesson({ appliesTo: ["billing-agent", "billing-agent"] }),
    deps,
  );
  assert.equal(hits.length, 1);
});

test("catalog prompt carries name, description, template, fragment keys, and the lineage exclusion", async () => {
  const { deps, llmPrompts } = makeDeps([], []);
  await targetPrompts(makeLesson(), deps);
  const sent = llmPrompts[0];
  assert.ok(sent);
  assert.ok(sent.includes("name: escalation-writer"));
  assert.ok(sent.includes("description: Writes escalation summaries"));
  assert.ok(sent.includes("template: {{context}}\n{{format}}"));
  assert.ok(sent.includes("fragment keys: context, format"));
  assert.ok(sent.includes("Already targeted, do not repeat: billing-agent"));
  assert.ok(sent.includes("Never promise a specific refund amount"));
});

test("an empty catalog skips the LLM call", async () => {
  const { deps, llmPrompts } = makeDeps([], [], []);
  const hits = await targetPrompts(makeLesson(), deps);
  assert.equal(llmPrompts.length, 0);
  assert.deepEqual(
    hits.map((h) => h.rung),
    ["lineage"],
  );
});

test("a catalog LLM failure propagates instead of being swallowed", async () => {
  const { deps } = makeDeps([], []);
  deps.callJson = async () => {
    throw new Error("catalog rung down");
  };
  await assert.rejects(targetPrompts(makeLesson(), deps), /catalog rung down/);
});

test("a rag search failure propagates instead of being swallowed", async () => {
  const { deps } = makeDeps([], []);
  deps.searchDescriptions = async () => {
    throw new Error("vector search down");
  };
  await assert.rejects(targetPrompts(makeLesson(), deps), /vector search down/);
});
