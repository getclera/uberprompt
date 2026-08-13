import { closeDb, spansCol, tracesCol } from "@uberprompt/sdk";
import { decodeOtlpTraces, ensureTracingIndexes, writeSpans } from "../src/index";

const SERVICE = "otlp-smoke";
const TRACE_ID = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f";

function nanos(msFromEpoch: number): string {
  return String(BigInt(msFromEpoch) * 1000000n);
}

const payload = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: SERVICE } },
          { key: "telemetry.sdk.language", value: { stringValue: "python" } },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: TRACE_ID,
              spanId: "1111111111111111",
              name: "invoke_agent",
              kind: 1,
              startTimeUnixNano: nanos(1_800_000_000_000),
              endTimeUnixNano: nanos(1_800_000_002_400),
              status: { code: 1 },
              attributes: [
                { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
                { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
                { key: "gen_ai.request.model", value: { stringValue: "claude-opus-5" } },
                { key: "gen_ai.input.messages", value: { stringValue: '[{"role":"user","content":"refund please"}]' } },
                { key: "ai.response.text", value: { stringValue: "Escalating to billing." } },
              ],
            },
            {
              traceId: TRACE_ID,
              spanId: "2222222222222222",
              parentSpanId: "1111111111111111",
              name: "chat claude-opus-5",
              kind: 3,
              startTimeUnixNano: nanos(1_800_000_000_100),
              endTimeUnixNano: nanos(1_800_000_002_300),
              status: { code: 2, message: "provider overloaded" },
              attributes: [
                { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
                { key: "gen_ai.request.model", value: { stringValue: "claude-opus-5" } },
                { key: "gen_ai.response.model", value: { stringValue: "claude-opus-5" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "1024" } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: "77" } },
                { key: "gen_ai.response.finish_reasons", value: { arrayValue: { values: [{ stringValue: "stop" }] } } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function main(): Promise<void> {
  await ensureTracingIndexes();
  await spansCol().deleteMany({ service: SERVICE });
  await tracesCol().deleteMany({ service: SERVICE });

  const docs = decodeOtlpTraces(payload, "fallback-service");
  console.log(`decoded ${docs.length} spans from the OTLP payload`);
  for (const doc of docs) {
    console.log(
      `  ${doc.spanId.slice(0, 8)} ${doc.name.padEnd(22)} status=${doc.status.padEnd(5)} ` +
        `model=${doc.genAi?.requestModel ?? "-"} tokens=${doc.genAi?.usage?.inputTokens ?? "-"}/${doc.genAi?.usage?.outputTokens ?? "-"}`,
    );
  }

  await writeSpans(docs);

  const trace = await tracesCol().findOne({ traceId: TRACE_ID });
  console.log("\n--- rollup from OTLP wire format ---");
  console.log(JSON.stringify(trace, null, 2));

  const checks: Array<[string, boolean]> = [
    ["service read from resource attributes", trace?.service === SERVICE],
    ["operation from gen_ai.operation.name", trace?.operation === "invoke_agent"],
    ["model resolved", trace?.meta.model === "claude-opus-5"],
    ["tokens summed from child span", trace?.meta.tokens?.inputTokens === 1024],
    ["error surfaced from failed child span", trace?.error === "provider overloaded"],
    ["latency from root span", trace?.meta.latencyMs === 2400],
    ["no prompt binding (unbound OTLP source)", trace?.promptName === undefined],
  ];
  console.log("\n--- assertions ---");
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }

  await closeDb();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
