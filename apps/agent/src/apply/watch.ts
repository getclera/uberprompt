import type { ObjectId } from "mongodb";
import { lessonsCol, watchLessonsResumable, type LessonDoc, type LessonWatcher } from "@uberprompt/sdk";
import { applyLesson } from "./index";

export const WATCHER_NAME = "stage3-apply";

export async function backlog(): Promise<LessonDoc[]> {
  return lessonsCol()
    .find({ status: "active", processedAt: { $exists: false } })
    .toArray();
}

export interface WatchOptions {
  drainBacklog?: boolean;
}

export async function watch(opts: WatchOptions = {}): Promise<() => Promise<void>> {
  if (opts.drainBacklog !== false) {
    const pending = await backlog();
    console.log(`backlog: ${pending.length} unprocessed lesson(s)`);
    for (const lesson of pending) {
      if (lesson._id) await run(lesson._id);
    }
  }

  const watcher: LessonWatcher = await watchLessonsResumable(WATCHER_NAME, async (lesson) => {
    if (!lesson._id) return;
    console.log(`lesson ${lesson._id.toHexString()} inserted`);
    await run(lesson._id);
  });

  console.log(`watching lessons as "${WATCHER_NAME}" — stage 3 will file proposals as they arrive`);
  return () => watcher.close();
}

async function run(lessonId: ObjectId): Promise<void> {
  try {
    const result = await applyLesson(lessonId);
    for (const outcome of result.outcomes) {
      console.log(`  ${outcome.prompt}: ${outcome.status.toUpperCase()} — ${outcome.reason}`);
    }
  } catch (error) {
    console.error(`  lesson ${lessonId.toHexString()} failed: ${(error as Error).message}`);
  }
}
