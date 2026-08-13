import { COLLECTIONS, closeDb, getDb, tracesCol } from "@uberprompt/sdk";
import { requireEnv } from "./env";

async function main(): Promise<void> {
  requireEnv("MONGODB_URI");
  const db = getDb();

  console.log("collection counts:");
  for (const name of Object.values(COLLECTIONS)) {
    const count = await db.collection(name).countDocuments();
    console.log(`  ${name.padEnd(16)} ${count}`);
  }

  const latest = await tracesCol().find().sort({ ts: -1 }).limit(5).toArray();
  console.log(`\nlatest ${latest.length} traces:`);
  for (const trace of latest) {
    const flags = [
      trace.score !== undefined ? `score=${trace.score}` : "no-score",
      trace.error ? `error=${trace.error}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const snippet = trace.output.replace(/\s+/g, " ").slice(0, 80);
    console.log(`  [${trace.ts.toISOString()}] ${trace.promptName} v${trace.promptVersion} ${trace.meta.model} ${flags}`);
    console.log(`    ${snippet}${trace.output.length > 80 ? "…" : ""}`);
  }

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
