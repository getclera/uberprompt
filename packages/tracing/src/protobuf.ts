import type { SpanDoc } from "@uberprompt/sdk";
import { toSpanDoc, type RawSpan } from "./normalize";

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

interface Field {
  no: number;
  wire: number;
  varint?: bigint;
  bytes?: Uint8Array;
  fixed64?: bigint;
}

class Reader {
  private offset = 0;

  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.buf[this.offset];
      if (byte === undefined) throw new Error("truncated varint");
      this.offset += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  }

  field(): Field {
    const tag = this.varint();
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);

    if (wire === WIRE_VARINT) return { no, wire, varint: this.varint() };
    if (wire === WIRE_BYTES) {
      const len = Number(this.varint());
      const bytes = this.buf.subarray(this.offset, this.offset + len);
      this.offset += len;
      return { no, wire, bytes };
    }
    if (wire === WIRE_FIXED64) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.offset, 8);
      this.offset += 8;
      return { no, wire, fixed64: view.getBigUint64(0, true) };
    }
    if (wire === WIRE_FIXED32) {
      this.offset += 4;
      return { no, wire };
    }
    throw new Error(`unsupported wire type ${wire}`);
  }
}

function fields(bytes: Uint8Array): Field[] {
  const reader = new Reader(bytes);
  const out: Field[] = [];
  while (!reader.done) out.push(reader.field());
  return out;
}

function text(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? "" : new TextDecoder().decode(bytes);
}

function hex(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) return "";
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function double(value: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, value, true);
  return view.getFloat64(0, true);
}

// AnyValue: 1 string, 2 bool, 3 int, 4 double, 5 array, 6 kvlist, 7 bytes
function decodeAnyValue(bytes: Uint8Array): unknown {
  for (const field of fields(bytes)) {
    if (field.no === 1) return text(field.bytes);
    if (field.no === 2) return field.varint === 1n;
    if (field.no === 3) return Number(field.varint ?? 0n);
    if (field.no === 4) return double(field.fixed64 ?? 0n);
    if (field.no === 5 && field.bytes) {
      return fields(field.bytes)
        .filter((f) => f.no === 1 && f.bytes)
        .map((f) => decodeAnyValue(f.bytes as Uint8Array));
    }
    if (field.no === 6 && field.bytes) {
      return decodeAttributes(fields(field.bytes).filter((f) => f.no === 1));
    }
    if (field.no === 7) return hex(field.bytes);
  }
  return undefined;
}

// KeyValue: 1 key, 2 value
function decodeAttributes(kvFields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of kvFields) {
    if (kv.bytes === undefined) continue;
    let key = "";
    let value: unknown;
    for (const field of fields(kv.bytes)) {
      if (field.no === 1) key = text(field.bytes);
      if (field.no === 2 && field.bytes) value = decodeAnyValue(field.bytes);
    }
    if (key !== "" && value !== undefined) out[key] = value;
  }
  return out;
}

const SPAN_KINDS = ["INTERNAL", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"];

// Span: 1 traceId, 2 spanId, 4 parentSpanId, 5 name, 6 kind, 7 start, 8 end, 9 attrs, 15 status
function decodeSpan(bytes: Uint8Array, resource: Record<string, unknown>, fallbackService: string): SpanDoc {
  let traceId = "";
  let spanId = "";
  let parentSpanId = "";
  let name = "unknown";
  let kind = 0;
  let start = 0n;
  let end = 0n;
  let statusCode = 0;
  let statusMessage: string | undefined;
  const attrFields: Field[] = [];

  for (const field of fields(bytes)) {
    if (field.no === 1) traceId = hex(field.bytes);
    else if (field.no === 2) spanId = hex(field.bytes);
    else if (field.no === 4) parentSpanId = hex(field.bytes);
    else if (field.no === 5) name = text(field.bytes);
    else if (field.no === 6) kind = Number(field.varint ?? 0n);
    else if (field.no === 7) start = field.fixed64 ?? 0n;
    else if (field.no === 8) end = field.fixed64 ?? 0n;
    else if (field.no === 9) attrFields.push(field);
    else if (field.no === 15 && field.bytes) {
      for (const statusField of fields(field.bytes)) {
        if (statusField.no === 2) statusMessage = text(statusField.bytes);
        if (statusField.no === 3) statusCode = Number(statusField.varint ?? 0n);
      }
    }
  }

  const raw: RawSpan = {
    traceId,
    spanId,
    name,
    kind: SPAN_KINDS[kind] ?? "INTERNAL",
    startTime: new Date(Number(start / 1000000n)),
    endTime: new Date(Number(end / 1000000n)),
    status: statusCode === 2 ? "error" : "ok",
    attributes: decodeAttributes(attrFields),
    resource,
  };
  if (parentSpanId !== "") raw.parentSpanId = parentSpanId;
  if (statusMessage !== undefined && statusMessage !== "") raw.statusMessage = statusMessage;

  return toSpanDoc(raw, fallbackService);
}

// ExportTraceServiceRequest: 1 resourceSpans
// ResourceSpans: 1 resource, 2 scopeSpans   ScopeSpans: 2 spans   Resource: 1 attributes
export function decodeOtlpProtobufTraces(body: Uint8Array, fallbackService: string): SpanDoc[] {
  const docs: SpanDoc[] = [];

  for (const request of fields(body)) {
    if (request.no !== 1 || request.bytes === undefined) continue;

    let resource: Record<string, unknown> = {};
    const scopeSpans: Uint8Array[] = [];

    for (const field of fields(request.bytes)) {
      if (field.no === 1 && field.bytes) {
        resource = decodeAttributes(fields(field.bytes).filter((f) => f.no === 1));
      } else if (field.no === 2 && field.bytes) {
        scopeSpans.push(field.bytes);
      }
    }

    for (const scope of scopeSpans) {
      for (const field of fields(scope)) {
        if (field.no === 2 && field.bytes) docs.push(decodeSpan(field.bytes, resource, fallbackService));
      }
    }
  }

  return docs;
}
