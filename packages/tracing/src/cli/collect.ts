import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeDb } from "@uberprompt/sdk";
import { ensureTracingIndexes } from "../indexes";
import { decodeOtlpTraces } from "../otlp";
import { writeSpans } from "../writer";

const port = Number(process.env.UBERPROMPT_COLLECT_PORT ?? 4318);
const service = process.env.UBERPROMPT_COLLECT_SERVICE ?? "otlp-collector";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleTraces(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("json")) {
    res.writeHead(415, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "only OTLP/HTTP JSON is supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json" }));
    return;
  }

  const body = await readBody(req);
  const docs = decodeOtlpTraces(JSON.parse(body) as Record<string, never>, service);
  await writeSpans(docs);

  const traceIds = new Set(docs.map((doc) => doc.traceId));
  console.log(`${new Date().toISOString()}  ${docs.length} spans across ${traceIds.size} trace(s)`);

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ partialSuccess: {} }));
}

async function main(): Promise<void> {
  await ensureTracingIndexes();

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/v1/traces")) {
      handleTraces(req, res).catch((err: unknown) => {
        console.error("ingest failed:", err instanceof Error ? err.message : err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(port, () => {
    console.log(`uberprompt collect listening on http://localhost:${port}/v1/traces`);
    console.log(`point any OTLP source at it:\n  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${port} OTEL_EXPORTER_OTLP_PROTOCOL=http/json <your app>`);
  });

  const stop = async (): Promise<void> => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
