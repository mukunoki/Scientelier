import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInvocation, AGENT_PROFILES } from "./adapters";
import { readAntigravityLoginStatus, assertAntigravityAccountMode } from "./antigravity-login";
import { antigravitySettingsSummary } from "./remote-bridge";
import { ClaudeLoginSession } from "./claude-login";
import { loginIssue } from "./login-issue";
import type { TerminalProcess } from "./terminal-runner";

test("Antigravity is a separate CLI with interactive argv and scoped handoff directories", () => {
  const profile = AGENT_PROFILES.find(a => a.id === "antigravity")!;
  assert.equal(profile.command, "agy");
  const invocation = buildInvocation({ ...profile, installed: true, executable: "/test/agy" }, {
    prompt: "Work within the approved goal", cwd: "/test/work", mode: "write", model: "fixture-model", additionalDirectories: ["/test/report", "/test/handoff"]
  });
  assert.equal(invocation.command, "/test/agy");
  assert.deepEqual(invocation.args, ["--prompt-interactive", "Work within the approved goal", "--mode", "accept-edits", "--dangerously-skip-permissions", "--model", "fixture-model", "--add-dir", "/test/report", "--add-dir", "/test/handoff"]);
  assert.ok(!invocation.args.includes("--print") && !invocation.args.includes("--prompt"));
  assert.throws(() => buildInvocation({ ...profile, installed: true, executable: "/test/agy" }, {
    prompt: "work", cwd: "/test", mode: "write", continueSession: "00000000-0000-0000-0000-000000000000"
  }), /引き継げません/);
});

test("Antigravity account-only preflight never reads credentials or falls back to API/credits", async () => {
  const home = await mkdtemp(join(tmpdir(), "ah-agy-test-"));
  try {
    assert.equal((await readAntigravityLoginStatus(undefined, home)).installed, false);
    assert.equal((await readAntigravityLoginStatus("/test/agy", home)).state, "unverified");
    assertAntigravityAccountMode(await antigravitySettingsSummary(home), true);
    await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    const file = join(home, ".gemini", "antigravity-cli", "settings.json");
    await writeFile(file, JSON.stringify({ modelProvider: "gemini", apiKey: "PRIVATE", email: "secret@example.org" }));
    const api = await readAntigravityLoginStatus("/test/agy", home);
    assert.equal(api.launchBlocked, true); assert.equal(api.state, "api-configured");
    assert.doesNotMatch(JSON.stringify(api), /PRIVATE|secret@example/);
    assert.throws(() => assertAntigravityAccountMode({ valid: true, provider: "unknown", creditsEnabled: false }), /接続先/);
    await writeFile(file, '{"useG1Credits":true}');
    assert.equal((await readAntigravityLoginStatus("/test/agy", home)).launchBlocked, false, "allow opening settings without executing a model");
    const credits = await antigravitySettingsSummary(home);
    assert.throws(() => assertAntigravityAccountMode(credits, true), /クレジット/);
    await writeFile(file, '{"useG1Credits":false}');
    assertAntigravityAccountMode(await antigravitySettingsSummary(home), true);
    await writeFile(file, 'PRIVATE broken json');
    const invalid = await readAntigravityLoginStatus("/test/agy", home);
    assert.equal(invalid.launchBlocked, true); assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE/);
    await writeFile(file, ' '.repeat(256001));
    assert.equal((await antigravitySettingsSummary(home)).valid, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Google login errors survive split PTY chunks without exposing OAuth data or declaring success", () => {
  let onData: (data: string) => void = () => {};
  const child: TerminalProcess = { cols: 100, rows: 24, write() {}, resize() {}, kill() {}, onExit() {}, onData: fn => { onData = fn; } };
  const client = new ClaudeLoginSession((_cmd, args) => { assert.deepEqual(args, []); return child; }, "antigravity");
  const id = client.start("/test/agy", "/test/home");
  onData("\x1b[31mFailed to sign in. Message: This client is no longer ");
  onData("supported for Gemini Code Assist for individuals\x1b[0m\r\nPRIVATE oauth-url");
  assert.equal(loginIssue("antigravity", client.snapshot(id).data)?.code, "unsupported-client");
  assert.equal(client.currentIssue()?.code, "unsupported-client");
  assert.doesNotMatch(JSON.stringify(client.currentIssue()), /PRIVATE|oauth-url/);
  assert.equal(client.snapshot(id).alive, true, "show error without killing the interactive session");
  client.close(id); assert.equal(client.currentIssue(), undefined);
  const agy = new ClaudeLoginSession((_cmd, args) => { assert.deepEqual(args, []); return child; }, "antigravity");
  const agyId = agy.start("/test/agy", "/test/home");
  onData("Authentication failed: PRIVATE");
  assert.equal(agy.snapshot(agyId).issue?.code, "authentication-failed");
  assert.doesNotMatch(JSON.stringify(agy.currentIssue()), /PRIVATE/);
  assert.equal(loginIssue("antigravity", "Browser authentication succeeded"), undefined);
  assert.equal(loginIssue("codex", "Failed to sign in"), undefined);
});
