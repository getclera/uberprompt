import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startConsistencyLoop } from "./consistency";
import { startLearningLoop } from "./learning";

function loadEnv(): void {
  const path = resolve(process.cwd(), "../../.env");
  if (!existsSync(path)) {
    console.warn(`[agent] no .env at ${path}, relying on process env`);
    return;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match?.[1] && match[2] !== undefined && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
  console.log(`[agent] loaded env from ${path}`);
}

function requireEnv(keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[agent] FATAL: missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  loadEnv();
  requireEnv(["MONGODB_URI", "ANTHROPIC_API_KEY", "VOYAGE_API_KEY"]);
  console.log("[agent] überprompt sync agent starting — consistency + learning loops");
  await Promise.all([
    startConsistencyLoop().catch((err) => {
      console.error("[agent] FATAL: consistency loop died:", err);
      process.exit(1);
    }),
    startLearningLoop().catch((err) => {
      console.error("[agent] FATAL: learning loop died:", err);
      process.exit(1);
    }),
  ]);
}

main().catch((err) => {
  console.error("[agent] FATAL:", err);
  process.exit(1);
});
