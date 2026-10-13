import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { completionFromHook, completionMarker, guardedCompletion } from "./completion-hook";
import { recordChannelState, readChannelState } from "./channel-state";
import { quoteShellArgument } from "./adapters";

test("only a native final response with this run's final marker completes a work unit", () => {
  const final = `Verified findings\n${completionMarker("current")}`;
  assert.deepEqual(completionFromHook("codex", { type: "agent-turn-complete", "last-assistant-message": final }, "current"), { status: "completed", summary: "Verified findings" });
  assert.deepEqual(completionFromHook("claude", { hook_event_name: "Stop", last_assistant_message: final }, "current"), { status: "completed", summary: "Verified findings" });
  for (const response of ["", "Can I run this?", `\n${completionMarker("current")}`, `Summary\n${completionMarker("other")}`, `${final}\nStill working`]) {
    assert.equal(completionFromHook("claude", { hook_event_name: "Stop", last_assistant_message: response }, "current"), undefined);
  }
  assert.equal(completionFromHook("claude", { hook_event_name: "SubagentStop", last_assistant_message: final }, "current"), undefined);
  assert.equal(completionFromHook("claude", { hook_event_name: "Stop", agent_id: "child", last_assistant_message: final }, "current"), undefined);
  assert.equal(completionFromHook("codex", { type: "approval-requested", "last-assistant-message": final }, "current"), undefined);
});

test("native rate limits route as rate-limited, not successful completion", () => {
  assert.equal(completionFromHook("claude", { hook_event_name: "StopFailure", error: "rate_limit", error_details: "429" }, "token")?.status, "rate-limited");
  assert.equal(completionFromHook("claude", { hook_event_name: "StopFailure", error: "authentication_failed" }, "token")?.failure?.kind,"authentication");
  assert.equal(completionFromHook("codex", { type: "agent-turn-complete", "last-assistant-message": `Partial work\n${completionMarker("token", "rate-limited")}` }, "token")?.status, "rate-limited");
});

test("native final without instruction receipt stops resumably, never advances or kills the CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-channel-guard-"));
  try {
    await writeFile(join(directory, "channel-required.json"), JSON.stringify({token:"current"}));
    const stop = {hook_event_name:"Stop",last_assistant_message:"MCP is disconnected; no work was started."};
    let result = await guardedCompletion("claude",stop,"current",directory);
    assert.equal(result?.status,"blocked"); assert.match(result!.summary,/接続・指示取得が確認できません/);
    await recordChannelState(directory,"old","instructions-read");
    assert.equal(await readChannelState(directory,"current"),undefined);
    assert.equal((await guardedCompletion("claude",stop,"current",directory))?.status,"blocked");
    await recordChannelState(directory,"current","connected");
    assert.match((await guardedCompletion("claude",stop,"current",directory))!.summary,/接続は確認できました/);
    const done = {...stop,last_assistant_message:`Verified\n${completionMarker("current")}`};
    assert.equal((await guardedCompletion("claude",done,"current",directory))?.status,"blocked");
    await recordChannelState(directory,"current","instructions-read");
    await recordChannelState(directory,"current","connected");
    assert.equal((await readChannelState(directory,"current"))?.phase,"instructions-read");
    assert.equal((await guardedCompletion("claude",done,"current",directory))?.status,"completed");
    assert.match((await guardedCompletion("claude",stop,"current",directory))!.summary,/指示は取得済み/);
    for (const event of [{...stop,agent_id:"child"},{...stop,hook_event_name:"PermissionRequest"},{...stop,last_assistant_message:""}]) assert.equal(await guardedCompletion("claude",event,"current",directory),undefined);
    assert.equal((await guardedCompletion("claude",{hook_event_name:"StopFailure",error:"authentication_failed"},"current",directory))?.status,"blocked");
    assert.equal((await guardedCompletion("claude",{hook_event_name:"StopFailure",error:"rate_limit"},"current",directory))?.status,"rate-limited");
    assert.equal((await guardedCompletion("codex",{type:"agent-turn-complete","last-assistant-message":"Cannot start"},"current",directory))?.status,"blocked");
    assert.equal(await guardedCompletion("claude",done,"other",directory),undefined);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("real notification processes deliver stdin and argv payloads without an agent file write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness hook's test-"));
  const hook = join(__dirname, "completion-hook.js");
  const command = async (provider: string, path: string, payload: object) => {
    const args = [process.execPath, hook, provider, path, "run-token"];
    if (provider === "codex") args.push(JSON.stringify(payload));
    const child = spawn("/bin/sh", ["-c", args.map(quoteShellArgument).join(" ")]);
    let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
    child.stdin.end(provider === "claude" ? JSON.stringify(payload) : undefined);
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0); assert.equal(stderr, "");
  };
  try {
    for (const provider of ["codex", "claude"]) {
      const path = join(directory, `${provider}.json`);
      const text = `Results for next role\n${completionMarker("run-token")}`;
      await command(provider, path, provider === "codex" ? { type: "agent-turn-complete", "last-assistant-message": text } : { hook_event_name: "Stop", last_assistant_message: text });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { token: "run-token", status: "completed", summary: "Results for next role" });
    }
    await command("claude", join(directory, "deleted-run", "handoff.json"), { hook_event_name: "Stop" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
