import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeOtlpTraces } from "./otlp";

const START_NANOS = "1830000000000000000";
const END_NANOS = "1830000002400000000";

function payload(span: Record<string, unknown>, resource: Array<Record<string, unknown>> = []): never {
  return {
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [{ spans: [span] }],
      },
    ],
  } as never;
}

function baseSpan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: "aaaa1111bbbb2222cccc3333dddd4444",
    spanId: "1111111111111111",
    name: "invoke_agent",
    kind: 1,
    startTimeUnixNano: START_NANOS,
    endTimeUnixNano: END_NANOS,
    status: { code: 1 },
    attributes: [],
    ...overrides,
  };
}

describe("decodeOtlpTraces", () => {
  it("decodes a minimal span", () => {
    const [doc] = decodeOtlpTraces(payload(baseSpan()), "fallback");
    assert.equal(doc?.traceId, "aaaa1111bbbb2222cccc3333dddd4444");
    assert.equal(doc?.name, "invoke_agent");
    assert.equal(doc?.durationMs, 2400);
    assert.equal(doc?.status, "ok");
  });

  it("reads the service name from resource attributes", () => {
    const docs = decodeOtlpTraces(
      payload(baseSpan(), [{ key: "service.name", value: { stringValue: "python-worker" } }]),
      "fallback",
    );
    assert.equal(docs[0]?.service, "python-worker");
  });

  it("marks a span with status code 2 as an error and keeps its message", () => {
    const [doc] = decodeOtlpTraces(
      payload(baseSpan({ status: { code: 2, message: "provider overloaded" } })),
      "s",
    );
    assert.equal(doc?.status, "error");
    assert.equal(doc?.statusMessage, "provider overloaded");
  });

  describe("timestamps", () => {
    // An unfinished span previously became a 1970 endTime, producing a hugely negative
    // duration that landed on the rollup as negative latency.
    it("falls back to the start time when the end timestamp is missing", () => {
      const [doc] = decodeOtlpTraces(payload(baseSpan({ endTimeUnixNano: undefined })), "s");
      assert.equal(doc?.durationMs, 0);
      assert.equal(doc?.endTime.getTime(), doc?.startTime.getTime());
      assert.notEqual(doc?.endTime.getTime(), 0);
    });

    it("skips a span with no usable start timestamp instead of dating it to 1970", () => {
      assert.equal(decodeOtlpTraces(payload(baseSpan({ startTimeUnixNano: undefined })), "s").length, 0);
    });

    it("skips a span whose timestamp cannot be parsed instead of throwing", () => {
      assert.equal(decodeOtlpTraces(payload(baseSpan({ startTimeUnixNano: "not-a-number" })), "s").length, 0);
    });

    it("accepts a numeric nanosecond timestamp", () => {
      const [doc] = decodeOtlpTraces(payload(baseSpan({ startTimeUnixNano: 1830000000000000000 })), "s");
      assert.ok(doc !== undefined);
      assert.equal(doc.startTime.getTime(), 1830000000000);
    });
  });

  describe("attribute values", () => {
    const withAttrs = (attributes: Array<Record<string, unknown>>) =>
      decodeOtlpTraces(payload(baseSpan({ attributes })), "s")[0];

    it("decodes int values encoded as strings", () => {
      const doc = withAttrs([{ key: "gen_ai.usage.input_tokens", value: { intValue: "2048" } }]);
      assert.equal(doc?.attributes.gen_ai__usage__input_tokens, 2048);
      assert.equal(doc?.genAi?.usage?.inputTokens, 2048);
    });

    // Falsy values are real data — dropping them silently corrupts the span.
    it("preserves boolean false", () => {
      const doc = withAttrs([{ key: "flag", value: { boolValue: false } }]);
      assert.equal(doc?.attributes.flag, false);
    });

    it("preserves integer zero", () => {
      const doc = withAttrs([{ key: "count", value: { intValue: "0" } }]);
      assert.equal(doc?.attributes.count, 0);
    });

    it("decodes arrays and nested key-value lists", () => {
      const doc = withAttrs([
        { key: "list", value: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } } },
        { key: "nested", value: { kvlistValue: { values: [{ key: "inner", value: { stringValue: "v" } }] } } },
      ]);
      assert.deepEqual(doc?.attributes.list, ["a", "b"]);
      assert.deepEqual(doc?.attributes.nested, { inner: "v" });
    });
  });

  it("treats an empty parentSpanId as absent", () => {
    const [doc] = decodeOtlpTraces(payload(baseSpan({ parentSpanId: "" })), "s");
    assert.equal("parentSpanId" in (doc ?? {}), false);
  });

  it("ignores spans missing their identifiers", () => {
    assert.equal(decodeOtlpTraces(payload(baseSpan({ spanId: undefined })), "s").length, 0);
  });

  it("returns nothing for an empty payload", () => {
    assert.equal(decodeOtlpTraces({} as never, "s").length, 0);
  });

  it("reads the legacy instrumentationLibrarySpans shape", () => {
    const legacy = {
      resourceSpans: [{ resource: { attributes: [] }, instrumentationLibrarySpans: [{ spans: [baseSpan()] }] }],
    };
    assert.equal(decodeOtlpTraces(legacy as never, "s").length, 1);
  });
});
