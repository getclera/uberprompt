import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectTraces,
  groupByPrompt,
  miningPrompt,
  findDuplicate,
  learnPipeline,
} from "../src/learn.ts";
import type { TraceDoc } from "../src/learn.ts";
import type { Db, WithId } from "mongodb";

interface FakeState {
  finds: { name: string; filter: Record<string, unknown> }[];
  sorts: Record<string, unknown>[];
  limits: number[];
  aggregates: { name: string; pipeline: Record<string, unknown>[] }[];
  inserts: { name: string; doc: Record<string, unknown> }[];
  updates: { name: string; filter: Record<string, unknown>; update: Record<string, unknown> }[];
  findResults: unknown[][];
  aggResults: unknown[][];
}

function fakeDb(state: FakeState): Db {
  return {
    collection(name: string) {
      return {
        find(filter: Record<string, unknown>) {
          state.finds.push({ name, filter });
          const results = state.findResults.shift() || [];
          return {
            sort(spec: Record<string, unknown>) {
              state.sorts.push(spec);
              return this;
            },
            limit(n: number) {
              state.limits.push(n);
              return this;
            },
            toArray: async () => results,
          };
        },
        aggregate(pipeline: Record<string, unknown>[]) {
          state.aggregates.push({ name, pipeline });
          const results = state.aggResults.shift() || [];
          return { toArray: async () => results };
        },
        insertOne: async (doc: Record<string, unknown>) => {
          state.inserts.push({ name, doc });
          return { insertedId: `inserted-${state.inserts.length}` };
        },
        updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          state.updates.push({ name, filter, update });
          return { matchedCount: 1 };
        },
      };
    },
  } as unknown as Db;
}

function newState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    finds: [],
    sorts: [],
    limits: [],
    aggregates: [],
    inserts: [],
    updates: [],
    findResults: [],
    aggResults: [],
    ...overrides,
  };
}

const badTrace = {
  _id: "t1",
  traceId: "trace-1",
  promptName: "refund-agent",
  promptVersion: 2,
  input: { message: "where is my refund" },
  output: "You will get $500 back.",
  error: "hallucinated refund amount",
  ts: new Date("2026-08-13T10:00:00Z"),
} as unknown as WithId<TraceDoc>;

const okTrace = {
  _id: "t2",
  traceId: "trace-2",
  promptName: "order-agent",
  promptVersion: 1,
  input: { message: "3 pallets please" },
  output: "Order confirmed.",
  score: 0.9,
  ts: new Date("2026-08-13T09:00:00Z"),
} as unknown as WithId<TraceDoc>;

test("selectTraces requires a prompt binding and prioritizes error/low-score traces", async () => {
  const state = newState({ findResults: [[badTrace], [okTrace]] });
  const traces = await selectTraces(fakeDb(state), 10);

  assert.deepEqual(state.finds[0]!.filter, {
    promptName: { $exists: true },
    $or: [{ error: { $exists: true } }, { score: { $lt: 0.5 } }],
  });
  assert.deepEqual(state.finds[1]!.filter, {
    promptName: { $exists: true },
    _id: { $nin: ["t1"] },
  });
  assert.deepEqual(state.sorts, [{ ts: -1 }, { ts: -1 }]);
  assert.deepEqual(state.limits, [10, 9]);
  assert.deepEqual(traces.map((t) => t._id), ["t1", "t2"]);
});

test("selectTraces stops at the limit when signal traces fill it", async () => {
  const state = newState({ findResults: [[badTrace]] });
  const traces = await selectTraces(fakeDb(state), 1);
  assert.equal(state.finds.length, 1);
  assert.deepEqual(traces.map((t) => t._id), ["t1"]);
});

test("groupByPrompt groups traces by promptName", () => {
  const groups = groupByPrompt([badTrace, okTrace, { ...badTrace, _id: "t3" } as unknown as WithId<TraceDoc>]);
  assert.deepEqual([...groups.keys()], ["refund-agent", "order-agent"]);
  assert.deepEqual(groups.get("refund-agent")!.map((t) => t._id), ["t1", "t3"]);
});

test("miningPrompt includes trace signal and permits zero lessons", () => {
  const prompt = miningPrompt("refund-agent", [badTrace]);
  assert.match(prompt, /refund-agent/);
  assert.match(prompt, /hallucinated refund amount/);
  assert.match(prompt, /ZERO lessons/);
});

