import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

test("remote diagnostics use fixed harmless probes and retain sandbox denial without weakening policy", async () => {
  const source = await readFile(join(__dirname, "remote-diagnostics.js"), "utf8");
  const calls: Array<{ command: string; args: string[] }> = [];
  const exports: any = {};
  runInNewContext(source, { exports, process: { platform: "linux", cwd: () => "/work/final" }, require: (id: string) => {
    if (id === "node:os") return { release: () => "fixture-kernel" };
    if (id === "node:fs/promises") return { readFile: async () => "1" };
    if (id === "node:child_process") return { execFile: (command: string, args: string[], options: any, callback: any) => {
      calls.push({ command, args }); assert.equal(options.timeout, 8000);
      if (args.includes("sandbox")) callback(Object.assign(new Error("denied"), { code: 1, stderr: "bwrap: setting up uid map: Permission denied" }));
      else callback(null, { stdout: "ok", stderr: "" });
    } };
    return require(id);
  } });
  const result = await exports.collectRemoteDiagnostics("/opt/codex");
  assert.equal(result.cwd, "/work/final");
  assert.equal(result.checks.filter((c: any) => !c.ok).length, 2);
  assert.match(result.checks.at(-1).detail, /bwrap/);
  const sandboxes = calls.filter(c => c.args.includes("sandbox"));
  assert.equal(sandboxes.length, 2);
  assert.ok(sandboxes.every(c => c.args.at(-1) === "/usr/bin/true"));
  assert.doesNotMatch(JSON.stringify(calls), /danger-full-access|bypass|sudo|sysctl|exec.*prompt/);
  assert.ok(sandboxes.some(c => c.args.includes('sandbox_mode="read-only"')));
  assert.ok(sandboxes.some(c => c.args.includes('sandbox_mode="workspace-write"')));
  calls.length = 0;
  const full = await exports.collectRemoteDiagnostics("/opt/codex", true, true);
  assert.equal(full.codexPermissions, "full-access");
  assert.equal(full.checks.length, 2);
  assert.deepEqual(calls.map(c => c.command), ["/usr/bin/true", "/opt/codex"]);
  assert.equal(calls.some(c => c.args.includes("sandbox") || c.command === "unshare"), false);
});

test("worker and terminal outcome labels distinguish receipt from blocked work, without changing saved states", async () => {
  const context: any = {};
  runInNewContext(await readFile(join(__dirname, "..", "renderer", "task-history.js"), "utf8"), context);
  runInNewContext(await readFile(join(__dirname, "..", "renderer", "work-outcome.js"), "utf8"), context);
  const unit: any = { id: "u", role: "worker", state: "completed", output: '<work-check>{"status":"ask-user","summary":"bwrap denied"}</work-check>' };
  const task: any = { autonomyState: "needs-input", workUnits: [unit] };
  assert.match(context.unitStatusLabel(task, unit), /要対応/);
  assert.match(context.runStatusLabel(task, { state: "completed", workUnitId: "u" }), /応答受領・要対応/);
  assert.match(context.unitStatusLabel(task, { role: "reporter", state: "pending" }), /先行工程/);
  assert.equal(unit.state, "completed");
  unit.output = '<work-check>{"status":"needs-work","summary":"repair"}</work-check>';
  assert.equal(context.unitStatusLabel(task, unit), "担当終了・未完了報告");
  unit.output = '<work-check>{"status":"ready","summary":"done"}</work-check>';
  assert.equal(context.unitStatusLabel(task, unit), "完了");
  unit.state = "running"; assert.equal(context.unitStatusLabel(task, unit), "実行中");
});
