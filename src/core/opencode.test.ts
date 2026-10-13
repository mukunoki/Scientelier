import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildInvocation } from "./adapters";
import { parseOpenCodeLoginStatus, ZAI_CODING_URL,
  openCodePolicy, openCodeTerminal, validateOpenCodePlan, validateOpenCodeModel, parseOpenCodeModels, readOpenCodeLoginStatus, readOllamaAppModels, DEEPSEEK_OLLAMA_MODEL } from "./opencode";
import { ClaudeLoginSession } from "./claude-login";
import { JsonSettingsStore } from "./settings-store";
import { completionFromHook, completionMarker } from "./completion-hook";
import type { AgentPolicy } from "./types";

const policy: AgentPolicy = { agentId: "opencode", providerKey: "old", providerLabel: "old", authMode: "unknown", enabled: false, priority: 60 };
const model = "zai-coding-plan/glm-5.3";

test("Ollama's user-operated OpenCode terminal preserves provider/model without reauthentication",()=>{
  const v=openCodeTerminal("/test/open code","/test/home","ollama-app",DEEPSEEK_OLLAMA_MODEL);
  assert.equal(v.command,"/usr/bin/env");assert.equal(v.cwd,"/test/home");
  assert.deepEqual(v.args.slice(1),["/test/open code"]);
  const config=JSON.parse(v.args[0].slice("OPENCODE_CONFIG_CONTENT=".length));
  assert.deepEqual(config.enabled_providers,["ollama"]);assert.equal(config.model,DEEPSEEK_OLLAMA_MODEL);
  assert.doesNotMatch(JSON.stringify(v),/auth|signin|apiKey|--auto|--prompt/);
  let args:string[]=[];
  const child={cols:80,rows:24,write:()=>{},resize:()=>{},kill:()=>{},onData:()=>{},onExit:()=>{}};
  const s=new ClaudeLoginSession((_command,a)=>{args=a;return child;},"opencode");
  const id=s.startCommand(v.command,v.args,v.cwd,"cli:ollama-app");
  assert.deepEqual(args,v.args);
  assert.equal(s.startCommand(v.command,v.args,v.cwd,"cli:ollama-app"),id);
  assert.throws(()=>s.start("/test/opencode","/test/home","ollama-cloud"),/別の接続先/);
  s.close(id);
});

test("Ollama status only probes the local runtime, never cloud credentials or quota", async () => {
  let calls = 0;
  const success = await readOpenCodeLoginStatus("/must-not-spawn", "/test", "ollama-app", async (url, options) => {
    calls++; assert.equal(url, "http://127.0.0.1:11434/api/version");
    assert.equal(options?.redirect, "error"); assert.equal(options?.headers, undefined);
    return Response.json({ version: "test" });
  });
  assert.equal(calls, 1); assert.equal(success.runtimeReady, true);
  assert.equal(success.loggedIn, undefined); assert.equal(success.checkSupported, false);
  assert.match(success.detail, /Web連携は任意/);
  for (const request of [async () => new Response(null, { status: 503 }), async () => { throw new Error("private server error"); }]) {
    const failure = await readOpenCodeLoginStatus("/must-not-spawn", "/test", "ollama-app", request);
    assert.equal(failure.runtimeReady, false); assert.equal(failure.loggedIn, undefined);
    assert.doesNotMatch(failure.detail, /private server error/);
  }
});

test("applying OpenCode providers and models preserves the service switch", () => {
  for (const enabled of [false, true]) {
    const original = { ...policy, enabled };
    let selected = original;
    for (const [plan, model] of [["zai", "zai-coding-plan/glm-5.3"], ["ollama", "ollama-cloud/gpt-oss:120b"], ["ollama-app", DEEPSEEK_OLLAMA_MODEL]] as const) {
      selected = openCodePolicy(selected, plan, model);
      assert.equal(selected.enabled, enabled);
      assert.equal(selected.codingPlan, plan);
      assert.equal(selected.defaultModel, model);
    }
    assert.deepEqual(original, { ...policy, enabled }, "source policy must not be mutated");
  }
});

