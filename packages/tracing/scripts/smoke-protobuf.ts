import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { closeDb, spansCol, tracesCol } from "@uberprompt/sdk";

const SERVICE = "protobuf-smoke";
const PORT = process.env.UBERPROMPT_COLLECT_PORT ?? "4318";

async function main(): Promise<void> {
  await spansCol().deleteMany({ service: SERVICE });
  await tracesCol().deleteMany({ service: SERVICE });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": SERVICE }),
    spanProcessors: [
      new SimpleSpanProcessor(new OTLPTraceExporter({ url: `http://localhost:${PORT}/v1/traces` })),
    ],
  });
  provider.register();

  const tracer = trace.getTracer("protobuf-smoke");

  const root = tracer.startSpan("invoke_agent");
  root.setAttributes({
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.provider.name": "anthropic",
    "gen_ai.request.model": "claude-opus-5",
    "gen_ai.input.messages": '[{"role":"user","content":"protobuf wire test"}]',
    "ai.response.text": "decoded over the wire",
  });

  const child = tracer.startSpan("chat claude-opus-5", undefined, trace.setSpan(context.active(), root));
  child.setAttributes({
    "gen_ai.request.model": "claude-opus-5",
    "gen_ai.response.model": "claude-opus-5",
    "gen_ai.usage.input_tokens": 3141,
    "gen_ai.usage.output_tokens": 59,
  });
  child.setStatus({ code: SpanStatusCode.ERROR, message: "rate limited" });
  child.end();
  root.end();

  await provider.forceFlush();
  await provider.shutdown();
  await new Promise((r) => setTimeout(r, 2000));

  const spans = await spansCol().find({ service: SERVICE }).sort({ startTime: 1 }).toArray();
  const rollup = await tracesCol().findOne({ service: SERVICE });

  console.log(`\n--- ${spans.length} spans decoded from protobuf ---`);
  for (const s of spans) {
    console.log(
      `  ${s.name.padEnd(22)} status=${s.status.padEnd(5)} model=${s.genAi?.requestModel ?? "-"} ` +
        `tokens=${s.genAi?.usage?.inputTokens ?? "-"}/${s.genAi?.usage?.outputTokens ?? "-"}`,
    );
  }
  console.log("\n--- rollup ---");
  console.log(JSON.stringify(rollup, null, 2));

  const checks: Array<[string, boolean]> = [
    ["2 spans decoded from the protobuf wire", spans.length === 2],
    ["service from protobuf resource attrs", rollup?.service === SERVICE],
    ["parent/child preserved", spans.some((s) => s.parentSpanId !== undefined)],
    ["varint tokens decoded", rollup?.meta.tokens?.inputTokens === 3141],
    ["string attrs decoded", rollup?.operation === "invoke_agent"],
    ["error status decoded", rollup?.error === "rate limited"],
    ["output text decoded", rollup?.output === "decoded over the wire"],
  ];
  console.log("\n--- assertions ---");
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }

  await spansCol().deleteMany({ service: SERVICE });
  await tracesCol().deleteMany({ service: SERVICE });
  await closeDb();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
