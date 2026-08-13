import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EVAL_RUNS_VALIDATOR,
  FRAGMENTS_TEXT_INDEX,
  PROPOSALS_TTL_INDEX,
  PROPOSALS_VALIDATOR,
} from "../scripts/create-indexes";
import {
  LESSONS_WATCH_PIPELINE,
  buildDependentsPipeline,
  buildEvalTrendPipeline,
  buildLessonsWatchOptions,
  buildLiteralMatchesPipeline,
  buildRelatedFragmentsPipeline,
  buildSimilarFragmentsPipeline,
  flattenDependentsRows,
  parseServerVersion,
  supportsRankFusion,
} from "./queries";
import type { EdgeDoc } from "./types";

const demoEdges = JSON.parse(
  readFileSync(new URL("../../../apps/demo/edges.json", import.meta.url), "utf8"),
) as EdgeDoc[];

const semanticFixture = JSON.parse(
  readFileSync(new URL("../../../apps/demo/expected-semantic-edges.json", import.meta.url), "utf8"),
) as { edges: EdgeDoc[] };

function directEdgesTo(edges: EdgeDoc[], fragment: string) {
  return edges.filter((edge) => edge.to.fragment === fragment).map((edge) => ({ ...edge, chain: [] }));
}

test("buildDependentsPipeline emits $match then $graphLookup over edges", () => {
  const pipeline = buildDependentsPipeline({ fragment: "brand-voice" }, 5);
  assert.deepEqual(pipeline[0], { $match: { "to.fragment": "brand-voice" } });
  const graphLookup = (pipeline[1] as { $graphLookup: Record<string, unknown> }).$graphLookup;
  assert.equal(graphLookup.from, "edges");
  assert.equal(graphLookup.startWith, "$from.prompt");
  assert.equal(graphLookup.connectFromField, "from.prompt");
  assert.equal(graphLookup.connectToField, "to.prompt");
  assert.equal(graphLookup.depthField, "chainDepth");
  assert.equal(graphLookup.maxDepth, 3);
});

test("buildDependentsPipeline matches prompt-and-fragment targets and clamps maxDepth", () => {
  const pipeline = buildDependentsPipeline({ prompt: "escalation-writer", fragment: "context" }, 1);
  assert.deepEqual(pipeline[0], {
    $match: { "to.prompt": "escalation-writer", "to.fragment": "context" },
  });
  const graphLookup = (pipeline[1] as { $graphLookup: { maxDepth: number } }).$graphLookup;
  assert.equal(graphLookup.maxDepth, 0);
});

test("declared uses edges resolve brand-voice dependents at depth 1", () => {
  const hits = flattenDependentsRows(directEdgesTo(demoEdges, "brand-voice"), 5);
  assert.deepEqual(hits, [
    { prompt: "billing-agent", kind: "uses", depth: 1 },
    { prompt: "escalation-writer", kind: "uses", depth: 1 },
    { prompt: "tech-support-agent", kind: "uses", depth: 1 },
  ]);
});

test("semantic edges surface prompt-local fragment dependents of refund-policy", () => {
  const allEdges = [...demoEdges, ...semanticFixture.edges];
  const hits = flattenDependentsRows(directEdgesTo(allEdges, "refund-policy"), 5);
  assert.deepEqual(hits, [
    { prompt: "billing-agent", kind: "uses", depth: 1 },
    { prompt: "escalation-writer", fragment: "context", kind: "semantic", depth: 1 },
  ]);
});

test("chain rows map graphLookup depth to hop count and dedupe to min depth", () => {
  const rows = [
    {
      from: { prompt: "billing-agent" },
      to: { fragment: "refund-policy" },
      kind: "uses" as const,
      chain: [
        {
          from: { prompt: "satisfaction-summarizer" },
          to: { prompt: "billing-agent" },
          kind: "uses" as const,
          chainDepth: 0,
        },
        {
          from: { prompt: "billing-agent" },
          to: { prompt: "satisfaction-summarizer" },
          kind: "uses" as const,
          chainDepth: 1,
        },
      ],
    },
  ];
  const hits = flattenDependentsRows(rows, 5);
  assert.deepEqual(hits, [
    { prompt: "billing-agent", kind: "uses", depth: 1 },
    { prompt: "satisfaction-summarizer", kind: "uses", depth: 2 },
  ]);
  assert.deepEqual(flattenDependentsRows(rows, 1), [
    { prompt: "billing-agent", kind: "uses", depth: 1 },
  ]);
});

test("buildSimilarFragmentsPipeline emits $vectorSearch with exclude filter and minScore gate", () => {
  const vector = [0.1, 0.2];
  const pipeline = buildSimilarFragmentsPipeline(vector, {
    excludePrompt: "billing-agent",
    limit: 5,
    minScore: 0.8,
  });
  const vs = (pipeline[0] as { $vectorSearch: Record<string, unknown> }).$vectorSearch;
  assert.equal(vs.index, "fragments_embedding");
  assert.equal(vs.path, "fragments.embedding");
  assert.equal(vs.queryVector, vector);
  assert.equal(vs.limit, 5);
  assert.equal(vs.numCandidates, 100);
  assert.deepEqual(vs.filter, { name: { $ne: "billing-agent" } });
  assert.deepEqual(pipeline[2], { $match: { score: { $gte: 0.8 } } });
});

test("buildSimilarFragmentsPipeline omits filter and minScore when unset", () => {
  const pipeline = buildSimilarFragmentsPipeline([0.1], {});
  const vs = (pipeline[0] as { $vectorSearch: Record<string, unknown> }).$vectorSearch;
  assert.equal("filter" in vs, false);
  assert.equal(pipeline.length, 2);
});

