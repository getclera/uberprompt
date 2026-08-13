import type { SpanDoc } from "@uberprompt/sdk";
import { toSpanDoc, type RawSpan } from "./normalize";

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
}

interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number | string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  status?: { code?: number | string; message?: string };
}

interface OtlpPayload {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpKeyValue[] };
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
    instrumentationLibrarySpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
}

const SPAN_KINDS = ["INTERNAL", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"];

function decodeValue(value: OtlpAnyValue | undefined): unknown {
  if (value === undefined) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map(decodeValue);
  if (value.kvlistValue !== undefined) return decodeAttributes(value.kvlistValue.values);
  return undefined;
}

function decodeAttributes(attributes: OtlpKeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of attributes ?? []) {
    const decoded = decodeValue(entry.value);
    if (decoded !== undefined) out[entry.key] = decoded;
  }
  return out;
}

// Returns undefined rather than the epoch for a missing timestamp: an unfinished span
// with endTime pinned to 1970 yields a hugely negative duration that lands in the
// rollup as negative latency. BigInt throws on non-integer input, so guard that too.
function nanosToDate(value: string | number | undefined): Date | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    return new Date(Number(BigInt(value) / 1000000n));
  } catch {
    return undefined;
  }
}

function decodeKind(kind: number | string | undefined): string {
  if (typeof kind === "string") return kind.replace("SPAN_KIND_", "");
  return SPAN_KINDS[kind ?? 0] ?? "INTERNAL";
}

function isError(code: number | string | undefined): boolean {
  return code === 2 || code === "STATUS_CODE_ERROR";
}

export function decodeOtlpTraces(payload: OtlpPayload, fallbackService: string): SpanDoc[] {
  const docs: SpanDoc[] = [];

  for (const resourceSpan of payload.resourceSpans ?? []) {
    const resource = decodeAttributes(resourceSpan.resource?.attributes);
    const scopes = resourceSpan.scopeSpans ?? resourceSpan.instrumentationLibrarySpans ?? [];

    for (const scope of scopes) {
      for (const span of scope.spans ?? []) {
        if (span.traceId === undefined || span.spanId === undefined) continue;

        const startTime = nanosToDate(span.startTimeUnixNano);
        if (startTime === undefined) continue;

        const raw: RawSpan = {
          traceId: span.traceId,
          spanId: span.spanId,
          name: span.name ?? "unknown",
          kind: decodeKind(span.kind),
          startTime,
          endTime: nanosToDate(span.endTimeUnixNano) ?? startTime,
          status: isError(span.status?.code) ? "error" : "ok",
          attributes: decodeAttributes(span.attributes),
          resource,
        };
        if (span.parentSpanId !== undefined && span.parentSpanId !== "") raw.parentSpanId = span.parentSpanId;
        if (span.status?.message !== undefined) raw.statusMessage = span.status.message;

        docs.push(toSpanDoc(raw, fallbackService));
      }
    }
  }

  return docs;
}
