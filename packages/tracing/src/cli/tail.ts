import type { TraceDoc } from "@uberprompt/sdk";
import { closeDb, tracesCol } from "@uberprompt/sdk";
import { estimateCostUsd, formatUsd } from "../cost";

function line(trace: TraceDoc): string {
  const bound = trace.promptName === undefined ? "unbound" : `${trace.promptName}@${trace.promptVersion}`;
  const tokens = trace.meta?.tokens;
  const usage = tokens === undefined ? "-" : `${tokens.inputTokens ?? 0}/${tokens.outputTokens ?? 0}`;
  const status = trace.error === undefined ? "ok" : `ERROR ${trace.error}`;
  const ts = trace.ts instanceof Date ? trace.ts.toISOString() : String(trace.ts ?? "-");
  return [
    ts.padEnd(24),
    (trace.service ?? "-").padEnd(16),
    bound.padEnd(28),
    (trace.meta?.model ?? "-").padEnd(18),
    `${String(trace.meta?.latencyMs ?? 0).padStart(6)}ms`,
    `tok ${usage.padEnd(11)}`,
    formatUsd(estimateCostUsd(trace.meta?.model ?? "", tokens)).padStart(9),
    `spans ${String(trace.spanCount ?? 0).padStart(3)}`,
    status,
  ].join("  ");
}

async function main(): Promise<void> {
  const recent = await tracesCol().find().sort({ ts: -1 }).limit(10).toArray();
  console.log(`--- last ${recent.length} traces ---`);
  for (const trace of recent.reverse()) console.log(line(trace));

  console.log("\n--- watching for new traces (change stream, ctrl-c to stop) ---");
  const stream = tracesCol().watch([], { fullDocument: "updateLookup" });

  process.on("SIGINT", () => {
    void stream.close().then(closeDb).then(() => process.exit(0));
  });

  for await (const change of stream) {
    if (change.operationType !== "insert" && change.operationType !== "update") continue;
    const doc = change.fullDocument;
    if (doc !== undefined) console.log(line(doc));
  }
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