test("buildLiteralMatchesPipeline emits $search phrase with mustNot exclude", () => {
  const pipeline = buildLiteralMatchesPipeline("refunds above $500 need approval", {
    excludePrompt: "billing-agent",
    limit: 3,
  });
  const search = (pipeline[0] as { $search: Record<string, unknown> }).$search;
  assert.equal(search.index, "fragments_text");
  assert.deepEqual(search.compound, {
    must: [{ phrase: { query: "refunds above $500 need approval", path: "fragments.text" } }],
    mustNot: [{ equals: { path: "name", value: "billing-agent" } }],
  });
  assert.deepEqual(pipeline[1], { $limit: 3 });
});

test("supportsRankFusion gates on MongoDB 8.1", () => {
  assert.equal(supportsRankFusion("8.1.0"), true);
  assert.equal(supportsRankFusion("8.2.1"), true);
  assert.equal(supportsRankFusion("9.0.0"), true);
  assert.equal(supportsRankFusion("8.0.13"), false);
  assert.equal(supportsRankFusion("7.0.28"), false);
  assert.deepEqual(parseServerVersion("8.1.0-rc1"), { major: 8, minor: 1 });
  assert.throws(() => parseServerVersion("atlas"));
});

test("buildRelatedFragmentsPipeline fuses vector and literal pipelines via $rankFusion", () => {
  const pipeline = buildRelatedFragmentsPipeline([0.3], "never promise refunds", {
    excludePrompt: "billing-agent",
    limit: 4,
  });
  const rankFusion = (
    pipeline[0] as {
      $rankFusion: {
        input: { pipelines: Record<string, Array<Record<string, unknown>>> };
        combination: { weights: Record<string, number> };
      };
    }
  ).$rankFusion;
  const { vector, literal } = rankFusion.input.pipelines;
  assert.ok(vector?.[0] && "$vectorSearch" in vector[0]);
  assert.ok(literal?.[0] && "$search" in literal[0]);
  const vs = vector[0].$vectorSearch as Record<string, unknown>;
  assert.deepEqual(vs.filter, { name: { $ne: "billing-agent" } });
  assert.deepEqual(Object.keys(rankFusion.combination.weights).sort(), ["literal", "vector"]);
  assert.deepEqual(pipeline[1], { $limit: 4 });
});

test("buildEvalTrendPipeline facets attempts with $setWindowFields and a pass tally", () => {
  const pipeline = buildEvalTrendPipeline("billing-agent");
  assert.deepEqual(pipeline[0], { $match: { "target.prompt": "billing-agent" } });
  const facet = (
    pipeline[1] as { $facet: { attempts: Array<Record<string, unknown>>; tally: Array<Record<string, unknown>> } }
  ).$facet;
  const windowStage = facet.attempts.find((stage) => "$setWindowFields" in stage) as {
    $setWindowFields: { sortBy: Record<string, number>; output: Record<string, { window: unknown }> };
  };
  assert.deepEqual(windowStage.$setWindowFields.sortBy, { _id: 1 });
  assert.deepEqual(windowStage.$setWindowFields.output.runningCandidateAvg?.window, {
    documents: ["unbounded", "current"],
  });
  const groupStage = facet.attempts.find((stage) => "$group" in stage) as {
    $group: { _id: string };
  };
  assert.equal(groupStage.$group._id, "$attempt");
  const tallyGroup = facet.tally[0] as { $group: Record<string, unknown> };
  assert.deepEqual(tallyGroup.$group.passed, { $sum: { $cond: ["$summary.passed", 1, 0] } });
});

test("proposals TTL index only ever targets evaluating documents", () => {
  assert.deepEqual(PROPOSALS_TTL_INDEX.keys, { ts: 1 });
  assert.equal(PROPOSALS_TTL_INDEX.options.expireAfterSeconds, 3600);
  assert.deepEqual(PROPOSALS_TTL_INDEX.options.partialFilterExpression, { status: "evaluating" });
});

test("fragments_text is a search-type index over fragment text with token name", () => {
  assert.equal(FRAGMENTS_TEXT_INDEX.type, "search");
  assert.equal(FRAGMENTS_TEXT_INDEX.name, "fragments_text");
  const fields = FRAGMENTS_TEXT_INDEX.definition.mappings.fields;
  assert.equal(fields.name.type, "token");
  assert.equal(fields.fragments.fields.text.type, "string");
});

test("validators enforce the IDEA.md contract shapes", () => {
  const proposals = PROPOSALS_VALIDATOR.$jsonSchema as {
    required: string[];
    properties: { status: { enum: string[] }; source: { properties: { type: { enum: string[] } } } };
  };
  assert.deepEqual(proposals.properties.status.enum, ["evaluating", "pending", "applied", "rejected"]);
  assert.deepEqual(proposals.properties.source.properties.type.enum, [
    "lesson",
    "sync-check",
    "human-edit",
  ]);
  assert.ok(proposals.required.includes("target"));
  const evalRuns = EVAL_RUNS_VALIDATOR.$jsonSchema as { required: string[] };
  for (const field of ["proposalId", "attempt", "summary", "ts"]) {
    assert.ok(evalRuns.required.includes(field), `eval_runs requires ${field}`);
  }
});

test("lessons change stream filters inserts and threads the resume token", () => {
  assert.deepEqual(LESSONS_WATCH_PIPELINE, [{ $match: { operationType: "insert" } }]);
  assert.deepEqual(buildLessonsWatchOptions(), { fullDocument: "updateLookup" });
  const token = { _data: "8264" };
  assert.deepEqual(buildLessonsWatchOptions(token), {
    fullDocument: "updateLookup",
    startAfter: token,
  });
});
