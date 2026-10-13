import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { remoteOperation } from "./remote-bridge";
import { remoteModules, remoteModuleLoader } from "./remote-modules";
import { runInNewContext } from "node:vm";

test("remote status uses fixed read-only argv and never returns raw credentials", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "service-auth-test-")));
  const pathBefore = process.env.PATH;
  try {
    process.env.PATH = `${dir}:${pathBefore}`;
    await writeFile(join(dir, "claude"), '#!/bin/sh\n[ "$1 $2" = "auth status" ] || exit 2\nprintf \'%s\\n\' \'{"loggedIn":false,"email":"secret@example.com","accessToken":"PRIVATE"}\'\nexit 1\n', { mode: 0o700 });
    await writeFile(join(dir, "codex"), '#!/bin/sh\n[ "$1 $2" = "login status" ] || exit 2\nprintf \'%s\\n\' \'Logged in using an API key - SECRET_KEY\' >&2\n', { mode: 0o700 });
    const claude = await remoteOperation(dir, { op: "login-status", agentId: "claude" }) as any;
    const codex = await remoteOperation(dir, { op: "login-status", agentId: "codex" }) as any;
    assert.equal(claude.loggedIn, false); assert.equal(codex.loggedIn, true);
    assert.doesNotMatch(JSON.stringify([claude, codex]), /secret|PRIVATE|SECRET_KEY/);
    for (const id of ["opencode", "constructor", "claude;echo unexpected"]) {
      const result = await remoteOperation(dir, { op: "login-status", agentId: id }) as any;
      assert.equal(result.loggedIn, undefined);
      assert.equal(result.checkSupported, false);
    }
  } finally { process.env.PATH = pathBefore; await rm(dir, { recursive: true, force: true }); }
});

test("remote capacity is parsed on the final host and unsupported services stay unknown", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "service-capacity-test-")));
  try {
    const sources = await remoteModules("dist/core");
    const bridge = runInNewContext(`${remoteModuleLoader(sources)}load('./remote-bridge')`, { require });
    const unknown = await bridge.remoteOperation(dir, { op: "service-capacity", agentId: "opencode" });
    assert.equal(unknown.unsupported, true);
    // Replace the bundled probe, not the user's actual credentials or CLI.
    sources["./capacity-probes"] = "exports.readCodexCapacity=async(exe,cwd)=>({limited:false,usedPercent:37,windows:[{id:'week',usedPercent:37}]});";
    const stubbed = runInNewContext(`${remoteModuleLoader(sources)}load('./remote-bridge')`, { require });
    const result = await stubbed.remoteOperation(dir, { op: "service-capacity", agentId: "codex" });
    assert.equal(result.observation.usedPercent, 37);
    sources["./capacity-probes"] = "exports.readCodexCapacity=async()=>{throw Error('PRIVATE_TOKEN')};";
    const broken = runInNewContext(`${remoteModuleLoader(sources)}load('./remote-bridge')`, { require });
    const failure = await broken.remoteOperation(dir, { op: "service-capacity", agentId: "codex" });
    assert.ok(failure.error); assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_TOKEN/);
    assert.equal(failure.retryAfterMs, 60_000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bundled remote Antigravity hook installs without accessing the real home", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "service-agy-bundle-")));
  try {
    const sources = await remoteModules("dist/core");
    const bridge = runInNewContext(`${remoteModuleLoader(sources)}load('./remote-bridge')`, {
      require: (name: string) => name === "node:os" ? { homedir: () => dir } : require(name), process
    });
    const message = await bridge.remoteOperation(dir, { op: "antigravity-usage-install" });
    assert.match(message, /Usage連携を保存/);
    const settings = JSON.parse(await readFile(join(dir, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
    assert.ok(settings.statusLine.command.includes(dir));
    const missing = await bridge.remoteOperation(dir, { op: "service-capacity", agentId: "antigravity" });
    assert.match(missing.error, /未観測|観測がありません/);
    const observedAt = new Date().toISOString();
    await writeFile(join(dir, ".agent-harness", "service-usage", "antigravity-quota.json"), JSON.stringify({
      version: 1, observedAt, secret: "PRIVATE", quota: { "gemini-weekly": { remaining_fraction: .8 } }
    }));
    const result = await bridge.remoteOperation(dir, { op: "service-capacity", agentId: "antigravity" });
    assert.equal(result.observedAt, observedAt); assert.equal(result.observation.windows[0].usedPercent, 20);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
