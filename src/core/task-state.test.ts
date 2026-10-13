import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { isActiveTaskState } from "./task-state";
import type { TaskState } from "./types";

test("backend and browser agree on active states; queue ownership is an additional UI guard", async () => {
  const state = { queue: { activeTaskIds: ["owned"] } };
  const view = runInNewContext(`${await readFile("dist/renderer/task-state.js", "utf8")}\n({ taskStateIsActive, taskIsActive })`, { state });
  const states: TaskState[] = ["queued", "planning", "running", "reviewing", "reporting", "completed", "failed", "blocked", "paused", "cancelled", "awaiting-input"];
  for (const status of states) {
    const active = ["planning", "running", "reviewing", "reporting"].includes(status);
    assert.equal(isActiveTaskState(status), active, status);
    assert.equal(view.taskStateIsActive(status), active, status);
    assert.equal(view.taskIsActive({ id: "unowned", state: status }), active, status);
  }
  assert.equal(view.taskIsActive({ id: "owned", state: "queued" }), true);
  assert.equal(view.taskIsActive({ id: "owned", state: "paused" }), true, "saved state alone does not release a process lock");
});
