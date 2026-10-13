import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AppDiagnostics, diagnosticText } from "./app-diagnostics";

function fixture(action: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "harness-diagnostics-"));
  try { action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("diagnostics persist lifecycle, private permissions and unclosed sessions", () => fixture(directory => {
  const first = new AppDiagnostics(directory);
  first.checkpoint({ taskId: "task-a", state: "running" });
  const second = new AppDiagnostics(directory);
  assert.match(readFileSync(second.file, "utf8"), /previous-session-unclosed/);
  assert.equal(JSON.parse(readFileSync(join(directory, "session.json"), "utf8")).clean, false);
  assert.equal(statSync(second.file).mode & 0o777, 0o600);
  second.finish(0);
  assert.equal(JSON.parse(readFileSync(join(directory, "session.json"), "utf8")).clean, true);
  const third = new AppDiagnostics(directory);
  assert.equal(readFileSync(third.file, "utf8").match(/previous-session-unclosed/g)?.length, 1);
}));

test("diagnostic secrets and authenticated URL parameters are masked", () => {
  const result = diagnosticText({ password: "hidden-pass", refresh_token: "hidden-refresh", apiKey: "hidden-api", url: "https://user:pass@example.com/callback?code=hidden-code", message: 'Authorization: Bearer hidden-bearer {"access_token":"hidden-access"} sk-abcdefghijklmnop' });
  for (const secret of ["hidden-pass", "hidden-refresh", "hidden-api", "hidden-code", "hidden-bearer", "hidden-access", "user:pass", "sk-abcdefghijklmnop"]) assert.ok(!result.includes(secret), result);
});

test("rotation limits disk use and very long lines", () => fixture(directory => {
  const log = new AppDiagnostics(directory, 2048, 2);
  for (let i = 0; i < 50; i++) log.log("error", "test-error", "日本語".repeat(9000));
  const logs = readdirSync(directory).filter(name => name.startsWith("application.log"));
  assert.equal(logs.length, 3);
  for (const file of logs) assert.ok(statSync(join(directory, file)).size <= 2048);
}));

test("failure to save diagnostics never interrupts the caller", () => fixture(directory => {
  const path = join(directory, "not-a-directory"); writeFileSync(path, "kept");
  const log = new AppDiagnostics(path); log.log("error", "disk-error"); log.checkpoint(); log.finish(1);
  assert.equal(readFileSync(path, "utf8"), "kept");
}));

test("error storms are bounded but fatal errors remain recorded", t => fixture(directory => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const log = new AppDiagnostics(directory);
  for (let i = 0; i < 150; i++) log.log("error", "repeating-error");
  log.recordFatal(new Error("fatal-during-storm"), "uncaughtException");
  now += 1000;
  log.checkpoint();
  const text = readFileSync(log.file, "utf8");
  assert.ok((text.match(/repeating-error/g) ?? []).length <= 100);
  assert.match(text, /fatal-during-storm/);
  assert.match(text, /log-burst-suppressed/);
}));

test("uncaught exceptions and rejected promises are logged without suppressing failure", () => fixture(directory => {
  for (const [name, code] of [["exception", "throw new Error('fatal-example')"], ["rejection", "Promise.reject(new Error('rejection-example'))"]]) {
    const folder = join(directory, name);
    const child = spawnSync(process.execPath, ["--unhandled-rejections=throw", "-e", `const m=require(${JSON.stringify(join(__dirname, "app-diagnostics.js"))});m.installProcessDiagnostics(new m.AppDiagnostics(${JSON.stringify(folder)}));${code}`], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    assert.equal(child.status, 1, child.stderr);
    assert.match(readFileSync(join(folder, "application.log"), "utf8"), /FATAL.*(?:fatal-example|rejection-example)/);
    assert.equal(JSON.parse(readFileSync(join(folder, "session.json"), "utf8")).clean, false);
  }
}));

test("termination signals are recorded then retain signal exit semantics", () => fixture(directory => {
  const child = spawnSync(process.execPath, ["-e", `const m=require(${JSON.stringify(join(__dirname, "app-diagnostics.js"))});m.installProcessDiagnostics(new m.AppDiagnostics(${JSON.stringify(directory)}));setTimeout(()=>process.kill(process.pid,'SIGTERM'),20);setInterval(()=>{},1000);`], { encoding: "utf8", timeout: 5000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal(child.signal, "SIGTERM", child.stderr);
  assert.match(readFileSync(join(directory, "application.log"), "utf8"), /process-signal.*SIGTERM/);
  assert.equal(JSON.parse(readFileSync(join(directory, "session.json"), "utf8")).clean, false);
}));

test("main console warnings are persisted and a normal exit closes the session", () => fixture(directory => {
  const child = spawnSync(process.execPath, ["-e", `const m=require(${JSON.stringify(join(__dirname, "app-diagnostics.js"))});m.installProcessDiagnostics(new m.AppDiagnostics(${JSON.stringify(directory)}));console.warn('warning-example');console.error({password:'never-save-this'});`], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal(child.status, 0, child.stderr);
  const log = readFileSync(join(directory, "application.log"), "utf8");
  assert.match(log, /main-console-warn.*warning-example/);
  assert.ok(!log.includes("never-save-this"));
  assert.equal(JSON.parse(readFileSync(join(directory, "session.json"), "utf8")).clean, true);
}));
