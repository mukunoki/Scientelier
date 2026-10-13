import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function terminalRenderer() {
  const native = { id: "native", taskId: "t", agentId: "claude", terminal: true };
  const legacy = { id: "legacy", agentId: "codex", role: "worker", state: "completed", output: "saved output" };
  const task = { id: "t", runs: [native, legacy] };
  const state = { tasks: [task], selectedTerminalAgents: new Map(), selectedTaskId: "t" };
  const sources = await Promise.all(["terminals", "terminal-logs"].map(name => readFile(`dist/renderer/${name}.js`, "utf8")));
  const view = runInNewContext(sources.join("\n") + `\n({
    appendRunEvent, terminalTextForAgent, visibleTerminalText,
    forgetTaskTerminalSelections, legacyTerminalState, terminalRunSelections,
    terminalTiledTasks, terminalViews
  })`, { state, humanOutput: (text: string) => text, document: { getElementById: () => null } });
  return { view, state, task, legacy };
}

test("unopened native terminal events do not accumulate in legacy log buffers", async () => {
  const { view } = await terminalRenderer();
  const event = { taskId: "t", runId: "native", agentId: "claude", type: "status", text: "Terminal startup: waiting" };
  for (let index = 0; index < 100; index++) view.appendRunEvent(event);
  view.appendRunEvent({ ...event, type: "stdout", text: "PTY", terminalOffset: 3 });
  assert.equal(view.legacyTerminalState.liveRuns.size, 0);
  view.appendRunEvent({ ...event, runId: "legacy", type: "stdout", text: "saved event", displayText: "readable event" });
  assert.equal(view.legacyTerminalState.liveRuns.get("legacy").raw, "saved event");
  assert.equal(view.legacyTerminalState.liveRuns.get("legacy").readable, "readable event");
});

test("pre-PTY logs retain readable/raw views and display-only clearing", async () => {
  const { view, task, legacy } = await terminalRenderer();
  assert.equal(view.terminalTextForAgent(task, "codex", "raw"), "saved output");
  view.appendRunEvent({ taskId: "t", runId: "legacy", agentId: "codex", type: "stderr", text: "problem" });
  assert.equal(view.terminalTextForAgent(task, "codex", "readable"), "⚠ problem");
  assert.equal(view.terminalTextForAgent(task, "codex", "raw"), "[stderr] problem");
  view.legacyTerminalState.clearOffsets.set("t:codex", { readable: 9, raw: 16 });
  assert.match(view.visibleTerminalText(task, "codex", "readable"), /Display cleared/);
  assert.equal(legacy.output, "saved output", "clearing the display never mutates saved logs");
});

test("deleting a task forgets its selections and legacy buffers but not another task", async () => {
  const { view, state, task } = await terminalRenderer();
  state.selectedTerminalAgents.set("t", "codex");
  state.selectedTerminalAgents.set("other", "claude");
  for (const key of ["t:codex", "t:claude", "other:codex"]) {
    view.terminalRunSelections.set(key, "selected");
    view.legacyTerminalState.viewModes.set(key, "raw");
    view.legacyTerminalState.clearOffsets.set(key, { readable: 1, raw: 1 });
  }
  view.terminalTiledTasks.add("t");
  view.terminalTiledTasks.add("other");
  view.legacyTerminalState.liveRuns.set("legacy", { raw: "old", readable: "old" });
  view.legacyTerminalState.liveRuns.set("elsewhere", { raw: "kept", readable: "kept" });
  view.forgetTaskTerminalSelections(task);
  assert.equal(state.selectedTerminalAgents.has("t"), false);
  assert.equal(state.selectedTerminalAgents.get("other"), "claude");
  assert.equal(view.terminalTiledTasks.has("t"), false);
  assert.equal(view.terminalTiledTasks.has("other"), true);
  for (const map of [view.terminalRunSelections, view.legacyTerminalState.viewModes, view.legacyTerminalState.clearOffsets]) {
    assert.equal(map.size, 1);
    assert.equal(map.has("other:codex"), true);
  }
  assert.equal(view.legacyTerminalState.liveRuns.has("legacy"), false);
  assert.equal(view.legacyTerminalState.liveRuns.has("elsewhere"), true);
});
