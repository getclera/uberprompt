#!/usr/bin/env node
// Apply (or revert) a demo scenario: performs the declarative edits in
// scenarios/<name>/scenario.json against the prompt/fragment JSON files.
//
//   node apps/demo/scenarios/apply.mjs raise-escalation-threshold
//   node apps/demo/scenarios/apply.mjs raise-escalation-threshold --revert
//
// Apply replaces `find` → `replace` and bumps `version`; revert does the
// opposite. Idempotent: refuses to apply twice / revert what isn't applied.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scenariosDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scenariosDir, "../../..");

const [name, flag] = process.argv.slice(2);
const revert = flag === "--revert";
if (!name) {
  console.error("usage: apply.mjs <scenario-name> [--revert]");
  process.exit(1);
}

const scenarioPath = join(scenariosDir, name, "scenario.json");
if (!existsSync(scenarioPath)) {
  console.error(`no such scenario: ${scenarioPath}`);
  process.exit(1);
}
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

for (const step of scenario.steps) {
  const filePath = join(repoRoot, step.file);
  const doc = JSON.parse(readFileSync(filePath, "utf8"));
  const [from, to] = revert ? [step.replace, step.find] : [step.find, step.replace];

  const current = doc[step.field];
  if (typeof current !== "string") {
    console.error(`${step.file}: field "${step.field}" is not a string`);
    process.exit(1);
  }
  if (!current.includes(from)) {
    const state = current.includes(to) ? (revert ? "not applied" : "already applied") : "unexpected content";
    console.error(`${step.file}: ${state} — "${from}" not found. Aborting, nothing written.`);
    process.exit(1);
  }

  doc[step.field] = current.replace(from, to);
  if (step.bumpVersion) doc.version += revert ? -1 : 1;
  writeFileSync(filePath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`${revert ? "reverted" : "applied"}: ${step.file} (version ${doc.version})`);
}

console.log(`\nscenario "${scenario.name}" ${revert ? "reverted" : "applied"}.`);
if (!revert && scenario.expected) {
  const declared = scenario.expected.declaredAffected?.map((d) => d.prompt).join(", ");
  const inferred = scenario.expected.inferenceMustFind
    ?.map((i) => `${i.prompt}.${i.fragment}`)
    .join(", ");
  console.log(`declared graph reaches: ${declared}`);
  console.log(`inference must additionally find: ${inferred}`);
}
