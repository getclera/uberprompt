import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { lessonsCol, watchLessons, type LessonDoc } from "@uberprompt/sdk";
import { applyLesson } from "./index";

export const DEFAULT_TOKEN_PATH = ".uberprompt/stage3-resume-token.json";

export function readResumeToken(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function writeResumeToken(path: string, token: unknown): void {
  if (token === undefined) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(token));
}

export async function backlog(): Promise<LessonDoc[]> {
  return lessonsCol()
    .find({ status: "active", processedAt: { $exists: false } })
    .toArray();
}

export interface WatchOptions {
  tokenPath?: string;
  drainBacklog?: boolean;
}

export async function watch(opts: WatchOptions = {}): Promise<() => Promise<void>> {
  const tokenPath = opts.tokenPath ?? DEFAULT_TOKEN_PATH;
  const resumeAfter = readResumeToken(tokenPath);
  console.log(
    resumeAfter
      ? `resuming lessons change stream from stored token (${tokenPath})`
      : "no stored token — starting a fresh lessons change stream",
  );

  if (opts.drainBacklog !== false) {
    const pending = await backlog();
    console.log(`backlog: ${pending.length} unprocessed lesson(s)`);
    for (const lesson of pending) {
      if (lesson._id) await run(lesson._id);
    }
  }

  const watcher = watchLessons(async (lesson, token) => {
    if (!lesson._id) return;
    console.log(`lesson ${lesson._id.toHexString()} inserted`);
    await run(lesson._id);
    writeResumeToken(tokenPath, token);
  }, resumeAfter !== undefined ? { resumeAfter } : {});

  console.log("watching lessons — stage 3 will file proposals as they arrive");
  return async () => {
    writeResumeToken(tokenPath, watcher.resumeToken());
    await watcher.close();
  };
}

async function run(lessonId: import("mongodb").ObjectId): Promise<void> {
  try {
    const result = await applyLesson(lessonId);
    for (const outcome of result.outcomes) {
      console.log(`  ${outcome.prompt}: ${outcome.status.toUpperCase()} — ${outcome.reason}`);
    }
  } catch (error) {
    console.error(`  lesson ${lessonId.toHexString()} failed: ${(error as Error).message}`);
  }
}
