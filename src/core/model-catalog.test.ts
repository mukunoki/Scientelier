import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readCodexModels, parseAntigravityModels, withModelDefaults, CLAUDE_MODEL_ALIASES } from "./model-catalog";
import { buildInvocation, AGENT_PROFILES } from "./adapters";
import { JsonSettingsStore } from "./settings-store";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestrationSettings } from "./types";

test("Antigravity catalog parses tab/space rows but not progress, and deduplicates IDs", () => {
  assert.deepEqual(parseAntigravityModels("Fetching available models...\n\x1b[32mgemini-test-high\tGemini Test (High)\x1b[0m\nclaude-test   Claude Test\ngemini-test-high\tGemini Test (High)\n"), [
    { id: "gemini-test-high", label: "Gemini Test (High)" }, { id: "claude-test", label: "Claude Test" }
  ]);
  assert.ok(CLAUDE_MODEL_ALIASES.some(m => m.id === "opus"));
});

const fixture = (mode: string) => (_command: string, args: string[], cwd: string) => {
  assert.deepEqual(args, ["app-server", "--stdio"]);
  return spawn(process.execPath, ["-e", `
    const mode = ${JSON.stringify(mode)}; let initialized = false;
    const send = (id,result,error) => process.stdout.write(JSON.stringify({id,result,error})+'\\n');
    require('readline').createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize') send(m.id,{});
      else if(m.method==='initialized') initialized=true;
      else if(m.method==='model/list' && initialized) {
        if(mode==='timeout') return;
        if(mode==='error') return send(m.id,null,{message:'secret OAuth URL'});
        send(m.id,{ data:m.params.cursor ? [{model:'second',displayName:'Second'}] : [{model:'first',displayName:'First'},{model:'private',hidden:true}], nextCursor:mode==='loop' ? 'page2' : m.params.cursor ? null : 'page2' });
      } else process.exit(9); // No usage endpoint or inference is permitted.
    });
  `], { cwd, stdio: ["pipe", "pipe", "pipe"] });
};
test("Codex catalogs initialize, paginate, hide hidden models independently of usage", async () => {
  assert.deepEqual(await readCodexModels("fixture", process.cwd(), 3000, fixture("ok")), [{ id: "first", label: "First" }, { id: "second", label: "Second" }]);
  for (const mode of ["timeout", "error", "loop"]) await assert.rejects(readCodexModels("fixture", process.cwd(), 500, fixture(mode)), error => /モデル一覧/.test(String(error)) && !String(error).includes("secret"));
});

test("model defaults persist; Gemini is retired without transferring its model or credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ah-model-test-"));
  const settings: OrchestrationSettings = { warningPercent: 70, drainPercent: 85, agentPolicies: AGENT_PROFILES.map(p => ({ agentId: p.id, enabled: true, providerKey: p.id, providerLabel: p.label, authMode: "subscription", priority: 70 })) };
  const reports = { texCommand: "latexmk", texArgs: [], plotCommand: "python3", plotCheckArgs: [], outputDirectory: directory };
  try {
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({ version: 3, orchestration: { ...settings, agentPolicies: [...settings.agentPolicies, { agentId: "gemini", enabled: true, defaultModel: "old-model" }] } }));
    const store = new JsonSettingsStore(path, reports, settings); await store.init();
    assert.ok(!store.getOrchestration().agentPolicies.some(p => p.agentId === "gemini"));
    const next = withModelDefaults(store.getOrchestration(), { codex: " gpt-fixture ", claude: "opus", antigravity: "gemini-fixture" });
    await store.updateOrchestration(next);
    const restored = new JsonSettingsStore(path, reports, settings); await restored.init();
    assert.equal(restored.getOrchestration().agentPolicies.find(p => p.agentId === "codex")?.defaultModel, "gpt-fixture");
    assert.equal(withModelDefaults(next, { codex: "" }).agentPolicies.find(p => p.agentId === "codex")?.defaultModel, undefined);
    assert.throws(() => withModelDefaults(next, { gemini: "old" }));
    assert.throws(() => withModelDefaults(next, { codex: "bad\nmodel" }));
    const switched = withModelDefaults(next, { claude: "sonnet" }, { codex: false, opencode: true });
    assert.equal(switched.agentPolicies.find(p => p.agentId === "codex")?.enabled, false);
    assert.equal(switched.agentPolicies.find(p => p.agentId === "claude")?.defaultModel, "sonnet");
    assert.equal(next.agentPolicies.find(p => p.agentId === "codex")?.enabled, true);
    assert.equal(switched.agentPolicies.find(p => p.agentId === "codex")?.providerKey, next.agentPolicies.find(p => p.agentId === "codex")?.providerKey);
    assert.throws(() => withModelDefaults(next, {}, { codex: "false" }));
    assert.throws(() => withModelDefaults(next, {}, { gemini: true }));
    for (const id of ["codex", "claude", "antigravity"] as const) {
      const profile = AGENT_PROFILES.find(p => p.id === id)!;
      const invocation = buildInvocation({ ...profile, installed: true, executable: `/test/${profile.command}` }, { cwd: directory, mode: "write", prompt: "fixture", model: "selected-model" });
      assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "selected-model");
    }
    assert.throws(() => buildInvocation({ id: "gemini", label: "Gemini", command: "gemini", installed: true, executable: "/test/gemini" }, { cwd: directory, mode: "read", prompt: "fixture" }), /廃止/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
