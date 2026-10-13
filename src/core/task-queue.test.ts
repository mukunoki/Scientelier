import assert from "node:assert/strict";
import test from "node:test";
import { TaskQueue, combinedQueueStatus } from "./task-queue";

test("queue notifications combine direct and queued work with consistent legacy ID", () => {
  const status = { running: true, stopping: false, activeTaskIds: ["queued", "shared"], activeTaskId: "queued" };
  assert.deepEqual(combinedQueueStatus(status, new Set(["shared", "direct"])), {
    ...status, activeTaskIds: ["queued", "shared", "direct"], activeTaskId: "queued"
  });
  assert.deepEqual(status.activeTaskIds, ["queued", "shared"]);
  const idle = { running: false, stopping: false };
  assert.deepEqual(combinedQueueStatus(idle, ["direct"]), { ...idle, activeTaskIds: ["direct"], activeTaskId: "direct" });
  assert.deepEqual(combinedQueueStatus(idle, []), { ...idle, activeTaskIds: [], activeTaskId: undefined });
});

test("parallel queue fills vacant slots, isolates failure and stops only future admission", async () => {
  const started: string[] = [], releases = new Map<string, () => void>();
  const pending = ["a","b","c","d"];
  const queue = new TaskQueue(excluded => { const id=pending.find(id=>!excluded.has(id)); return id ? {id} : undefined; }, async id => {
    started.push(id); await new Promise<void>(resolve => { releases.set(id,resolve); });
    if (id === "a") throw Error("one task failed");
  }, () => {}, 2);
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  queue.start(); await tick(); assert.deepEqual(started,["a","b"]);
  releases.get("a")!(); await tick(); assert.deepEqual(started,["a","b","c"]);
  queue.stopAfterCurrent(); releases.get("b")!(); await tick();
  assert.equal(queue.getStatus().running,true); assert.equal(started.length,3);
  releases.get("c")!(); await tick(); assert.equal(queue.getStatus().running,false);
});

test("queue executes queued tasks once in FIFO order", async () => {
  const pending = [{ id: "first" }, { id: "second" }, { id: "third" }];
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });

  const queue = new TaskQueue(
    () => pending.shift(),
    async (id) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      order.push(id);
      active -= 1;
    },
    (status) => {
      if (!status.running && order.length === 3) finish();
    }
  );

  queue.start();
  await finished;
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.equal(maxActive, 1);
  assert.deepEqual(queue.getStatus(), { running: false, stopping: false });
});

test("queue stop waits for the active task and leaves later tasks queued", async () => {
  const pending = [{ id: "first" }, { id: "second" }];
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });

  const queue = new TaskQueue(
    () => pending.shift(),
    async (id) => {
      await gate;
      order.push(id);
    },
    (status) => {
      if (!status.running && order.length === 1) finish();
    }
  );

  queue.start();
  queue.stopAfterCurrent();
  release();
  await finished;
  assert.deepEqual(order, ["first"]);
  assert.deepEqual(pending, [{ id: "second" }]);
});

test("queue does not spin forever when an executor leaves a task queued", async () => {
  let executions = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const queue = new TaskQueue(
    () => ({ id: "stuck" }),
    async () => {
      executions += 1;
      throw new Error("executor failed before updating task state");
    },
    (status) => {
      if (!status.running && executions > 0) finish();
    }
  );

  queue.start();
  await finished;
  assert.equal(executions, 1);
});
