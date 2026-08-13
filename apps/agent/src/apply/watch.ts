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

export interface WatchDeps {
  openWatcher: (onLesson: (lesson: LessonDoc) => Promise<void>) => Promise<LessonWatcher>;
  fetchBacklog: () => Promise<LessonDoc[]>;
  handle: (lessonId: ObjectId) => Promise<void>;
}

export const defaultWatchDeps: WatchDeps = {
  openWatcher: (onLesson) => watchLessonsResumable(WATCHER_NAME, onLesson),
  fetchBacklog: backlog,
  handle: run,
};

export async function watch(
  opts: WatchOptions = {},
  deps: WatchDeps = defaultWatchDeps,
): Promise<() => Promise<void>> {
  const watcher = await deps.openWatcher(async (lesson) => {
    if (!lesson._id) return;
    console.log(`lesson ${lesson._id.toHexString()} inserted`);
    await deps.handle(lesson._id);
  });
  console.log(`watching lessons as "${WATCHER_NAME}" — stage 3 will file proposals as they arrive`);

  if (opts.drainBacklog !== false) {
    const pending = await deps.fetchBacklog();
    console.log(`backlog: ${pending.length} unprocessed lesson(s)`);
    for (const lesson of pending) {
      if (lesson._id) await deps.handle(lesson._id);
    }
  }

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