test("GLM uses only the Coding Plan provider, including secondary models and MCP", () => {
  const invocation = buildInvocation({ id: "opencode", label: "OpenCode", command: "opencode", executable: "/test/open code", installed: true }, {
    prompt: "private instructions", launchPrompt: "normal terminal prompt", cwd: "/test", mode: "read", model, codingPlan: "zai",
    resultCommand: ["/test/node", "/test/channel.js"], openCodePluginPath: "/test/a b/agent-harness.mjs"
  });
  assert.equal(invocation.command, "/usr/bin/env");
  assert.deepEqual(invocation.args.slice(1), ["/test/open code", "--prompt", "normal terminal prompt", "--auto", "--agent", "agent_harness", "--model", model]);
  const config = JSON.parse(invocation.args[0].slice("OPENCODE_CONFIG_CONTENT=".length));
  assert.deepEqual(config.enabled_providers, ["zai-coding-plan"]);
  assert.equal(config.provider["zai-coding-plan"].options.baseURL, ZAI_CODING_URL);
  assert.equal(config.small_model, model);
  assert.equal(config.agent.agent_harness.permission.edit, "deny");
  assert.equal(config.agent.agent_harness.permission.task, "deny");
  assert.deepEqual(config.mcp.agent_harness.command, ["/test/node", "/test/channel.js"]);
  assert.deepEqual(config.plugin, ["file:///test/a%20b/agent-harness.mjs"]);
  assert.doesNotMatch(JSON.stringify(config), /apiKey|private instructions/);
  for (const invalid of [undefined, "zai/glm-5.3", "openai/glm-5.3", "zai-coding-plan/glm-5.3\nsecret", "zai-coding-plan/"]) assert.throws(() => validateOpenCodeModel("zai", invalid));
});

test("OpenCode metadata never exposes credentials or treats regular Z.AI as Coding Plan", () => {
  assert.equal(parseOpenCodeLoginStatus("│ ● Z.AI api\n└ 1 credentials").loggedIn, false);
  assert.equal(parseOpenCodeLoginStatus("│ ● \x1b[32mZ.AI Coding Plan\x1b[0m api\n└ 1 credentials").loggedIn, true);
  assert.equal(parseOpenCodeLoginStatus("└ 0 credentials").loggedIn, false);
  const unknown = parseOpenCodeLoginStatus("PRIVATE unknown");
  assert.equal(unknown.loggedIn, undefined); assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE/);
  assert.deepEqual(parseOpenCodeModels(`warning PRIVATE\n${model}\nzai/glm-5.3\n${model}\nzai-coding-plan/glm-4.7`, "zai"), [model, "zai-coding-plan/glm-4.7"]);
});

