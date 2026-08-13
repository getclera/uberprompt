import { closeDb, getDb } from "@uberprompt/sdk";
import { ensureTracingIndexes } from "../indexes";

async function main(): Promise<void> {
  const created = await ensureTracingIndexes();
  console.log(`db: ${getDb().databaseName}`);
  for (const name of created) console.log(`  ${name}`);
  console.log(`\n${created.length} indexes/collections ready`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
