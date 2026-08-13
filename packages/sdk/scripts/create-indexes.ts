import { COLLECTIONS, EMBEDDING_DIMS, closeDb, getDb } from "../src/index";

async function createVectorIndex(collection: string, path: string, name: string): Promise<void> {
  try {
    await getDb().command({
      createSearchIndexes: collection,
      indexes: [
        {
          name,
          type: "vectorSearch",
          definition: {
            fields: [{ type: "vector", path, numDimensions: EMBEDDING_DIMS, similarity: "cosine" }],
          },
        },
      ],
    });
    console.log(`vector index ${collection}.${name} created`);
  } catch (err) {
    console.warn(
      `vector index ${collection}.${name} skipped: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function main(): Promise<void> {
  const db = getDb();

  await createVectorIndex(COLLECTIONS.prompts, "fragments.embedding", "fragments_embedding");
  await createVectorIndex(COLLECTIONS.lessons, "embedding", "lessons_embedding");
  await createVectorIndex(COLLECTIONS.prompts, "descriptionEmbedding", "descriptions_embedding");

  await db.collection(COLLECTIONS.prompts).createIndex({ name: 1 }, { unique: true });
  await db.collection(COLLECTIONS.traces).createIndex({ promptName: 1, ts: -1 });
  await db.collection(COLLECTIONS.proposals).createIndex({ status: 1 });
  await db.collection(COLLECTIONS.edges).createIndex({ "to.prompt": 1 });
  await db.collection(COLLECTIONS.edges).createIndex({ "from.prompt": 1 });
  await db.collection(COLLECTIONS.evalRuns).createIndex({ proposalId: 1 });
  console.log("regular indexes created");

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
