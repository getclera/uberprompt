import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { toSpanDoc, type RawSpan } from "./normalize";

function raw(overrides: Partial<RawSpan> = {}): RawSpan {
  return {
    traceId: "trace-1",
    spanId: "span-1",
    name: "chat claude-opus-5",
    kind: "CLIENT",
    startTime: new Date("2026-08-13T10:00:00.000Z"),
    endTime: new Date("2026-08-13T10:00:02.400Z"),
    status: "ok",
    attributes: {},
    resource: {},
    ...overrides,
  };
}

describe("toSpanDoc", () => {
  it("computes duration from the span boundaries", () => {
    assert.equal(toSpanDoc(raw(), "fallback").durationMs, 2400);
  });

  // A skewed or unfinished span must not produce negative latency on the rollup.
  it("clamps a reversed time range to zero rather than going negative", () => {
    const doc = toSpanDoc(
      raw({ startTime: new Date("2026-08-13T10:00:02Z"), endTime: new Date("2026-08-13T10:00:00Z") }),
      "fallback",
    );
    assert.equal(doc.durationMs, 0);
  });

  it("prefers the resource service name over the fallback", () => {
    assert.equal(toSpanDoc(raw({ resource: { "service.name": "python-worker" } }), "fallback").service, "python-worker");
  });

  it("uses the fallback service when the resource carries none", () => {
    assert.equal(toSpanDoc(raw(), "fallback").service, "fallback");
  });

  it("omits parentSpanId entirely for a root span", () => {
    assert.equal("parentSpanId" in toSpanDoc(raw(), "s"), false);
  });

  describe("genAi extraction", () => {
    it("promotes model, provider and usage out of the attribute bag", () => {
      const doc = toSpanDoc(
        raw({
          attributes: {
            "gen_ai.provider.name": "anthropic",
            "gen_ai.request.model": "claude-opus-5",
            "gen_ai.usage.input_tokens": 1024,
            "gen_ai.usage.output_tokens": 77,
          },
        }),
        "s",
      );
      assert.equal(doc.genAi?.provider, "anthropic");
      assert.equal(doc.genAi?.requestModel, "claude-opus-5");
      assert.equal(doc.genAi?.usage?.inputTokens, 1024);
      assert.equal(doc.genAi?.usage?.totalTokens, 1101);
    });

    // OTLP JSON encodes 64-bit ints as strings; dropping them would silently zero tokens.
    it("accepts token counts encoded as strings", () => {
      const doc = toSpanDoc(raw({ attributes: { "gen_ai.usage.input_tokens": "2048" } }), "s");
      assert.equal(doc.genAi?.usage?.inputTokens, 2048);
    });

    // Zero is a real measurement, not an absent one.
    it("preserves a zero token count", () => {
      const doc = toSpanDoc(raw({ attributes: { "gen_ai.usage.output_tokens": 0 } }), "s");
      assert.equal(doc.genAi?.usage?.outputTokens, 0);
    });

    it("omits totalTokens when only one side is known", () => {
      const doc = toSpanDoc(raw({ attributes: { "gen_ai.usage.input_tokens": 10 } }), "s");
      assert.equal(doc.genAi?.usage?.totalTokens, undefined);
      assert.equal(doc.genAi?.usage?.inputTokens, 10);
    });

    it("leaves genAi absent when no GenAI attributes are present", () => {
      assert.equal(toSpanDoc(raw(), "s").genAi, undefined);
    });
  });

  describe("prompt binding", () => {
    const versionId = new ObjectId();
    const bound = {
      "uberprompt.prompt.name": "triage-router",
      "uberprompt.prompt.version": 3,
      "uberprompt.prompt.version_id": versionId.toHexString(),
      "uberprompt.prompt.content_hash": "abc123",
    };

    it("reconstructs the prompt ref, including the ObjectId FK", () => {
      const doc = toSpanDoc(raw({ attributes: bound }), "s");
      assert.equal(doc.prompt?.name, "triage-router");
      assert.equal(doc.prompt?.version, 3);
      assert.ok(doc.prompt?.versionId instanceof ObjectId);
      assert.equal(doc.prompt?.versionId.toHexString(), versionId.toHexString());
    });

    it("drops a partial binding rather than fabricating one", () => {
      const { ["uberprompt.prompt.version_id"]: _drop, ...partial } = bound;
      assert.equal(toSpanDoc(raw({ attributes: partial }), "s").prompt, undefined);
    });

    it("drops a binding whose version id is not a valid ObjectId", () => {
      const attrs = { ...bound, "uberprompt.prompt.version_id": "not-an-objectid" };
      assert.equal(toSpanDoc(raw({ attributes: attrs }), "s").prompt, undefined);
    });
  });

  describe("input and output promotion", () => {
    it("parses JSON message attributes into structured input", () => {
      const doc = toSpanDoc(
        raw({ attributes: { "gen_ai.input.messages": '[{"role":"user","content":"hi"}]' } }),
        "s",
      );
      assert.deepEqual(doc.input, [{ role: "user", content: "hi" }]);
    });

    // ai.prompt is legitimately a plain string; keeping it raw is correct.
    it("keeps a non-JSON prompt attribute as its raw string", () => {
      const doc = toSpanDoc(raw({ attributes: { "ai.prompt": "just text" } }), "s");
      assert.equal(doc.input, "just text");
    });

    it("promotes response text to output", () => {
      const doc = toSpanDoc(raw({ attributes: { "ai.response.text": "done" } }), "s");
      assert.equal(doc.output, "done");
    });
  });

  // Dots are replaced with __ on the way in: Mongo reads a dotted key as a path, and
  // a wildcard index cannot cover field names containing dots.
  it("stores attribute keys with dots escaped", () => {
    const doc = toSpanDoc(raw({ attributes: { "gen_ai.request.model": "m", "ai.prompt": "p" } }), "s");
    assert.equal(doc.attributes.gen_ai__request__model, "m");
    assert.equal(doc.attributes.ai__prompt, "p");
    assert.equal(doc.attributes["gen_ai.request.model"], undefined);
  });

  it("escapes resource keys the same way", () => {
    const doc = toSpanDoc(raw({ resource: { "service.name": "svc", "telemetry.sdk.language": "python" } }), "s");
    assert.equal(doc.resource.telemetry__sdk__language, "python");
  });

  // Promotion must read the original dotted keys, not the escaped ones — otherwise
  // sanitizing would silently blank out every promoted field.
  it("still promotes typed fields even though stored keys are escaped", () => {
    const doc = toSpanDoc(
      raw({ attributes: { "gen_ai.request.model": "claude-opus-5" }, resource: { "service.name": "svc" } }),
      "fallback",
    );
    assert.equal(doc.genAi?.requestModel, "claude-opus-5");
    assert.equal(doc.service, "svc");
  });
});
