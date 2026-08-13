import type { HrTime } from "@opentelemetry/api";
import { SpanKind } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { toSpanDoc, type RawSpan } from "./normalize";
import { writeSpans } from "./writer";

function hrTimeToDate(time: HrTime): Date {
  const [seconds, nanos] = time;
  return new Date(seconds * 1000 + nanos / 1e6);
}

function plainAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined));
}

export class MongoSpanExporter implements SpanExporter {
  private readonly service: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(service: string) {
    this.service = service;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const docs = spans.map((span) => toSpanDoc(this.toRawSpan(span), this.service));
    this.pending = this.pending
      .then(() => writeSpans(docs))
      .then(
        () => resultCallback({ code: ExportResultCode.SUCCESS }),
        (error: unknown) =>
          resultCallback({
            code: ExportResultCode.FAILED,
            error: error instanceof Error ? error : new Error(String(error)),
          }),
      );
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }

  async forceFlush(): Promise<void> {
    await this.pending;
  }

  private toRawSpan(span: ReadableSpan): RawSpan {
    const context = span.spanContext();
    const raw: RawSpan = {
      traceId: context.traceId,
      spanId: context.spanId,
      name: span.name,
      kind: SpanKind[span.kind] ?? String(span.kind),
      startTime: hrTimeToDate(span.startTime),
      endTime: hrTimeToDate(span.endTime),
      status: span.status.code === 2 ? "error" : "ok",
      attributes: plainAttributes(span.attributes),
      resource: plainAttributes(span.resource.attributes),
    };
    const parentSpanId = span.parentSpanContext?.spanId;
    if (parentSpanId !== undefined) raw.parentSpanId = parentSpanId;
    if (span.status.message !== undefined) raw.statusMessage = span.status.message;
    return raw;
  }
}
