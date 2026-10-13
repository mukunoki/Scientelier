import test from "node:test";
import assert from "node:assert/strict";
import { buildInvocation, buildRecoveryShell } from "./adapters";
import type { AgentStatus } from "./types";

const request = {
  prompt: "Inspect the project",
  cwd: "/tmp",
  mode: "read" as const
};

test("manual recovery preserves OpenCode subscription without task hooks or automatic permission bypass",()=>{
  const result=buildRecoveryShell({id:"opencode",label:"OpenCode",command:"opencode",executable:"/opt/bin/opencode",installed:true},"/tmp","ollama/deepseek-v4.1-flash:cloud","ollama-app");
  assert.equal(result.shell.command,"/usr/bin/env");
  assert.ok(result.shell.args.includes("HISTFILE=/dev/null"));
  const config=JSON.parse(result.shell.args[0].slice("OPENCODE_CONFIG_CONTENT=".length));
  assert.deepEqual(config.enabled_providers,["ollama"]);assert.equal(config.model,"ollama/deepseek-v4.1-flash:cloud");
  assert.equal(config.mcp,undefined);assert.equal(config.agent,undefined);assert.equal(config.plugin,undefined);
  assert.match(result.command,/--model/);assert.doesNotMatch(result.command,/auto|resume|prompt|permission/);
});

test("codex invocation opens the interactive CLI and remains read-only", () => {
  const status: AgentStatus = {
    id: "codex",
    label: "Codex",
    command: "codex",
    installed: true,
    executable: "/usr/local/bin/codex"
  };
  const invocation = buildInvocation(status, request);
  assert.deepEqual(invocation.args.slice(0, 4), ["--ask-for-approval", "never", "--sandbox", "read-only"]);
  assert.ok(!invocation.args.includes("exec") && !invocation.args.includes("--json"));
  assert.equal(invocation.args.at(-1), request.prompt);
  assert.ok(invocation.args.includes('projects."/tmp".trust_level="trusted"'));
});

test("Codex trust is scoped to the exact launch directory and safely quoted, also on fork", () => {
  const status: AgentStatus = {id:"codex",label:"Codex",command:"codex",installed:true,executable:"/bin/codex"};
  const cwd='/work/my "project".v2';
  const invocation=buildInvocation(status,{...request,cwd,mode:"write",continueSession:"12345678-1234-1234-1234-123456789abc"});
  const settings=invocation.args.filter(arg=>arg.includes("trust_level"));
  assert.deepEqual(settings,[`projects.${JSON.stringify(cwd)}.trust_level="trusted"`]);
  assert.equal(invocation.cwd,cwd);
  assert.ok(invocation.args.includes("workspace-write"));
  assert.doesNotMatch(buildRecoveryShell(status,cwd).command,/trust_level/);
});

test("Codex launch-local trust does not add parent/report roots or weaken the selected sandbox", () => {
  const status: AgentStatus = {id:"codex",label:"Codex",command:"codex",installed:true,executable:"/bin/codex"};
  for (const cwd of ["/Users/example/my project", "/home/scientist/cluster-work/subproject"])
    for (const mode of ["read", "write"] as const)
      for (const codexPermissions of ["sandbox", "full-access"] as const) {
        const invocation = buildInvocation(status, { ...request, cwd, mode, codexPermissions, additionalDirectories: ["/separate/report"] });
        assert.deepEqual(invocation.args.filter(arg => arg.includes("trust_level")), [`projects.${JSON.stringify(cwd)}.trust_level="trusted"`]);
        assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], codexPermissions === "full-access" ? "danger-full-access" : mode === "write" ? "workspace-write" : "read-only");
        assert.doesNotMatch(invocation.args.join(" "), /dangerously-bypass/);
      }
});