test("findDuplicate matches only active lessons and applies the threshold", async () => {
  const state = newState({
    aggResults: [
      [
        { _id: "l0", text: "dead", status: "superseded", score: 0.99 },
        { _id: "l1", text: "old", status: "active", score: 0.95 },
      ],
    ],
  });
  const hit = await findDuplicate(fakeDb(state), [0.1, 0.2], 0.92);
  assert.equal(hit!._id, "l1");
  const search = (state.aggregates[0]!.pipeline[0] as { $vectorSearch: Record<string, unknown> }).$vectorSearch;
  assert.equal(search.index, "lessons_embedding");
  assert.equal("filter" in search, false);

  const below = newState({
    aggResults: [[{ _id: "l1", text: "old", status: "active", score: 0.5 }]],
  });
  assert.equal(await findDuplicate(fakeDb(below), [0.1], 0.92), null);
});

test("learnPipeline inserts a new lesson with the contract shape", async () => {
  const state = newState({ findResults: [[badTrace], []], aggResults: [[]] });
  const result = await learnPipeline({
    db: fakeDb(state),
    structured: async () => ({
      lessons: [{ text: "never promise a refund amount", reason: "traces hallucinated amounts" }],
    }),
    embed: async () => [0.1, 0.2, 0.3],
    limit: 10,
    threshold: 0.92,
    dryRun: false,
  });

  assert.deepEqual(result, { traces: 1, mined: 1, inserted: 1, merged: 0 });
  assert.equal(state.inserts.length, 1);
  const { name, doc } = state.inserts[0]!;
  assert.equal(name, "lessons");
  assert.equal(doc.text, "never promise a refund amount");
  assert.equal(doc.reason, "traces hallucinated amounts");
  assert.deepEqual(doc.embedding, [0.1, 0.2, 0.3]);
  assert.deepEqual(doc.sourceTraceIds, ["t1"]);
  assert.deepEqual(doc.appliesTo, ["refund-agent"]);
  assert.equal(doc.status, "active");
  assert.ok(doc.ts instanceof Date);
  assert.equal("processedAt" in doc, false);
});

test("learnPipeline merges into a near-duplicate instead of inserting", async () => {
  const state = newState({
    findResults: [[badTrace], []],
    aggResults: [[{ _id: "l1", text: "never promise refunds", status: "active", score: 0.97 }]],
  });
  const result = await learnPipeline({
    db: fakeDb(state),
    structured: async () => ({ lessons: [{ text: "never promise a refund amount", reason: "r" }] }),
    embed: async () => [0.1],
    limit: 10,
    threshold: 0.92,
    dryRun: false,
  });

  assert.deepEqual(result, { traces: 1, mined: 1, inserted: 0, merged: 1 });
  assert.equal(state.inserts.length, 0);
  assert.equal(state.updates.length, 1);
  assert.deepEqual(state.updates[0]!.filter, { _id: "l1" });
  assert.deepEqual(state.updates[0]!.update, {
    $addToSet: {
      sourceTraceIds: { $each: ["t1"] },
      appliesTo: "refund-agent",
    },
  });
});

test("learnPipeline dry-run runs dedup but writes nothing", async () => {
  const state = newState({
    findResults: [[badTrace], [okTrace]],
    aggResults: [[{ _id: "l1", text: "dup", status: "active", score: 0.99 }], []],
  });
  const result = await learnPipeline({
    db: fakeDb(state),
    structured: async () => ({ lessons: [{ text: "a durable lesson", reason: "r" }] }),
    embed: async () => [0.5],
    limit: 10,
    threshold: 0.92,
    dryRun: true,
  });

  assert.deepEqual(result, { traces: 2, mined: 2, inserted: 1, merged: 1 });
  assert.equal(state.aggregates.length, 2);
  assert.equal(state.inserts.length, 0);
  assert.equal(state.updates.length, 0);
});

test("learnPipeline treats an empty-lessons group as healthy", async () => {
  const state = newState({ findResults: [[], [okTrace]] });
  let embeds = 0;
  const result = await learnPipeline({
    db: fakeDb(state),
    structured: async () => ({ lessons: [] }),
    embed: async () => {
      embeds += 1;
      return [0.1];
    },
    limit: 10,
    threshold: 0.92,
    dryRun: false,
  });

  assert.deepEqual(result, { traces: 1, mined: 0, inserted: 0, merged: 0 });
  assert.equal(embeds, 0);
  assert.equal(state.inserts.length, 0);
  assert.equal(state.updates.length, 0);
});