test("Ollama Cloud is independent of local Ollama, GLM and model vendor services", () => {
  const selected = "ollama-cloud/gpt-oss:120b";
  const invocation = buildInvocation({ id: "opencode", label: "OpenCode", command: "opencode", executable: "/test/opencode", installed: true }, {
    prompt: "Read instructions", cwd: "/test", mode: "write", model: selected, codingPlan: "ollama"
  });
  const config = JSON.parse(invocation.args[0].slice("OPENCODE_CONFIG_CONTENT=".length));
  assert.deepEqual(config.enabled_providers, ["ollama-cloud"]);
  assert.equal(config.provider["ollama-cloud"].options.baseURL, "https://ollama.com/v1");
  assert.equal(config.model, selected); assert.equal(config.small_model, selected);
  assert.equal(config.agent.agent_harness.permission.edit, "allow");
  assert.doesNotMatch(JSON.stringify(config), /localhost|11434|apiKey|zai-coding-plan/);
  assert.equal(parseOpenCodeLoginStatus("│ ● Ollama Cloud api\n└ 1 credentials", "ollama").loggedIn, true);
  assert.equal(parseOpenCodeLoginStatus("│ ● Ollama api\n└ 1 credentials", "ollama").loggedIn, false);
  assert.equal(parseOpenCodeLoginStatus("│ ● Z.AI Coding Plan api\n└ 1 credentials", "ollama").loggedIn, false);
  assert.equal(parseOpenCodeLoginStatus("│ ● Ollama Cloud api\n└ 1 credentials", "zai").loggedIn, false);
  assert.equal(parseOpenCodeLoginStatus("PRIVATE", "ollama").loggedIn, undefined);
  assert.deepEqual(parseOpenCodeModels(`${selected}\n${selected}\nzai-coding-plan/glm-5.3\nollama/local\nPRIVATE`, "ollama"), [selected]);
  for (const invalid of ["ollama/local", "zai-coding-plan/glm-5.3", "ollama-cloud/", "ollama-cloud/model\nPRIVATE", "ollama-cloud/m;command"]) assert.throws(() => validateOpenCodeModel("ollama", invalid));
  for (const invalid of [undefined, "other", "__proto__"]) assert.throws(() => validateOpenCodePlan(invalid));
});

