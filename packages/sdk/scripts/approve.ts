import { ObjectId } from "mongodb";
import { approveProposal, closeDb } from "../src/index";

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) throw new Error("usage: approve <proposalId>");
  const result = await approveProposal(new ObjectId(id));
  console.log(
    `applied ${id}: ${result.prompt}.${result.fragment} — now v${result.version}`,
  );
  console.log(`  snapshot inserted: prompt_versions v${result.version}`);
  console.log(`  contentHash ${result.contentHash.slice(0, 12)} — fragment re-embedded`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(closeDb);
