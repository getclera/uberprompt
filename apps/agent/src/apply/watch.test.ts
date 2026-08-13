import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { LessonDoc, LessonWatcher } from "@uberprompt/sdk";
import { WATCHER_NAME, watch, type WatchDeps } from "./watch";

function lesson(): LessonDoc {
  return {
    _id: new ObjectId(),
    text: "t",
    embedding: [],
    sourceTraceIds: [],
    appliesTo: [],
    status: "active",
    ts: new Date(),
  };
}

test("the stage-3 watcher owns a stable sync_state key so restarts resume, not replay", () => {
  assert.equal(WATCHER_NAME, "stage3-apply");
});

test("watch opens the change stream before draining the backlog so first-run has no gap", async () => {
  const order: string[] = [];
  const closed = new LessonWatcherStub();
  const deps: WatchDeps = {
    openWatcher: async () => {
      order.push("open");
      return closed;
    },
    fetchBacklog: async () => {
      order.push("backlog");
      return [lesson()];
    },
    handle: async () => {
      order.push("handle");
    },
  };

  const stop = await watch({}, deps);
  await stop();

  assert.deepEqual(order, ["open", "backlog", "handle"]);
});

test("a lesson inserted during backlog drain is handled via the live stream, not lost", async () => {
  const handled: string[] = [];
  const live = lesson();
  let deliver: ((l: LessonDoc) => Promise<void>) | undefined;
  const deps: WatchDeps = {
    openWatcher: async (onLesson) => {
      deliver = onLesson;
      return new LessonWatcherStub();
    },
    fetchBacklog: async () => {
      if (!deliver) throw new Error("stream must be open before backlog is queried");
      await deliver(live);
      return [];
    },
    handle: async (id) => {
      handled.push(id.toHexString());
    },
  };

  const stop = await watch({}, deps);
  await stop();

  assert.deepEqual(handled, [live._id!.toHexString()]);
});

class LessonWatcherStub implements LessonWatcher {
  resumeToken(): unknown {
    return undefined;
  }
  async close(): Promise<void> {}
}
