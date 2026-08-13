import type { SpanDoc } from "@uberprompt/sdk";
import { spansCol } from "@uberprompt/sdk";
import { rollupTraces } from "./rollup";

export async function writeSpans(docs: SpanDoc[]): Promise<number> {
  if (docs.length === 0) return 0;

  await spansCol().bulkWrite(
    docs.map((doc) => ({
      updateOne: {
        filter: { spanId: doc.spanId },
        update: { $set: doc },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  await rollupTraces([...new Set(docs.map((doc) => doc.traceId))]);
  return docs.length;
}
