import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonTaskStore } from "./task-store";
import { resumePatch } from "./recovery";
import { taskCodexPermissions } from "./codex-permissions";

test("new local tasks use Full access while saved legacy, explicit sandbox and remote permissions stay unchanged", async () => {
  const directory=await mkdtemp(join(tmpdir(),"harness-permission-default-"));
  try {
    const file=join(directory,"tasks.json"),store=new JsonTaskStore(file);await store.init();
    const input={title:"Local",prompt:"Inspect",cwd:directory,strategy:"balanced" as const,allowedAgentIds:["codex" as const],modelOverrides:{}};
    const local=await store.create(input);
    assert.equal(local.localCodexPermissions,"full-access");
    assert.equal(taskCodexPermissions(local),"full-access");
    const restricted=await store.create({...input,title:"Restricted"});await store.update(restricted.id,{localCodexPermissions:"sandbox"});
    const legacy=await store.create({...input,title:"Legacy"});
    const remote=await store.create(input,undefined,{id:"r",name:"R",host:"r",cwd:"/work",nodeCommand:"node",pythonCommand:"python3",startup:"",instructions:"",texCommand:"latexmk",codexPermissions:"sandbox"});
    assert.equal(remote.localCodexPermissions,undefined);assert.equal(taskCodexPermissions(remote),"sandbox");
    // Simulate an old saved record without changing the new-task path.
    const saved=JSON.parse(await readFile(file,"utf8"));delete saved.tasks.find((t:{id:string})=>t.id===legacy.id).localCodexPermissions;
    await writeFile(file,JSON.stringify(saved));
    const reload=new JsonTaskStore(file);await reload.init();
    assert.equal(taskCodexPermissions(reload.get(local.id)!),"full-access");
    assert.equal(taskCodexPermissions(reload.get(restricted.id)!),"sandbox");
    assert.equal(reload.get(legacy.id)!.localCodexPermissions,undefined);
    assert.equal(taskCodexPermissions(reload.get(legacy.id)!),"sandbox");
    assert.equal(taskCodexPermissions(reload.get(remote.id)!),"sandbox");
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("Dispatch duration persists in both goal modes and survives reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-duration-"));
  try {
    const file = join(directory, "tasks.json"), store = new JsonTaskStore(file); await store.init();
    const input = { title:"Timed", prompt:"Verify artifacts", cwd:directory, strategy:"balanced" as const, allowedAgentIds:["codex" as const], modelOverrides:{} };
    for (const goalMode of ["ai", "manual"] as const) {
      const t = await store.create({...input, goalMode, targetMinutes: 90});
      assert.equal(t.autonomy?.targetMinutes,90);
      assert.equal(t.goal?.status,"draft");
      const reloaded = new JsonTaskStore(file); await reloaded.init();
      assert.equal(reloaded.get(t.id)?.autonomy?.targetMinutes,90);
    }
    assert.equal((await store.create({...input, goalMode:"manual"})).autonomy?.targetMinutes,undefined);
    const count = store.list().length;
    for (const targetMinutes of [0,-1,1.5,10081,NaN,"60",null])
      await assert.rejects(store.create({...input, targetMinutes: targetMinutes as number}),/作業目安時間/);
    assert.equal(store.list().length,count);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("equal timestamps retain FIFO queue order across reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-fifo-"));
  try {
    const file = join(directory, "tasks.json"); const store = new JsonTaskStore(file); await store.init();
    const first = await store.create({title:"first",prompt:"fixture",cwd:directory,strategy:"balanced",allowedAgentIds:["codex"],modelOverrides:{}});
    const second = await store.create({title:"second",prompt:"fixture",cwd:directory,strategy:"balanced",allowedAgentIds:["codex"],modelOverrides:{}});
    const saved = JSON.parse(await readFile(file,"utf8"));
    for (const task of saved.tasks) task.createdAt = "2026-09-14T00:00:00.000Z";
    await writeFile(file,JSON.stringify(saved));
    const reloaded = new JsonTaskStore(file); await reloaded.init();
    assert.deepEqual(reloaded.list().reverse().map(t=>t.id),[first.id,second.id]);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("task store persists tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-store-"));
  try {
    const file = join(directory, "tasks.json");
    const store = new JsonTaskStore(file);
    await store.init();
    const created = await store.create({
      title: "Smoke test",
      prompt: "Return ok",
      cwd: directory,
      strategy: "balanced",
      allowedAgentIds: ["codex", "claude"],
      modelOverrides: {}
    });

    const reloaded = new JsonTaskStore(file);
    await reloaded.init();
    assert.equal(reloaded.get(created.id)?.title, "Smoke test");
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.get(created.id)?.workUnits.length, 3);
    assert.equal(reloaded.get(created.id)?.workflowMode, "primary");
    assert.equal(reloaded.get(created.id)?.workUnits[0].primary, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PTY reload preserves the handoff instead of parsing terminal redraws as structured logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-pty-store-"));
  try {
    const file = join(directory, "tasks.json");
    const store = new JsonTaskStore(file); await store.init();
    const task = await store.create({ title: "PTY", prompt: "Review", cwd: directory,
      strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {} });
    const summary = "Reviewed the code; tests pass.";
    const structured = '<work-check>{"status":"needs-work","remainingWork":"Rebuild the report"}</work-check>';
    const raw = "\x1b[2J\x1b[HReading additional input from stdin\r\nTerminal redraw";
    await store.update(task.id, { state: "awaiting-input", awaitingReason: "result",
      workUnits: [{ ...task.workUnits[0], state: "completed", output: `${summary}\n${structured}` }],
      runs: [{ id: "pty", workUnitId: task.workUnits[0].id, role: "planner", agentId: "codex",
        providerKey: "openai", terminal: true, state: "completed", output: raw,
        displayOutput: summary, usage: { source: "unknown" }, startedAt: new Date().toISOString() }] });
    const reloaded = new JsonTaskStore(file); await reloaded.init();
    const saved = reloaded.get(task.id)!;
    assert.equal(saved.state, "awaiting-input");
    assert.equal(saved.runs[0].terminal, true);
    assert.equal(saved.runs[0].displayOutput, summary);
    assert.equal(saved.runs[0].output, raw);
    assert.equal(saved.workUnits[0].output, `${summary}\n${structured}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reload recovers an overwritten unfinished-work receipt only for the latest completed terminal run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-receipt-reload-"));
  try {
    const file = join(directory, "tasks.json"), store = new JsonTaskStore(file); await store.init();
    const task = await store.create({title:"Receipt",prompt:"fixture",cwd:directory,strategy:"balanced",allowedAgentIds:["claude"],modelOverrides:{}});
    const summary = "Audit ended, repairs remain.";
    const structured = '<work-check>{"status":"needs-work","remainingWork":"Repair stale PDF"}</work-check>';
    for (const scenario of ["recover", "failed", "cancelled", "pending", "newer", "changed", "malformed", "ready", "duplicate"]) {
      const unit = {...task.workUnits[0], state: scenario === "pending" ? "pending" as const : "completed" as const,
        output: scenario === "changed" ? "A newer validated result" : summary};
      const run = {id:"terminal",workUnitId:unit.id,role:unit.role,agentId:"claude" as const,providerKey:"anthropic",terminal:true,
        state: scenario === "failed" ? "failed" as const : scenario === "cancelled" ? "cancelled" as const : "completed" as const,
        output:"terminal redraw",displayOutput:summary,startedAt:task.createdAt,
        structuredResult:scenario === "malformed" ? '<work-check>{broken}</work-check>' : scenario === "ready" ? structured.replace("needs-work", "ready")
          : scenario === "duplicate" ? structured + structured : structured};
      await store.update(task.id,{state:"paused",workUnits:[unit],runs:scenario === "newer" ? [run,{...run,id:"newer",state:"cancelled",displayOutput:undefined,structuredResult:undefined}] : [run]});
      for (let reload = 0; reload < 2; reload++) {
        const loaded = new JsonTaskStore(file); await loaded.init();
        const saved = loaded.get(task.id)!;
        assert.equal(saved.state,"paused");
        assert.equal(saved.workUnits[0].output, scenario === "recover" ? `${summary}\n${structured}` : unit.output, scenario);
        assert.equal(saved.workUnits[0].state,unit.state);
      }
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("task store deletes only the selected task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-delete-"));
  try {
    const file = join(directory, "tasks.json");
    const store = new JsonTaskStore(file);
    await store.init();
    const first = await store.create({
      title: "Delete me",
      prompt: "Temporary",
      cwd: directory,
      strategy: "balanced",
      allowedAgentIds: ["codex"],
      modelOverrides: {}
    });
    const keep = await store.create({
      title: "Keep me",
      prompt: "Persistent",
      cwd: directory,
      strategy: "balanced",
      allowedAgentIds: ["claude"],
      modelOverrides: {}
    });
    await store.delete(first.id);
    assert.equal(store.get(first.id), undefined);
    assert.equal(store.get(keep.id)?.title, "Keep me");
    assert.equal(JSON.parse(await readFile(file, "utf8")).tasks.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task store migrates a queued single-CLI task without running it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-legacy-"));
  try {
    const file = join(directory, "tasks.json");
    await writeFile(file, JSON.stringify({
      version: 1,
      tasks: [{
        id: "legacy-1",
        title: "TI16",
        prompt: "Preserve this task",
        cwd: directory,
        agentId: "claude",
        state: "queued",
        output: "",
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z"
      }]
    }), "utf8");
    const store = new JsonTaskStore(file);
    await store.init();
    const migrated = store.get("legacy-1");
    assert.equal(migrated?.state, "queued");
    assert.deepEqual(migrated?.allowedAgentIds, ["claude"]);
    assert.equal(migrated?.legacySingleAgent, true);
    assert.deepEqual(migrated?.workUnits.map((unit) => unit.role), ["worker", "reporter"]);
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task store creates a readable monitor for legacy raw CLI output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-legacy-monitor-"));
  try {
    const file = join(directory, "tasks.json");
    const base = new JsonTaskStore(file);
    await base.init();
    const created = await base.create({
      title: "Temporary",
      prompt: "Temporary",
      cwd: directory,
      strategy: "balanced",
      allowedAgentIds: ["claude"],
      modelOverrides: {}
    });
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.tasks[0] = {
      ...created,
      agentId: "claude",
      legacySingleAgent: true,
      state: "failed",
      runs: [],
      output: `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Readable legacy result" }] } })}\n`
    };
    await writeFile(file, JSON.stringify(raw), "utf8");
    const repaired = new JsonTaskStore(file);
    await repaired.init();
    const task = repaired.get(created.id);
    assert.equal(task?.runs.length, 1);
    assert.equal(task?.runs[0].providerKey, "anthropic-default");
    assert.match(task?.runs[0].displayOutput ?? "", /Readable legacy result/);
    assert.doesNotMatch(task?.runs[0].displayOutput ?? "", /\"type\"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task store blocks a workflow interrupted by an app restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-recovery-"));
  try {
    const file = join(directory, "tasks.json");
    const store = new JsonTaskStore(file);
    await store.init();
    const created = await store.create({
      title: "Interrupted",
      prompt: "Continue safely",
      cwd: directory,
      strategy: "balanced",
      allowedAgentIds: ["codex", "claude"],
      modelOverrides: {}
    });
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.tasks[0].state = "running";
    raw.tasks[0].updatedAt = "2026-09-11T00:03:00.000Z";
    raw.tasks[0].workUnits[0].state = "running";
    raw.tasks[0].runs = [{
      id: "active-run",
      workUnitId: created.workUnits[0].id,
      role: "planner",
      agentId: "codex",
      providerKey: "openai-default",
      state: "running",
      output: "",
      startedAt: "2026-09-11T00:00:00.000Z"
    }];
    await writeFile(file, JSON.stringify(raw), "utf8");
    const recovered = new JsonTaskStore(file);
    await recovered.init();
    const task = recovered.get(created.id);
    assert.equal(task?.state, "blocked");
    assert.equal(task?.workUnits[0].state, "blocked");
    assert.equal(task?.runs[0].state, "cancelled");
    assert.equal(task?.runs[0].completedAt, "2026-09-11T00:03:00.000Z", "offline time is not active execution");
    assert.match(task?.error ?? "", /previous Scientelier session ended/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reload fences remote readers and writers even when a sibling already blocked the task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-remote-reload-"));
  try {
    const file = join(directory, "tasks.json"), store = new JsonTaskStore(file); await store.init();
    const original = await store.create({ title: "Remote recovery", prompt: "Keep partial work", cwd: directory,
      strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {} });
    for (const state of ["running", "blocked", "paused"] as const) {
      const units = original.workUnits.map((u, index) => ({ ...u, state: index === 2 ? "completed" as const : "running" as const,
        mode: index === 0 ? "read" as const : "write" as const, output: `Keep ${index}` }));
      const runs = units.map((u, index) => ({ id: `run-${index}`, workUnitId: u.id, role: u.role, agentId: "codex" as const,
        providerKey: "openai", executionLocation: index === 2 ? "local" as const : "remote" as const,
        terminal: true, state: index === 2 ? "completed" as const : "running" as const,
        output: "Partial work", startedAt: original.createdAt }));
      await store.update(original.id, { state, workUnits: units, runs });
      const loaded = new JsonTaskStore(file); await loaded.init();
      const recovered = loaded.get(original.id)!;
      assert.equal(recovered.state, state === "paused" ? "paused" : "blocked");
      assert.ok(recovered.runs.slice(0, 2).every(r => r.state === "cancelled" && r.terminationUnconfirmed));
      assert.ok(recovered.workUnits.slice(0, 2).every(u => u.state === "blocked" && u.launchBlocked));
      assert.deepEqual(recovered.runs[2], runs[2]);
      assert.deepEqual(recovered.workUnits[2], units[2]);
      assert.match(recovered.error!, /旧担当の終了/);
      const resumed = { ...recovered, ...resumePatch(recovered) };
      assert.ok(resumed.runs.slice(0, 2).every(r => r.terminationUnconfirmed), "resume must never clear remote ownership fences");
      assert.equal(resumed.workUnits[0].output, units[0].output);
      const secondLoad = new JsonTaskStore(file); await secondLoad.init();
      assert.deepEqual(secondLoad.get(original.id), JSON.parse(JSON.stringify(recovered)), "recovery is idempotent across repeated restarts");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("new tasks always have a primary plan and reject the retired staged mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-primary-only-"));
  try {
    const store=new JsonTaskStore(join(directory,"tasks.json"));await store.init();
    const input={title:"test",prompt:"test",cwd:directory,strategy:"balanced" as const,allowedAgentIds:["codex" as const],modelOverrides:{}};
    const t=await store.create(input);assert.equal(t.workflowMode,"primary");assert.ok(t.execution);assert.ok(t.workUnits[0].primary);
    await assert.rejects(store.create({...input,workflowMode:"staged"}),/主担当方式/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
