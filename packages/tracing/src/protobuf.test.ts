import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeOtlpProtobufTraces } from "./protobuf";

// Minimal protobuf writers, so the fixtures are built from the wire spec rather than
// from the decoder's own assumptions.
function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

const tag = (field: number, wire: number): number[] => varint((field << 3) | wire);
const lenField = (field: number, body: number[]): number[] => [...tag(field, 2), ...varint(body.length), ...body];
const strField = (field: number, text: string): number[] => lenField(field, [...Buffer.from(text, "utf8")]);
const varintField = (field: number, value: number | bigint): number[] => [...tag(field, 0), ...varint(value)];

function fixed64Field(field: number, value: bigint): number[] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return [...tag(field, 1), ...buf];
}

// KeyValue{1: key, 2: AnyValue} — the caller supplies the enclosing field number,
// so this returns the message body only.
const keyValue = (key: string, valueBody: number[]): number[] => [...strField(1, key), ...lenField(2, valueBody)];
const stringValue = (text: string): number[] => strField(1, text);
const intValue = (value: number): number[] => varintField(3, value);

const START_NANOS = 1_830_000_000_000_000_000n;
const END_NANOS = 1_830_000_002_400_000_000n;

function span(options: { attributes?: number[]; status?: number[]; parent?: boolean } = {}): number[] {
  return [
    ...lenField(1, [...Buffer.from("aaaa1111bbbb2222cccc3333dddd4444", "hex")]),
    ...lenField(2, [...Buffer.from("1111111111111111", "hex")]),
    ...(options.parent === true ? lenField(4, [...Buffer.from("2222222222222222", "hex")]) : []),
    ...strField(5, "invoke_agent"),
    ...varintField(6, 3),
    ...fixed64Field(7, START_NANOS),
    ...fixed64Field(8, END_NANOS),
    ...(options.attributes ?? []),
    ...(options.status ?? []),
  ];
}

function request(spanBody: number[], resourceAttrs: number[] = []): Buffer {
  const resource = lenField(1, resourceAttrs);
  const scopeSpans = lenField(2, lenField(2, spanBody));
  return Buffer.from(lenField(1, [...resource, ...scopeSpans]));
}

describe("decodeOtlpProtobufTraces", () => {
  it("decodes identifiers, name and timing off the wire", () => {
    const [doc] = decodeOtlpProtobufTraces(request(span()), "fallback");
    assert.equal(doc?.traceId, "aaaa1111bbbb2222cccc3333dddd4444");
    assert.equal(doc?.spanId, "1111111111111111");
    assert.equal(doc?.name, "invoke_agent");
    assert.equal(doc?.kind, "CLIENT");
    assert.equal(doc?.durationMs, 2400);
    assert.equal(doc?.startTime.getTime(), 1_830_000_000_000);
  });

  it("decodes string and integer attributes", () => {
    const attrs = [
      ...lenField(9, keyValue("gen_ai.request.model", stringValue("claude-opus-5"))),
      ...lenField(9, keyValue("gen_ai.usage.input_tokens", intValue(3141))),
    ];
    const [doc] = decodeOtlpProtobufTraces(request(span({ attributes: attrs })), "s");
    assert.equal(doc?.genAi?.requestModel, "claude-opus-5");
    assert.equal(doc?.genAi?.usage?.inputTokens, 3141);
  });

  it("decodes a status code and message", () => {
    const status = lenField(15, [...strField(2, "rate limited"), ...varintField(3, 2)]);
    const [doc] = decodeOtlpProtobufTraces(request(span({ status })), "s");
    assert.equal(doc?.status, "error");
    assert.equal(doc?.statusMessage, "rate limited");
  });

  it("reads the service name from resource attributes", () => {
    const resource = lenField(1, keyValue("service.name", stringValue("rust-service")));
    const [doc] = decodeOtlpProtobufTraces(request(span(), resource), "fallback");
    assert.equal(doc?.service, "rust-service");
  });

  it("preserves the parent relationship", () => {
    const [doc] = decodeOtlpProtobufTraces(request(span({ parent: true })), "s");
    assert.equal(doc?.parentSpanId, "2222222222222222");
  });

  it("omits parentSpanId when the field is absent", () => {
    assert.equal("parentSpanId" in (decodeOtlpProtobufTraces(request(span()), "s")[0] ?? {}), false);
  });

  // Node pools Buffers, so a decoded payload is routinely a view into a larger
  // ArrayBuffer. Reading fixed64 without honoring byteOffset would corrupt timestamps.
  it("decodes correctly when the payload is a view into a larger buffer", () => {
    const body = request(span());
    const backing = Buffer.alloc(body.length + 32);
    body.copy(backing, 16);
    const view = backing.subarray(16, 16 + body.length);
    const [doc] = decodeOtlpProtobufTraces(view, "s");
    assert.equal(doc?.startTime.getTime(), 1_830_000_000_000);
    assert.equal(doc?.durationMs, 2400);
  });

  it("skips unknown field numbers without desynchronizing", () => {
    const withUnknown = [...span(), ...varintField(99, 7), ...strField(98, "future field")];
    const [doc] = decodeOtlpProtobufTraces(request(withUnknown), "s");
    assert.equal(doc?.name, "invoke_agent");
  });

  describe("malformed input", () => {
    // These must fail fast. A hang or a pathological loop would take the collector
    // down for every other producer pointed at it.
    it("rejects a varint that never terminates rather than scanning the whole payload", () => {
      const bomb = Buffer.alloc(1_000_000, 0x80);
      assert.throws(() => decodeOtlpProtobufTraces(bomb, "s"), /varint overflow|truncated varint/);
    });

    it("rejects a length prefix larger than the remaining buffer", () => {
      const lying = Buffer.from([...tag(1, 2), ...varint(9999), 0x01, 0x02]);
      assert.throws(() => decodeOtlpProtobufTraces(lying, "s"), /truncated bytes field/);
    });

    it("rejects a fixed64 that runs past the end of the buffer", () => {
      const short = Buffer.from([...tag(1, 2), ...varint(5), ...tag(7, 1), 0x01, 0x02, 0x03]);
      assert.throws(() => decodeOtlpProtobufTraces(short, "s"), /truncated/);
    });

    it("rejects a truncated payload instead of returning partial garbage", () => {
      const full = request(span());
      assert.throws(() => decodeOtlpProtobufTraces(full.subarray(0, full.length - 4), "s"), /truncated/);
    });

    it("returns nothing for an empty payload", () => {
      assert.equal(decodeOtlpProtobufTraces(Buffer.alloc(0), "s").length, 0);
    });
  });
});
