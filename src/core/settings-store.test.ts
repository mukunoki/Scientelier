import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSettingsStore } from "./settings-store";
import type { ReportSettings, OrchestrationSettings } from "./types";
import { defaultExecution, defaultNewExecution, validateExecution } from "./execution-policy";

const reports: ReportSettings = { texCommand: "latexmk", texArgs: [], plotCommand: "python3", plotCheckArgs: [], outputDirectory: "/tmp/reports" };
const orchestration: OrchestrationSettings = { warningPercent: 70, drainPercent: 90, agentPolicies: [] };

test("account display bindings persist independently, validate labels and can be undone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-accounts-"));
  try {
    const path = join(directory, "settings.json");
    const store = new JsonSettingsStore(path, reports, orchestration); await store.init();
    await store.setServiceAccount("openai", "personal"); await store.setServiceAccount("openai@remote", "personal");
    await store.updateOrchestration(orchestration);
    const restored = new JsonSettingsStore(path, reports, orchestration); await restored.init();
    assert.deepEqual(restored.getServiceAccounts(), { openai: "personal", "openai@remote": "personal" });
    await assert.rejects(restored.setServiceAccount("openai", "x\nsecret"));
    await assert.rejects(restored.setServiceAccount("openai", "a".repeat(81)));
    await restored.setServiceAccount("openai@remote", "");
    assert.deepEqual(restored.getServiceAccounts(), { openai: "personal" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("execution defaults persist independently of routing and report settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-execution-"));
  try {
    const path = join(directory, "settings.json");
    const store = new JsonSettingsStore(path, reports, orchestration); await store.init();
    assert.deepEqual(store.getExecution(), defaultNewExecution);
    const execution = validateExecution({ ...defaultExecution, scheduling: "throughput", reviewMode: "cross-service", maxParallel: 4 });
    await Promise.all([store.updateExecution(execution), store.updateReports(reports), store.updateOrchestration(orchestration)]);
    await assert.rejects(store.updateExecution({ ...execution, maxParallel: 99 }));
    assert.deepEqual(store.getExecution(), execution);
    const restored = new JsonSettingsStore(path, reports, orchestration); await restored.init();
    assert.deepEqual(restored.getExecution(), execution);
    const copy = restored.getExecution(); copy.maxParallel = 1;
    assert.equal(restored.getExecution().maxParallel, 4);
    await restored.updateExecution({ ...execution, contextTokens: undefined });
    const unset = new JsonSettingsStore(path, reports, orchestration); await unset.init();
    assert.equal(unset.getExecution().contextTokens, undefined, "reload does not restore the default threshold");
    assert.equal(JSON.parse(await readFile(path, "utf8")).execution.contextTokens, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent report and routing settings saves cannot collide or lose updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-store-")), path = join(directory, "settings.json");
  try {
    const store = new JsonSettingsStore(path, reports, orchestration); await store.init();
    await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2
      ? store.updateOrchestration({ ...orchestration, warningPercent: 60 + i })
      : store.updateReports({ ...reports, plotCommand: `plot-${i}` })));
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.reports, store.getReports());
    assert.deepEqual(saved.orchestration, store.getOrchestration());
    assert.equal(saved.reports.plotCommand, "plot-10");
    assert.equal(saved.orchestration.warningPercent, 71);
    assert.equal(saved.reports.remoteExecution, "remote");
    await store.updateReports({ ...reports, remoteExecution: "remote" });
    const restored = new JsonSettingsStore(path, reports, orchestration); await restored.init();
    assert.equal(restored.getReports().remoteExecution, "remote");
    await assert.rejects(store.updateReports({ ...reports, remoteExecution: "invalid" as "local" }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("legacy local report settings migrate to the task workspace without changing tools or routing",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"report-location-"));const path=join(directory,"settings.json");
  try{
    await writeFile(path,JSON.stringify({version:3,reports:{...reports,remoteExecution:"local"},orchestration}));
    const store=new JsonSettingsStore(path,reports,orchestration);await store.init();
    assert.deepEqual(store.getReports(),{...reports,remoteExecution:"remote"});
    assert.deepEqual(store.getOrchestration(),orchestration);
    assert.equal(JSON.parse(await readFile(path,"utf8")).reports.remoteExecution,"remote");
    assert.equal((await store.updateReports({...reports,remoteExecution:"local"})).remoteExecution,"remote","old UI cannot restore local compilation for remote tasks");
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("non-finite routing thresholds are rejected without changing settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-validation-"));
  try {
    const store = new JsonSettingsStore(join(directory, "settings.json"), reports, orchestration); await store.init();
    for (const value of [NaN, Infinity, -Infinity]) {
      await assert.rejects(store.updateOrchestration({ ...orchestration, warningPercent: value }));
      await assert.rejects(store.updateOrchestration({ ...orchestration, drainPercent: value }));
    }
    assert.deepEqual(store.getOrchestration(), orchestration);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
