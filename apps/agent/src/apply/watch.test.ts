import { test } from "node:test";
import assert from "node:assert/strict";
import { WATCHER_NAME } from "./watch";

test("the stage-3 watcher owns a stable sync_state key so restarts resume, not replay", () => {
  assert.equal(WATCHER_NAME, "stage3-apply");
});
