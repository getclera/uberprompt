import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootEnvPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../.env");

export function loadEnv(): void {
  if (!existsSync(rootEnvPath)) return;
  for (const line of readFileSync(rootEnvPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (key && value && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function requireEnv(...keys: string[]): void {
  loadEnv();
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env at the repo root and fill in the values.");
    process.exit(1);
  }
}
