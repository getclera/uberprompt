import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResumeToken, writeResumeToken } from "./watch";

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "uberprompt-watch-")), name);
}

test("a missing token file means a fresh stream, not a crash", () => {
  assert.equal(readResumeToken(tempPath("absent.json")), undefined);
});

test("a written token round-trips so a restart resumes where it stopped", () => {
  const path = tempPath("nested/token.json");
  const token = { _data: "82ABCDEF00000001" };
  writeResumeToken(path, token);
  assert.deepEqual(readResumeToken(path), token);
});

test("an undefined token is never persisted over a good one", () => {
  const path = tempPath("token.json");
  writeResumeToken(path, { _data: "keepme" });
  writeResumeToken(path, undefined);
  assert.deepEqual(readResumeToken(path), { _data: "keepme" });
});

test("a corrupt token file fails loudly rather than silently starting over", () => {
  const path = tempPath("corrupt.json");
  writeResumeToken(path, { _data: "x" });
  writeFileSync(path, "{not json");
  assert.throws(() => readResumeToken(path));
  assert.equal(readFileSync(path, "utf8"), "{not json");
});
