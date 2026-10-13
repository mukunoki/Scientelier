import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import test from "node:test";

// 実アプリを起動せず、公開APIとイベント解除の契約を検証する。
async function loadPreload() {
  const events = new EventEmitter();
  const calls: unknown[][] = [];
  let api: Record<string, (...args: any[]) => any> = {};
  runInNewContext(await readFile("dist/preload.js", "utf8"), {
    exports: {},
    require: (name: string) => {
      assert.equal(name, "electron", "preload must not gain additional runtime dependencies");
      return {
        contextBridge: { exposeInMainWorld: (name: string, value: typeof api) => { assert.equal(name, "harness"); api = value; } },
        ipcRenderer: Object.assign(events, { invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(); } })
      };
    }
  });
  return { api, events, calls };
}

test("preload subscriptions strip Electron events and unsubscribe only their own listener", async () => {
  const { api, events } = await loadPreload();
  const subscriptions = Object.keys(api).filter(key => key.startsWith("on"));
  assert.equal(subscriptions.length, 12);
  for (const name of subscriptions) {
    const first: unknown[][] = [], second: unknown[][] = [];
    const dispose = api[name]((...args: unknown[]) => first.push(args));
    const disposeOther = api[name]((...args: unknown[]) => second.push(args));
    const [channel] = events.eventNames();
    assert.ok(channel);
    const payload = { fixture: name };
    events.emit(channel, { sender: "must not cross the bridge" }, payload);
    assert.deepEqual(first, [[payload]]);
    dispose(); dispose();
    events.emit(channel, {}, payload);
    assert.equal(first.length, 1); assert.equal(second.length, 2);
    disposeOther(); assert.equal(events.eventNames().length, 0);
  }
});

test("preload has one OpenCode configuration route and no retired Gemini login API", async () => {
  const { api, calls } = await loadPreload();
  assert.ok(!Object.keys(api).some(key => key.startsWith("geminiLogin")));
  assert.equal(api.configureGlm, undefined); assert.equal(api.glmModels, undefined);
  await api.configureOpenCode("zai", "zai-coding-plan/fixture");
  await api.openCodeModels("ollama-app");
  await api.saveModelDefaults({ codex: "fixture" }, { claude: false });
  assert.deepEqual(calls, [
    ["opencode:configure", "zai", "zai-coding-plan/fixture"],
    ["opencode:models", "ollama-app"],
    ["models:save", { codex: "fixture" }, { claude: false }]
  ]);
});

test("remote IP reflection sends explicit stale-profile and same-machine consent without a second IPC route", async () => {
  const {api,calls}=await loadPreload();
  const system={id:"cluster",host:"192.0.2.2"};
  const consent={expectedHost:"192.0.2.1",confirmed:true};
  await api.remoteSave(system,false,consent);
  assert.deepEqual(calls,[["remote:save",system,false,consent]]);
});
