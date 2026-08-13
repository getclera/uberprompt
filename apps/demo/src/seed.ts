import { closeDb, definePrompt } from "@uberprompt/sdk";
import { requireEnv } from "./env";
import { promptSuite } from "./prompts";

async function main(): Promise<void> {
  requireEnv("MONGODB_URI");
  for (const args of promptSuite) {
    const doc = await definePrompt({ ...args, updatedBy: "demo-seed" });
    const embedded = doc.fragments.filter((f) => f.embedding).length;
    console.log(
      `seeded ${doc.name} v${doc.version} (${doc.fragments.length} fragments, ${embedded} embedded, ${args.uses?.length ?? 0} uses edges)`,
    );
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
