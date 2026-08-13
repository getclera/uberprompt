import { COLLECTIONS, getDb, promptVersionsCol, spansCol, tracesCol } from "@uberprompt/sdk";

export async function ensureTracingIndexes(): Promise<string[]> {
  const created: string[] = [];
  const existing = (await getDb().listCollections().toArray()).map((c) => c.name);

  if (!existing.includes(COLLECTIONS.spans)) {
    await getDb().createCollection(COLLECTIONS.spans);
    created.push(`collection ${COLLECTIONS.spans}`);
  }

  created.push(await spansCol().createIndex({ spanId: 1 }, { unique: true }));
  created.push(await spansCol().createIndex({ traceId: 1, startTime: 1 }));
  created.push(await tracesCol().createIndex({ traceId: 1 }, { unique: true }));
  created.push(await tracesCol().createIndex({ promptVersionId: 1, ts: -1 }));
  created.push(await promptVersionsCol().createIndex({ promptName: 1, version: 1 }, { unique: true }));
  created.push(await promptVersionsCol().createIndex({ contentHash: 1 }));

  created.push(await spansCol().createIndex(
    { ingestedAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 30 }
  ));
  created.push(await tracesCol().createIndex(
    { ts: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 90 }
  ));

  return created;
}
