import type { Document } from "mongodb";
import {
  COLLECTIONS,
  EMBEDDING_DIMS,
  FRAGMENTS_TEXT_INDEX_NAME,
  FRAGMENTS_VECTOR_INDEX_NAME,
  closeDb,
  getDb,
} from "../src/index";

export const PROPOSALS_TTL_INDEX = {
  keys: { ts: 1 },
  options: {
    name: "proposals_evaluating_ttl",
    expireAfterSeconds: 3600,
    partialFilterExpression: { status: "evaluating" },
  },
} as const;

export const FRAGMENTS_TEXT_INDEX = {
  name: FRAGMENTS_TEXT_INDEX_NAME,
  type: "search",
  definition: {
    mappings: {
      dynamic: false,
      fields: {
        name: { type: "token" },
        fragments: {
          type: "document",
          fields: {
            key: { type: "token" },
            text: { type: "string" },
          },
        },
      },
    },
  },
} as const;

export const EVAL_RUNS_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["proposalId", "target", "attempt", "candidateText", "cases", "summary", "judgeModel", "genModel", "ts"],
    properties: {
      proposalId: { bsonType: "objectId" },
      lessonId: { bsonType: ["objectId", "null"] },
      target: {
        bsonType: "object",
        required: ["prompt", "fragment"],
        properties: { prompt: { bsonType: "string" }, fragment: { bsonType: "string" } },
      },
      attempt: { bsonType: ["int", "long", "double"], minimum: 1 },
      candidateText: { bsonType: "string" },
      cases: { bsonType: "array" },
      summary: {
        bsonType: "object",
        required: ["replayWins", "replayLosses", "goldenRegressions", "baselineAvg", "candidateAvg", "passed"],
        properties: {
          replayWins: { bsonType: ["int", "long", "double"] },
          replayLosses: { bsonType: ["int", "long", "double"] },
          goldenRegressions: { bsonType: ["int", "long", "double"] },
          baselineAvg: { bsonType: ["int", "long", "double"] },
          candidateAvg: { bsonType: ["int", "long", "double"] },
          passed: { bsonType: "bool" },
        },
      },
      judgeModel: { bsonType: "string" },
      genModel: { bsonType: "string" },
      ts: { bsonType: "date" },
    },
  },
};

export const PROPOSALS_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["target", "oldText", "newText", "reason", "source", "status", "ts"],
    properties: {
      target: {
        bsonType: "object",
        required: ["prompt"],
        properties: { prompt: { bsonType: "string" }, fragment: { bsonType: "string" } },
      },
      oldText: { bsonType: "string" },
      newText: { bsonType: "string" },
      reason: { bsonType: "string" },
      source: {
        bsonType: "object",
        required: ["type"],
        properties: {
          type: { enum: ["lesson", "sync-check", "human-edit"] },
          ref: { bsonType: "objectId" },
        },
      },
      status: { enum: ["evaluating", "pending", "applied", "rejected"] },
      ts: { bsonType: "date" },
    },
  },
};

async function createSearchIndex(collection: string, index: Document): Promise<void> {
  try {
    await getDb().command({ createSearchIndexes: collection, indexes: [index] });
    console.log(`search index ${collection}.${index.name} created`);
  } catch (err) {
    console.warn(
      `search index ${collection}.${index.name} skipped: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function vectorIndex(path: string, name: string, filterPaths: string[] = []): Document {
  return {
    name,
    type: "vectorSearch",
    definition: {
      fields: [
        { type: "vector", path, numDimensions: EMBEDDING_DIMS, similarity: "cosine" },
        ...filterPaths.map((filterPath) => ({ type: "filter", path: filterPath })),
      ],
    },
  };
}

async function applyValidator(collection: string, validator: Document): Promise<void> {
  const db = getDb();
  try {
    await db.command({ collMod: collection, validator, validationLevel: "moderate" });
  } catch (err) {
    const isMissingNamespace =
      typeof err === "object" && err !== null && (err as { codeName?: string }).codeName === "NamespaceNotFound";
    if (!isMissingNamespace) throw err;
    await db.createCollection(collection, { validator, validationLevel: "moderate" });
  }
  console.log(`validator applied to ${collection}`);
}

async function main(): Promise<void> {
  const db = getDb();

  await createSearchIndex(
    COLLECTIONS.prompts,
    vectorIndex("fragments.embedding", FRAGMENTS_VECTOR_INDEX_NAME, ["name"]),
  );
  await createSearchIndex(COLLECTIONS.lessons, vectorIndex("embedding", "lessons_embedding"));
  await createSearchIndex(
    COLLECTIONS.prompts,
    vectorIndex("descriptionEmbedding", "descriptions_embedding"),
  );
  await createSearchIndex(COLLECTIONS.prompts, { ...FRAGMENTS_TEXT_INDEX });

  await db.collection(COLLECTIONS.prompts).createIndex({ name: 1 }, { unique: true });
  await db.collection(COLLECTIONS.traces).createIndex({ promptName: 1, ts: -1 });
  await db.collection(COLLECTIONS.proposals).createIndex({ status: 1 });
  await db.collection(COLLECTIONS.edges).createIndex({ "to.prompt": 1 });
  await db.collection(COLLECTIONS.edges).createIndex({ "from.prompt": 1 });
  await db.collection(COLLECTIONS.edges).createIndex({ "to.fragment": 1 });
  await db.collection(COLLECTIONS.evalRuns).createIndex({ proposalId: 1 });
  await db
    .collection(COLLECTIONS.proposals)
    .createIndex(PROPOSALS_TTL_INDEX.keys, PROPOSALS_TTL_INDEX.options);
  console.log("regular indexes created");

  await applyValidator(COLLECTIONS.evalRuns, EVAL_RUNS_VALIDATOR);
  await applyValidator(COLLECTIONS.proposals, PROPOSALS_VALIDATOR);

  await closeDb();
}

const invokedDirectly = process.argv[1]?.endsWith("create-indexes.ts") ?? false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