test("writer invocation enables workspace writes and model selection", () => {
  const status: AgentStatus = {
    id: "codex",
    label: "Codex",
    command: "codex",
    installed: true,
    executable: "/usr/local/bin/codex"
  };
  const invocation = buildInvocation(status, { ...request, mode: "write", model: "example-model" });
  assert.deepEqual(invocation.args.slice(0, 4), ["--ask-for-approval", "never", "--sandbox", "workspace-write"]);
  assert.ok(invocation.args.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(!invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--model"), invocation.args.indexOf("--model") + 2), ["--model", "example-model"]);
});

test("Claude opens its normal interactive interface", () => {
  const status: AgentStatus = {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    installed: true,
    executable: "/usr/local/bin/claude"
  };
  const invocation = buildInvocation(status, request);
  assert.deepEqual(invocation.args, [request.prompt, "--permission-mode", "bypassPermissions"]);
  for (const mode of ["read", "write"] as const) {
    const args = buildInvocation(status, { ...request, mode }).args;
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.ok(!args.includes("--print") && !args.includes("--output-format"));
  }
});

test("explicit Full access uses the documented mode for every Codex role, leaving other CLIs unchanged", () => {
  const codex: AgentStatus = { id: "codex", label: "Codex", command: "codex", installed: true, executable: "/bin/codex" };
  for (const mode of ["read", "write"] as const) {
    const args = buildInvocation(codex, { ...request, mode, codexPermissions: "full-access" }).args;
    assert.deepEqual(args.slice(0, 4), ["--ask-for-approval", "never", "--sandbox", "danger-full-access"]);
    assert.ok(!args.includes("sandbox_workspace_write.network_access=true"));
    assert.ok(!args.includes("workspace-write") && !args.includes("read-only"));
    assert.ok(!buildInvocation(codex, { ...request, mode }).args.includes("danger-full-access"));
  }
  const claude: AgentStatus = { id: "claude", label: "Claude", command: "claude", installed: true, executable: "/bin/claude" };
  assert.deepEqual(buildInvocation(claude, { ...request, codexPermissions: "full-access" }), buildInvocation(claude, request));
});

test("Antigravity and OpenCode use interactive prompt options", () => {
  for (const id of ["antigravity", "opencode"] as const) {
    const invocation = buildInvocation({ id, label: id, command: id, installed: true, executable: `/bin/${id}` }, request);
    assert.equal(invocation.args[id === "antigravity" ? 0 : 2], id === "antigravity" ? "--prompt-interactive" : "--prompt");
    for (const flag of ["run", "-p", "--format", "--output-format"]) assert.ok(!invocation.args.includes(flag));
  }
});

test("Antigravity passes a bounded file-reading instruction, not the full task history", () => {
  const path = "/tmp/task 'quoted'/instructions.txt";
  const invocation = buildInvocation({ id:"antigravity", label:"Antigravity", command:"agy", installed:true, executable:"/bin/agy" }, {
    ...request, prompt:"長いレビュー結果".repeat(100000), instructionsPath:path
  });
  assert.ok(Buffer.byteLength(invocation.args[1]) < 2000);
  assert.ok(invocation.args[1].includes(JSON.stringify(path)));
  assert.ok(!invocation.args.join(" ").includes("長いレビュー結果"));
  assert.equal(invocation.args[0],"--prompt-interactive");
});

test("native completion uses CLI hooks and scopes report access without changing user configuration", () => {
  const command = ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", "/tmp/a b/node", "/tmp/hook's.js", "id"];
  for (const id of ["codex", "claude"] as const) {
    const invocation = buildInvocation({ id, label: id, command: id, installed: true, executable: `/bin/${id}` }, {
      ...request, mode: "write", completionCommand: command, statusCommand: command, additionalDirectories: ["/tmp/Report with spaces"]
    });
    assert.equal(invocation.cwd, request.cwd);
    assert.ok(invocation.args.includes("/tmp/Report with spaces"));
    if (id === "codex") assert.ok(invocation.args.includes(`notify=${JSON.stringify(command)}`));
    else {
      assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "bypassPermissions");
      const settings = JSON.parse(invocation.args[invocation.args.indexOf("--settings") + 1]);
      assert.ok(settings.hooks.Stop[0].hooks[0].command.includes("'/tmp/a b/node'"));
      assert.ok(settings.hooks.StopFailure);
      assert.equal(settings.statusLine.type, "command");
      assert.ok(settings.statusLine.command.includes("'/tmp/a b/node'"));
      assert.ok(!invocation.args.includes("--dangerously-skip-permissions"));
    }
  }
});
