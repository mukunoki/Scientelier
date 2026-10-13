import test from "node:test";
import assert from "node:assert/strict";
import { ServiceTerminals, serviceTerminalArgs } from "./service-terminals";
import type { TerminalRunner } from "./terminal-runner";
import type { RemoteConnection } from "./remote-client";

test("service terminals reuse the exact connection; hide/reopen does not relaunch; exits allow fresh sessions", () => {
  const snapshots = new Map<string, any>(); const launches: any[] = [];
  const runner = { snapshot: (id: string) => snapshots.get(id), forget: (id: string) => snapshots.delete(id),
    cancel: (id: string) => { snapshots.get(id).alive = false; return true; }, write() {}, resize() {} } as unknown as TerminalRunner;
  const client = { system: { id: "remote" }, connected: true, resolvedCwd: "/work", agents: [{ id: "codex", installed: true, executable: "/bin/codex" }] } as RemoteConnection;
  const manager = new ServiceTerminals(runner, (id, connection, spec) => {
    launches.push({ connection, spec }); snapshots.set(id, { alive: true }); return new Promise(() => {});
  }, () => {});
  const first = manager.start(client, "codex", "login");
  assert.deepEqual(launches[0].spec, { command: "/bin/codex", args: ["login", "--device-auth"], cwd: "/work" });
  assert.equal(manager.start(client, "codex", "cli"), first);
  assert.equal(launches.length, 1);
  assert.throws(() => manager.start({ ...client }, "codex", "cli"), /別の接続/);
  assert.equal(manager.active("remote").length, 1);
  manager.stop(first);
  assert.notEqual(manager.start(client, "codex", "cli"), first);
  assert.deepEqual(launches[1].spec.args, []);
  client.connected = false;
  assert.throws(() => manager.start(client, "codex", "cli"), /SSH/);
  assert.throws(() => manager.input(first, "secret"), /認証端末/);
});
test("login commands do not enable bypass permissions or forward secrets", () => {
  assert.deepEqual(serviceTerminalArgs("claude", "login"), ["auth", "login"]);
  assert.deepEqual(serviceTerminalArgs("opencode", "login", "zai"), ["auth", "login", "--provider", "zai-coding-plan"]);
  assert.deepEqual(serviceTerminalArgs("antigravity", "cli"), []);
});