test("Ollama app uses the existing local proxy and pins native DeepSeek with MCP intact", () => {
  const invocation = buildInvocation({ id: "opencode", label: "OpenCode", command: "opencode", executable: "/test/opencode", installed: true }, {
    prompt: "Read instructions", cwd: "/test", mode: "write", model: DEEPSEEK_OLLAMA_MODEL, codingPlan: "ollama-app",
    resultCommand: ["/test/node", "/test/channel.js"]
  });
  const config = JSON.parse(invocation.args[0].slice("OPENCODE_CONFIG_CONTENT=".length));
  assert.deepEqual(config.enabled_providers, ["ollama"]);
  assert.equal(config.model, DEEPSEEK_OLLAMA_MODEL); assert.equal(config.small_model, DEEPSEEK_OLLAMA_MODEL);
  assert.equal(config.provider.ollama.npm, "@ai-sdk/openai-compatible");
  assert.equal(config.provider.ollama.options.baseURL, "http://127.0.0.1:11434/v1");
  assert.equal(config.provider.ollama.models["deepseek-v4.1-flash:cloud"].limit.context, 1048576);
  assert.deepEqual(config.mcp.agent_harness.command, ["/test/node", "/test/channel.js"]);
  assert.doesNotMatch(JSON.stringify(config), /apiKey|ollama\.com|ollama-cloud\//);
  assert.equal(parseOpenCodeLoginStatus("│ ● Ollama Cloud api\n└ 1 credentials", "ollama-app").loggedIn, undefined);
  for (const invalid of ["ollama-cloud/deepseek-v4.1-flash", "ollama/deepseek-v4.1-flash", "ollama/model:cloud\nPRIVATE", "ollama/model;command:cloud"]) assert.throws(() => validateOpenCodeModel("ollama-app", invalid));
  const direct = openCodePolicy(policy, "ollama", "ollama-cloud/gpt-oss:120b");
  const app = openCodePolicy(direct, "ollama-app", DEEPSEEK_OLLAMA_MODEL);
  assert.equal(app.providerKey, direct.providerKey, "Same cloud service must not create extra quota");
  assert.deepEqual(app.openCodeModels, { ollama: direct.defaultModel, "ollama-app": DEEPSEEK_OLLAMA_MODEL });
  assert.deepEqual(openCodePolicy(app, "ollama", direct.defaultModel).openCodeModels, app.openCodeModels);
});

test("Ollama model discovery includes saved cloud models without installed weights or credential access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-ollama-app-models-"));
  try {
    await mkdir(join(directory, ".ollama"));
    await mkdir(join(directory, ".local", "state", "opencode"), { recursive: true });
    await writeFile(join(directory, ".ollama", "config.json"), JSON.stringify({ secret: "PRIVATE", integrations: { opencode: { models: ["deepseek-v4.1-flash:cloud", "local:7b", "bad\nollama/injected:cloud", null] } } }));
    await writeFile(join(directory, ".local", "state", "opencode", "model.json"), JSON.stringify({ recent: [
      { providerID: "ollama", modelID: "deepseek-v4.1-flash:cloud" }, { providerID: "ollama-cloud", modelID: "other:cloud" }, { providerID: "ollama", modelID: "gpt-oss:120b-cloud" }
    ] }));
    assert.deepEqual(await readOllamaAppModels(directory, false), ["ollama/gpt-oss:120b-cloud", DEEPSEEK_OLLAMA_MODEL]);
    await writeFile(join(directory, ".ollama", "config.json"), "invalid json");
    await writeFile(join(directory, ".local", "state", "opencode", "model.json"), "null");
    assert.deepEqual(await readOllamaAppModels(directory, false), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("OpenCode authentication pins Ollama Cloud and cannot change an active login's provider", () => {
  const session = new ClaudeLoginSession((command, args) => {
    assert.equal(command, "/test/opencode"); assert.deepEqual(args, ["auth", "login", "--provider", "ollama-cloud"]);
    return { cols: 100, rows: 24, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
  }, "opencode");
  const id = session.start("/test/opencode", "/tmp", "ollama-cloud");
  assert.equal(session.start("/test/opencode", "/tmp", "ollama-cloud"), id);
  assert.throws(() => session.start("/test/opencode", "/tmp", "zai-coding-plan"), /別の接続先/);
  assert.throws(() => session.start("/test/opencode", "/tmp", "invalid" as "ollama-cloud"), /認証先/);
  session.close(id);
});

test("switching OpenCode plans retains both model selections and persists separate resource identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-ollama-settings-"));
  try {
    const reports = { texCommand: "latexmk", texArgs: [], plotCommand: "python3", plotCheckArgs: [], outputDirectory: "/tmp" };
    const settings = { warningPercent: 70, drainPercent: 90, agentPolicies: [policy] };
    const path = join(directory, "settings.json");
    const store = new JsonSettingsStore(path, reports, settings); await store.init();
    const glm = openCodePolicy(policy, "zai", model), ollama = openCodePolicy(glm, "ollama", "ollama-cloud/gpt-oss:120b");
    assert.equal(ollama.providerKey, "ollama-cloud"); assert.equal(ollama.providerLabel, "Ollama Cloud");
    assert.equal(ollama.authMode, "subscription");
    assert.deepEqual(ollama.openCodeModels, { zai: model, ollama: "ollama-cloud/gpt-oss:120b" });
    await store.updateOrchestration({ ...settings, agentPolicies: [ollama] });
    const restored = new JsonSettingsStore(path, reports, settings); await restored.init();
    assert.deepEqual(restored.getOrchestration().agentPolicies[0], ollama);
    const reverted = openCodePolicy(ollama, "zai", model);
    assert.deepEqual(reverted.openCodeModels, ollama.openCodeModels);
    assert.equal(reverted.providerKey, "zai-coding-plan");
    const invalid = { ...ollama, defaultModel: "zai-coding-plan/glm-5.3" };
    await assert.rejects(store.updateOrchestration({ ...settings, agentPolicies: [invalid] }));
    assert.deepEqual(store.getOrchestration().agentPolicies[0], { ...ollama, softTokenBudget: undefined });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("OpenCode login selects the official Coding Plan provider without taking credentials", () => {
  let closed = false;
  const session = new ClaudeLoginSession((command, args) => {
    assert.equal(command, "/test/opencode"); assert.deepEqual(args, ["auth", "login", "--provider", "zai-coding-plan"]);
    return { cols: 100, rows: 24, write() {}, resize() {}, kill() { closed = true; }, onData() {}, onExit() {} };
  }, "opencode");
  const id = session.start("/test/opencode", "/tmp"); session.close(id); assert.equal(closed, true);
});

test("Coding Plan isolation survives settings save and reload without changing other providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-glm-settings-"));
  try {
    const reports = { texCommand: "latexmk", texArgs: [], plotCommand: "python3", plotCheckArgs: [], outputDirectory: "/tmp" };
    const settings = { warningPercent: 70, drainPercent: 90, agentPolicies: [policy] };
    const store = new JsonSettingsStore(join(directory, "settings.json"), reports, settings); await store.init();
    await store.updateOrchestration({ ...settings, agentPolicies: [openCodePolicy(policy, "zai", model)] });
    const saved = store.getOrchestration(); saved.agentPolicies[0].enabled = false; saved.agentPolicies[0].providerKey = "wrong";
    await store.updateOrchestration(saved);
    const restored = new JsonSettingsStore(join(directory, "settings.json"), reports, settings); await restored.init();
    assert.deepEqual(restored.getOrchestration().agentPolicies[0], { ...openCodePolicy(policy, "zai", model), enabled: false });
    const invalid = restored.getOrchestration(); invalid.agentPolicies[0].defaultModel = "zai/glm-5.3";
    await assert.rejects(restored.updateOrchestration(invalid));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("OpenCode final hook accepts only final markers and surfaces rate limits", () => {
  assert.equal(completionFromHook("opencode", { type: "session.idle", response: `Done\n${completionMarker("token")}` }, "token")?.status, "completed");
  assert.equal(completionFromHook("opencode", { type: "session.idle", response: "working..." }, "token"), undefined);
  assert.equal(completionFromHook("opencode", { type: "session.error", error: "rate_limit" }, "token")?.status, "rate-limited");
});

test("OpenCode plugin ignores old, unrelated, inner and unfinished sessions then notifies once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-glm-plugin-"));
  try {
    const path = join(directory, "agent-harness.mjs"), output = join(directory, "handoff.json");
    await copyFile(resolve("assets/opencode/agent-harness.mjs"), path);
    await writeFile(join(directory, "completion-command.json"), JSON.stringify({ token: "run-token", startedAt: 100,
      command: [process.execPath, resolve("dist/core/completion-hook.js"), "opencode", output, "run-token"] }));
    await writeFile(join(directory,"metrics-config.json"),JSON.stringify({token:"run-token",startedAt:100}));
    let session: any = { time: { created: 101 } };
    const messages: any[] = [{ info: { role: "user" }, parts: [{ type: "text", text: "run-token" }] },
      { info: { role: "assistant", providerID:"ollama",modelID:"deepseek-test",time: { created: 102, completed: 103 }, finish: "stop" }, parts: [{ type: "text", text: `Done\n${completionMarker("run-token")}` }] }];
    const plugin = await import(pathToFileURL(path).href);
    const hooks = await plugin.default({ client: { session: { get: async () => ({ data: session }), messages: async () => ({ data: messages }) } } });
    const event = { type: "session.idle", properties: { sessionID: "ses_fixture" } };
    for (const invalid of [{ parentID: "ses_parent", time: { created: 101 } }, { time: { created: 99 } }]) {
      session = invalid; await hooks.event({ event }); await assert.rejects(readFile(output));
    }
    session = { time: { created: 101 } };
    messages[0].parts[0].text = "other-run"; await hooks.event({ event }); await assert.rejects(readFile(output));
    messages[0].parts[0].text = "run-token"; messages[1].info.finish = "tool-calls";
    await hooks.event({ event }); await assert.rejects(readFile(output));
    messages[1].info.finish = "stop"; await hooks.event({ event });
    assert.equal(JSON.parse(await readFile(output, "utf8")).status, "completed");
    const identity=JSON.parse(await readFile(join(directory,"runtime-identity.json"),"utf8"));
    assert.equal(identity.token,"run-token");assert.deepEqual(identity.identity.models,["ollama/deepseek-test"]);
    await writeFile(output, "already-delivered"); await hooks.event({ event }); assert.equal(await readFile(output, "utf8"), "already-delivered");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("OpenCode native 401/503 errors distinguish recoverable service failure from account quota",async()=>{
  for(const [code,kind] of [[401,"authentication"],[503,"capacity"]] as const) {
    const directory=await mkdtemp(join(tmpdir(),"harness-native-failure-"));
    try {
      const path=join(directory,"agent-harness.mjs"),output=join(directory,"handoff.json");
      await copyFile(resolve("assets/opencode/agent-harness.mjs"),path);
      await writeFile(join(directory,"completion-command.json"),JSON.stringify({token:"run-token",startedAt:100,
        command:[process.execPath,resolve("dist/core/completion-hook.js"),"opencode",output,"run-token"]}));
      const plugin=await import(pathToFileURL(path).href);
      const hooks=await plugin.default({client:{session:{get:async()=>({data:{time:{created:101}}}),
        messages:async()=>({data:[{info:{role:"user"},parts:[{type:"text",text:"run-token"}]}]})}}});
      await hooks.event({event:{type:"session.error",properties:{sessionID:"ses_current",error:{data:{statusCode:code,message:"Native service failure"}}}}});
      const handoff=JSON.parse(await readFile(output,"utf8"));assert.equal(handoff.status,"blocked");assert.equal(handoff.failure.kind,kind);
    } finally {await rm(directory,{recursive:true,force:true});}
  }
});

test("OpenCode terminal empty/length/error turns notify failure rather than leaving the CLI idle", async () => {
  for (const scenario of ["length-reasoning", "length-marker", "empty-stop", "error-marker", "missing-receipt"]) {
    const directory = await mkdtemp(join(tmpdir(), "harness-opencode-terminal-"));
    try {
      const path = join(directory, "agent-harness.mjs"), output = join(directory, "handoff.json");
      await copyFile(resolve("assets/opencode/agent-harness.mjs"), path);
      await writeFile(join(directory, "completion-command.json"), JSON.stringify({ token: "run-token", startedAt: 100,
        command: [process.execPath, resolve("dist/core/completion-hook.js"), "opencode", output, "run-token"] }));
      if (scenario !== "missing-receipt") await writeFile(join(directory, "channel-required.json"), JSON.stringify({ token: "run-token" }));
      await writeFile(join(directory, "channel-state.json"), JSON.stringify({ token: "run-token", phase: "instructions-read", at: "now" }));
      const assistant: any = { info: { role: "assistant", time: { created: 102 }, finish: scenario.startsWith("length") ? "length" : "stop",
        ...(scenario === "error-marker" ? { error: { data: { message: "provider failed" } } } : {}) },
        parts: scenario.endsWith("marker") ? [{ type: "text", text: `Done\n${completionMarker("run-token")}` }] : [{ type: "reasoning", text: "private reasoning must never become the handoff" }] };
      const plugin = await import(pathToFileURL(path).href);
      let prompts = 0;
      const hooks = await plugin.default({ client: { session: {
        get: async () => ({ data: { time: { created: 101 } } }),
        messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: "run-token" }] }, assistant] }),
        promptAsync: async () => { prompts++; }
      } } });
      const event = { type: "session.idle", properties: { sessionID: "current" } };
      await hooks.event({ event }); await assert.rejects(readFile(output)); // not completed yet
      assistant.info.time.completed = 103;
      await hooks.event({ event });
      if (scenario === "missing-receipt") {
        await assert.rejects(readFile(output));
        await writeFile(join(directory, "channel-required.json"), JSON.stringify({ token: "run-token" }));
        await hooks.event({ event }); // exit 0 without a handoff must not suppress retries
      }
      const handoff = JSON.parse(await readFile(output, "utf8"));
      assert.equal(handoff.token, "run-token");
      assert.equal(handoff.status, "blocked");
      assert.match(handoff.summary, scenario.startsWith("length") ? /出力上限/ : scenario === "error-marker" ? /provider failed/ : /回答本文/);
      assert.doesNotMatch(handoff.summary, /private reasoning/);
      assert.equal(prompts, 0); // no unbounded model retries or false review repair
      await writeFile(output, "already-delivered");
      await hooks.event({ event }); assert.equal(await readFile(output, "utf8"), "already-delivered");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("received OpenCode review repairs only its missing final marker, twice at most", async () => {
  for (const scenario of ["success", "limit", "rejected", "wrong-token", "no-instructions", "user-input", "abort", "send-error"]) {
    const directory = await mkdtemp(join(tmpdir(), "harness-notification-repair-"));
    try {
      const path = join(directory, "agent-harness.mjs"), output = join(directory, "handoff.json");
      await copyFile(resolve("assets/opencode/agent-harness.mjs"), path);
      for (const [file, value] of Object.entries({
        "completion-command.json": { token: "run-token", startedAt: 100, command: [process.execPath, resolve("dist/core/completion-hook.js"), "opencode", output, "run-token"] },
        "channel-required.json": { token: "run-token" },
        "channel-state.json": { token: "run-token", phase: scenario === "no-instructions" ? "connected" : "instructions-read", at: "now" },
        "review-contract.json": { token: "run-token" },
        "structured-result-goal-evaluation.json": { token: scenario === "wrong-token" ? "other" : "run-token", rejected: scenario === "rejected", structured: '<goal-evaluation>{"nextAction":"repair"}</goal-evaluation>' }
      })) await writeFile(join(directory, file), JSON.stringify(value));
      const messages: any[] = [{ info: { role: "user", time: { created: 101 } }, parts: [{ type: "text", text: "run-token" }] }];
      const assistant = (id: string, text = "Review found defects; repair required") => ({ info: { id, role: "assistant", agent: "agent_harness", providerID: "ollama", modelID: "fixture", time: { created: messages.length + 102, completed: messages.length + 103 }, finish: "stop", ...(scenario === "abort" ? { error: { name: "MessageAbortedError" } } : {}) }, parts: [{ type: "text", text }] });
      messages.push(assistant("first"));
      if (scenario === "user-input") messages.push({ info: { role: "user" }, parts: [{ type: "text", text: "Please wait" }] });
      const prompts: any[] = [];
      const plugin = await import(pathToFileURL(path).href);
      const hooks = await plugin.default({ client: { session: {
        get: async () => ({ data: { time: { created: 101 } } }), messages: async () => ({ data: messages }),
        promptAsync: async (request: any) => {
          if (scenario === "send-error") throw new Error("offline");
          prompts.push(request);
          assert.deepEqual(request.body.model, { providerID: "ollama", modelID: "fixture" });
          assert.equal(request.body.agent, "agent_harness");
          messages.push({ info: { role: "user" }, parts: request.body.parts }); return {};
        }
      } } });
      const event = { type: "session.idle", properties: { sessionID: "current" } };
      await hooks.event({ event });
      if (["success", "limit"].includes(scenario)) {
        assert.equal(prompts.length, 1); await assert.rejects(readFile(output));
        await hooks.event({ event }); // old idle must not become a failure or another prompt
        assert.equal(prompts.length, 1); await assert.rejects(readFile(output));
        if (scenario === "success") {
          messages.push(assistant("fixed", `Review requires repair\n${completionMarker("run-token")}`));
          await hooks.event({ event }); assert.equal(JSON.parse(await readFile(output, "utf8")).status, "completed");
        } else {
          messages.push(assistant("second")); await hooks.event({ event }); assert.equal(prompts.length, 2);
          messages.push(assistant("third")); await hooks.event({ event });
          assert.equal(JSON.parse(await readFile(output, "utf8")).status, "blocked");
          assert.equal(prompts.length, 2);
        }
      } else {
        assert.equal(prompts.length, 0);
        assert.equal(JSON.parse(await readFile(output, "utf8")).status, "blocked");
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
