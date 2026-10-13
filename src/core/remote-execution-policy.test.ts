import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { independentRemoteLock, remoteLaunchFailure } from "./remote-execution-policy";
import type { WorkUnit } from "./types";

test("all modes use independent locks for delegated readers, not shared writers", () => {
  const reader = { mode: "read", role: "worker", subtask: { kind: "investigation" } } as WorkUnit;
  for (const hpc of [false, true]) {
    assert.equal(independentRemoteLock(reader, hpc), true);
    assert.equal(independentRemoteLock({ ...reader, mode: "write" }, hpc), false);
    assert.equal(independentRemoteLock({ ...reader, primary: true }, hpc), false);
    assert.equal(independentRemoteLock({ ...reader, primaryStep: true } as WorkUnit, hpc), false);
    assert.equal(independentRemoteLock({ ...reader, role: "reporter" }, hpc), false);
  }
  const isolated = { ...reader, mode: "write", subtask: { kind: "isolated-work" } } as WorkUnit;
  assert.equal(independentRemoteLock(isolated, true), true);
  assert.equal(independentRemoteLock(isolated, false), false);
  assert.equal(independentRemoteLock({ mode: "read", crossReview: {} } as WorkUnit, false), true);
});

test("parallel coding readers can start together and duplicate launch still fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-reader-lock-"));
  const children: ReturnType<typeof spawn>[] = [], endings: Promise<unknown>[] = [];
  const unit = { mode: "read", role: "worker", subtask: { kind: "investigation" } } as WorkUnit;
  const start = async (id: string, lock: string) => {
    const dir = join(root, id); await mkdir(dir);
    const config = join(dir, "launch.json");
    await writeFile(config, JSON.stringify({ retirementProtocol: 1, command: process.execPath,
      args: ["-e", "console.log('READY');process.stdin.resume()"], cwd: root, lock, token: id,
      handoff: join(dir, "handoff.json"), exitPath: join(dir, "exit.json") }));
    const child = spawn(process.execPath, [join(__dirname, "remote-session.js"), config]);
    children.push(child); const ending = once(child, "exit"); endings.push(ending);
    let output = ""; child.stdout!.on("data", d => { output += d; }); child.stderr!.on("data", () => {});
    return { child, ending, dir, ready: () => output.includes("READY") };
  };
  try {
    const locks = ["a", "b"].map(id => independentRemoteLock(unit, false) ? join(root, id, "active.lock") : join(root, "active.lock"));
    const runs = await Promise.all([start("a", locks[0]), start("b", locks[1])]);
    const deadline = Date.now() + 4000;
    while (!runs.every(r => r.ready())) { assert.ok(Date.now() < deadline, "both readers must enter their CLI"); await new Promise(r => setTimeout(r, 20)); }
    assert.ok(runs.every(r => r.child.exitCode === null));
    const duplicate = await start("duplicate", locks[0]);
    assert.equal((await duplicate.ending)[0], 75);
    const receipt = JSON.parse(await readFile(join(duplicate.dir, "exit.json"), "utf8"));
    assert.match(remoteLaunchFailure(receipt, "duplicate")!, /実行ロックが競合/);
    assert.equal(remoteLaunchFailure(receipt, "wrong"), undefined);
    assert.equal(remoteLaunchFailure({ ...receipt, notStarted: false }, "duplicate"), undefined);
    assert.equal(JSON.parse(await readFile(join(locks[0], "owner.json"), "utf8")).token, "a");
    assert.equal(runs[0].child.exitCode, null, "a rejected duplicate must not retire its live sibling");
  } finally {
    for (const child of children) child.stdin?.end();
    await Promise.all(endings); await rm(root, { recursive: true, force: true });
  }
});
