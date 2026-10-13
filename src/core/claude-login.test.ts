import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeLoginSession, isClaudeAuthorizationFailure, parseClaudeLoginStatus } from "./claude-login";
import type { TerminalProcess } from "./terminal-runner";
import { parseCodexLoginStatus, isCodexAuthorizationFailure } from "./codex-login";

test("Codex login status never reveals raw output or partial API keys", () => {
  assert.equal(parseCodexLoginStatus("warning\nLogged in using ChatGPT\n").loggedIn, true);
  const apiKey = parseCodexLoginStatus("Logged in using an API key - sk-PRIVATE");
  assert.equal(apiKey.authMethod, "API key");
  assert.doesNotMatch(JSON.stringify(apiKey), /PRIVATE/);
  assert.equal(parseCodexLoginStatus("Not logged in\n").loggedIn, false);
  const unknown = parseCodexLoginStatus("secret unknown output PRIVATE");
  assert.equal(unknown.loggedIn, undefined); assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE/);
  assert.equal(isCodexAuthorizationFailure("HTTP 401 Unauthorized"), true);
  assert.equal(isCodexAuthorizationFailure("capacity check timed out"), false);
  assert.equal(isCodexAuthorizationFailure("HTTP 429"), false);
});

test("Codex login PTY uses only the fixed official login command", () => {
  let killed = false;
  const child: TerminalProcess = { cols: 100, rows: 24, write: () => {}, resize: () => {}, kill: () => { killed = true; }, onData: () => {}, onExit: () => {} };
  const sessions = new ClaudeLoginSession((command, args) => {
    assert.equal(command, "/test/codex"); assert.deepEqual(args, ["login"]); return child;
  }, "codex");
  const id = sessions.start("/test/codex", "/tmp");
  assert.throws(() => sessions.input("another-provider", "x"));
  sessions.close(id); assert.equal(killed, true);
});

test("Claude login status exposes only allowlisted metadata, not credentials", () => {
  const status = parseClaudeLoginStatus(JSON.stringify({ loggedIn: true, authMethod: "oauth", subscriptionType: "max", accessToken: "PRIVATE", email: "private@example.com", refreshToken: "PRIVATE" }));
  assert.equal(status.loggedIn, true); assert.equal(status.authMethod, "oauth");
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE|private@example/);
  assert.equal(parseClaudeLoginStatus('{"loggedIn":false}').loggedIn, false);
  assert.throws(() => parseClaudeLoginStatus('{}'));
  assert.equal(isClaudeAuthorizationFailure("Claude usage authorization failed. Open Claude Code to renew your login, then refresh."), true);
  assert.equal(isClaudeAuthorizationFailure("Claude使用量APIの認証が拒否されました（HTTP 401）。"), true);
  assert.equal(isClaudeAuthorizationFailure("Claudeの使用量取得APIが要求を制限しています（HTTP 429）。"), false);
});

test("dedicated login terminal fixes command, retains no disk log, and rejects stale sessions", () => {
  let onData: (data: string) => void = () => {}, onExit: (v: { exitCode: number }) => void = () => {};
  let calls = 0, kills = 0, written = "";
  const child: TerminalProcess = { cols: 100, rows: 24, write: v => { written += v; }, resize: () => {}, kill: () => { kills++; },
    onData: fn => { onData = fn; }, onExit: fn => { onExit = fn; } };
  const sessions = new ClaudeLoginSession((command, args, cwd) => {
    calls++; assert.equal(command, '/test/claude'); assert.deepEqual(args, ['auth', 'login']); assert.equal(cwd, '/test/home'); return child;
  });
  const id = sessions.start('/test/claude', '/test/home');
  assert.equal(sessions.start('/test/claude', '/test/home'), id); assert.equal(calls, 1);
  onData('Login URL\r\n'); sessions.input(id, 'code\r'); assert.equal(written, 'code\r');
  assert.equal(sessions.snapshot(id).data, 'Login URL\r\n');
  assert.throws(() => sessions.input('wrong', 'x')); assert.throws(() => sessions.input(id, 'x'.repeat(16001)));
  assert.throws(() => sessions.resize(id, 0, 25));
  onData('x'.repeat(70000)); assert.equal(sessions.snapshot(id).data.length, 64000);
  onExit({exitCode: 0}); assert.equal(sessions.snapshot(id).alive, false);
  assert.throws(() => sessions.input(id, 'x'));
  sessions.close(id); assert.throws(() => sessions.snapshot(id)); assert.equal(kills, 0);
  const next = sessions.start('/test/claude', '/test/home'); assert.notEqual(next, id);
  sessions.close(next); assert.equal(kills, 1); onData('late'); assert.throws(() => sessions.snapshot(next));
});
