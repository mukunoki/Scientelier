import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import type { TaskState } from "./types";

async function reportsView() {
  const state = { queue: { activeTaskIds: [] as string[] } };
  const sources = await Promise.all(["task-state", "reports"].map(name => readFile(`dist/renderer/${name}.js`, "utf8")));
  const view = runInNewContext(sources.join("\n") + "\n({reportButton,forgetTaskReportSelections,reportVersionSelections,reportDocumentSelections})", {
    state, document: { createElement: () => ({ addEventListener() {} }) }
  });
  return { view, state };
}

test("report controls preserve previous availability after moving to their own view", async () => {
  const { view, state } = await reportsView();
  const states: TaskState[] = ["queued", "planning", "running", "reviewing", "reporting", "completed", "failed", "blocked", "paused", "cancelled", "awaiting-input"];
  for (const status of states) for (const resume of [false, true]) for (const plan of [false, true]) {
    const active = ["planning", "running", "reviewing", "reporting"].includes(status);
    const available = !active && (resume || ["queued", "blocked", "paused"].includes(status) || status === "awaiting-input" && plan)
      && !["queued", "planning", "running", "reviewing", "reporting", "paused"].includes(status);
    const task = { id: "t", state: status, resumeFromUnitId: resume ? "unit" : undefined, awaitingReason: plan ? "plan" : undefined };
    assert.equal(!!view.reportButton(task), available, JSON.stringify(task));
  }
  const button = view.reportButton({ id: "t", state: "blocked", report: { state: "building" } });
  assert.equal(button.disabled, true);
  state.queue.activeTaskIds = ["t"];
  assert.equal(view.reportButton({ id: "t", state: "blocked" }), undefined, "an active owner cannot rebuild through a stale blocked label");
});

test("deleting one task releases report version and document selections without affecting others", async () => {
  const { view } = await reportsView();
  view.reportVersionSelections.set("t", 1);
  view.reportVersionSelections.set("other", 2);
  for (const key of ["t:current", "t:1", "other:current"]) view.reportDocumentSelections.set(key, "poster");
  view.forgetTaskReportSelections("t");
  assert.equal(view.reportVersionSelections.size, 1);
  assert.equal(view.reportVersionSelections.get("other"), 2);
  assert.equal(view.reportDocumentSelections.size, 1);
  assert.equal(view.reportDocumentSelections.get("other:current"), "poster");
});
