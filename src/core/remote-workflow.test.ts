import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient, uploadReport, downloadReport, remoteReportRoot } from "./remote-client";
import type { RemoteConnection } from "./remote-client";
import { PreparedRemoteClient } from "./prepared-client";
import { quoteShellArgument as q } from "./adapters";
import type { TaskRecord } from "./types";
import { JsonTaskStore } from "./task-store";
import { defaultExecution } from "./execution-policy";

test("remote workflow runs a real foreground CLI, MCP and native hook through the shared offline SSH transport", async () => {
  const prepared = process.env.HARNESS_TEST_PREPARED === "1";
  const tmux = process.env.HARNESS_TEST_TMUX === "1";
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ah-remote-workflow-")));
  const templates = require("../../scripts/report-template-fixture.cjs").reportTemplateFixture(directory);
  const RealReportService = require("./report-service").ReportService;
  require("./report-service").ReportService = class extends RealReportService {
    constructor() { super(templates, join(process.cwd(), "assets", "document-templates")); }
  };
  const remote = join(directory, "cluster"); const bin = join(remote, "bin");
  const workspace = join(remote, "new", "project");
  await mkdir(bin, { recursive: true });
  // Allow only fake Codex/Antigravity below. Adaptive routing must never
  // launch authenticated real CLIs inherited from the host PATH.
  await writeFile(join(bin, "codex"), `#!/bin/sh\nexec ${q(process.execPath)} ${q(join(process.cwd(), "scripts", "fixture-remote-cli.cjs"))} "$@"\n`, { mode: 0o700 });
  await writeFile(join(bin, "agy"), `#!/bin/sh\nexec ${q(process.execPath)} ${q(join(process.cwd(), "scripts", "fixture-file-cli.cjs"))} "$@"\n`, { mode: 0o700 });
  const handlers = new Map<string, (...args: any[]) => any>(); const events = new Map<string, () => void>();
  const emitted: { name: string; value: any }[] = [];
  const electronId = require.resolve("electron");
  require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: {
    app: { setName: () => {}, setPath: () => {}, setAboutPanelOptions: () => {}, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), getPath: () => directory, getAppPath: () => process.cwd(), on: (name: string, listener: () => void) => events.set(name, listener) },
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
    ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
    BrowserWindow: class { webContents = { send(name: string, value: any) { emitted.push({ name, value }); }, setWindowOpenHandler() {}, on() {} }; isDestroyed() { return false; } loadFile() { return Promise.resolve(); } on() {} static getAllWindows() { return []; } }
  } } as NodeModule;
  require("./cli-detect").detectAgents = async () => [];
  require("./capacity-probes").readCodexCapacity = async () => ({ limited: false });
  require("./claude-capacity").readClaudeCapacity = async () => ({ limited: false });
  require("./report-service").checkReportEnvironment = async () => ({ tex: { ok: true }, plot: { ok: true }, checkedAt: new Date().toISOString() });
  const originalCreate = RemoteClient.create; const originalPreparedCreate = PreparedRemoteClient.create; let client: RemoteConnection | undefined;
  RemoteClient.create = async (system, core) => client = await originalCreate(system, core, { command: process.execPath, prefix: [join(process.cwd(), "scripts", "fixture-ssh.cjs")] });
  PreparedRemoteClient.create = async (system, core) => client = await originalPreparedCreate(system, core, { command: "/bin/bash", args: ["--noprofile", "--norc", "-i"], cwd: remote }) as PreparedRemoteClient;
  const ipc = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);
  let taskStore: JsonTaskStore;
  const originalInit = JsonTaskStore.prototype.init;
  JsonTaskStore.prototype.init = async function () { await originalInit.call(this); taskStore = this; };
  const waitFor = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); }
    throw new Error("Remote workflow condition timed out");
  };
  try {
    require("../main"); await waitFor(() => handlers.has("remote:connect"));
    // This transport/receipt fixture deliberately has one fake coding CLI.
    // Preserve its legacy review policy instead of the new multi-service default.
    await ipc("execution:settings-update", defaultExecution);
    await ipc("remote:save", { id: "offline", name: "Offline cluster", host: "not-a-network-host", cwd: workspace, nodeCommand: process.execPath, texCommand: "latexmk", terminalBackend:tmux ? "tmux" : "direct", startup: `export PATH=${q(bin)}:"$PATH"`, instructions: "ジョブ投入は禁止（テスト）", codexPermissions: "sandbox", ...(prepared ? { connectionMode: "prepared" } : {}) });
    const task = await ipc("task:create", { workspaceMode: "remote", title: "遠隔ゴール整理", prompt: "遠隔でゴールを整理", cwd: "/ignored", remoteSystemId: "offline", goalMode: "ai", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {} });
    // No pre-authentication: starting (including goal preparation) waits before
    // launching a CLI. Cancelling preserves the task and allows another attempt.
    const approved = await ipc("goals:save", task.id, { ...task.goal, questions: [] }, task.goal.revision, true);
    const reopened = await ipc("goals:save", task.id, approved.goal, approved.goal.revision, false);
    const cancelled = ipc("goals:refine", task.id, "承認後もAIで整理", reopened.goal.revision);
    const cancellation = assert.rejects(cancelled, /SSH認証を取り消しました/);
    await waitFor(() => emitted.some(e => e.name === "remote:auth-required"));
    assert.equal((await ipc("app:snapshot")).tasks.find((t: TaskRecord) => t.id === task.id).runs.length, 0);
    await ipc("remote:task-cancel", task.id); await cancellation;
    emitted.length = 0;
    const starting = ipc("task:run", task.id);
    await waitFor(() => emitted.some(e => e.name === "remote:auth-required"));
    await assert.rejects(ipc("task:run", task.id), /既に実行中/);
    await assert.rejects(ipc("remote:task-ready", task.id), /接続を開始/);
    await ipc("remote:task-connect", task.id);
    await ipc("remote:task-connect", task.id); // Reuse one master, no duplicate login.
    if (prepared) {
      await ipc("remote:input", "offline", `mkdir -p ${q(workspace)}; cd ${q(workspace)}; export PATH=${q(bin)}:"$PATH"; printf '\\nPREPARED_WORKFLOW_READY\\n'\r`);
      await waitFor(async () => (await ipc("remote:snapshot", "offline")).data.includes("\r\nPREPARED_WORKFLOW_READY\r\n"));
    }
    const { agents, cwd } = await ipc("remote:task-ready", task.id);
    assert.ok(agents.some((a: any) => a.id === "codex" && a.installed)); assert.equal(cwd, workspace);
    await starting;
    let updated: TaskRecord | undefined;
    await waitFor(async () => { updated = (await ipc("app:snapshot")).tasks.find((t: TaskRecord) => t.id === task.id); return updated?.state === "awaiting-input"; });
    assert.equal(updated!.goal!.objective, "遠隔ファイルを確認する");
    assert.equal(updated!.goal!.status, "draft"); assert.equal(updated!.runs[0].state, "completed");
    assert.equal(updated!.remote!.resolvedCwd, workspace);
    if (prepared) assert.equal(updated!.remote!.preparedTarget?.cwd, workspace);
    assert.match(updated!.runs[0].providerKey, /@offline$/);
    const terminal = await ipc("terminal:snapshot", task.id, updated!.runs[0].id);
    assert.equal(terminal.inputAllowed, false); assert.match(terminal.data, /\x1b\[32m/);
    const runDirectory = join(workspace, ".agent-harness", task.id, "runs", updated!.runs[0].id);
    const firstLaunch = JSON.parse(await readFile(join(runDirectory, "launch.json"), "utf8"));
    assert.equal(firstLaunch.cwd, workspace);
    assert.ok(firstLaunch.args.includes(`projects.${JSON.stringify(workspace)}.trust_level="trusted"`));
    assert.ok((await readdir(runDirectory)).includes("structured-result-goal-draft.json"));
    assert.ok((await readdir(runDirectory)).includes("structured-result-work-check.json"));
    assert.match(await readFile(join(runDirectory, "instructions.txt"), "utf8"), /ジョブ投入は禁止/);
    await assert.rejects(async()=>ipc("terminal:input", task.id, updated!.runs[0].id, "user input\r"),/終了した担当/);
    await waitFor(async () => !(await ipc("terminal:snapshot", task.id, updated!.runs[0].id)).alive);
    // The desktop-only recovery shell uses the already authenticated transport,
    // has no agent instructions, and never turns a failed run into completed work.
    const recoveredRun=updated!.runs[0].id,goalBefore=JSON.stringify(updated!.goal);
    const recoveryShell=await ipc("terminal:recovery",task.id,recoveredRun,"start");
    assert.match(recoveryShell.command,/codex/);
    await assert.rejects(ipc("task:run",task.id),/手動復旧/);
    await assert.rejects(ipc("task:delete",task.id),/手動復旧/);
    await assert.rejects(ipc("terminal:recovery",task.id,recoveredRun,"ready",{verified:true}),/exit/);
    await ipc("terminal:recovery",task.id,recoveredRun,"input","printf 'MANUAL_%s\\n' RECOVERY_OK\r");
    await waitFor(async()=> (await ipc("terminal:recovery",task.id,recoveredRun,"snapshot")).data.includes("MANUAL_RECOVERY_OK"));
    await ipc("terminal:recovery",task.id,recoveredRun,"input","exit\r");
    await waitFor(async()=>!(await ipc("terminal:recovery",task.id,recoveredRun,"snapshot")).alive);
    assert.equal((await ipc("terminal:recovery",task.id,recoveredRun,"inspect")).stopped,true);
    await assert.rejects(ipc("terminal:recovery",task.id,recoveredRun,"ready"),/正常応答/);
    assert.equal((await ipc("terminal:recovery",task.id,recoveredRun,"ready",{verified:true})).ready,true);
    await assert.rejects(ipc("terminal:recovery",task.id,recoveredRun,"ready",{verified:true}),/状態が変わり/);
    const restored=taskStore!.get(task.id)!;
    assert.equal(JSON.stringify(restored.goal),goalBefore);assert.ok(restored.runs[0].recoveredAt);
    assert.equal(restored.runs[0].state,"completed");
    if (prepared) {
      const local = await ipc("task:create", { workspaceMode: "existing", title: "準備後に割り当て", prompt: "ゴールを保持", cwd: directory, goalMode: "manual", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {} });
      const approvedLocal = await ipc("goals:save", local.id, { ...local.goal, questions: [] }, local.goal.revision, true);
      const bound = await ipc("task:remote-bind", local.id, "offline");
      assert.ok(!emitted.filter(e => e.name === "queue:changed").at(-1)!.value.activeTaskIds.includes(local.id), "binding must publish an idle task after releasing its lock");
      assert.deepEqual(bound.goal, approvedLocal.goal);
      assert.equal(bound.remote.preparedTarget.cwd, workspace);
      assert.notEqual(bound.cwd, directory); assert.equal(bound.execution.maxParallel, approvedLocal.execution.maxParallel);
      await ipc("task:delete", bound.id);
    }
    // A second queued task reuses the authenticated session, without a prompt.
    emitted.length = 0;
    const next = await ipc("task:create", { workspaceMode: "remote", title: "接続の再利用", prompt: "遠隔でゴールを整理", cwd: "/ignored", remoteSystemId: "offline", goalMode: "ai", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {} });
    await ipc("queue:start");
    await waitFor(async () => (await ipc("app:snapshot")).tasks.find((t: TaskRecord) => t.id === next.id)?.state === "awaiting-input");
    assert.equal(emitted.filter(e => e.name === "remote:auth-required").length, 0);
    await waitFor(async () => !(await ipc("app:snapshot")).queue.running);
    if (tmux) {
      await writeFile(join(workspace,".fixture-retain"),"hold fixture only");
      const retained = await ipc("task:create", {workspaceMode:"remote",title:"tmux再接続",prompt:"同じCLIへ戻る",remoteSystemId:"offline",goalMode:"ai",allowedAgentIds:["codex"],strategy:"balanced",modelOverrides:{}});
      await ipc("task:run",retained.id);
      await waitFor(async()=>{try{return !!(await readFile(join(workspace,".fixture-retained-starts"),"utf8"));}catch{return false;}});
      const originalRun = taskStore!.get(retained.id)!.runs[0];
      client!.close();
      // The offline bridge and PTY are separate child processes. Unlike a real
      // lost SSH transport, closing the fake bridge alone cannot drop its PTY.
      if (!prepared) process.kill((await ipc("terminal:snapshot",retained.id,originalRun.id)).pid,"SIGTERM");
      await waitFor(()=>taskStore!.get(retained.id)!.runs[0].remoteSession?.detached === true);
      await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskIds.includes(retained.id));
      await ipc("remote:connect","offline");
      if (prepared) {
        await ipc("remote:input","offline",`cd ${q(workspace)}; export PATH=${q(bin)}:"$PATH"; printf '\\nTMUX_RECONNECT_READY\\n'\r`);
        await waitFor(async()=>(await ipc("remote:snapshot","offline")).data.includes("\r\nTMUX_RECONNECT_READY\r\n"));
      }
      await ipc("remote:check","offline");
      await ipc("task:resume",retained.id);
      await waitFor(()=>taskStore!.get(retained.id)!.runs[0].state === "running");
      await writeFile(join(workspace,".fixture-release"),"continue");
      await waitFor(()=>taskStore!.get(retained.id)!.state === "awaiting-input");
      const restored=taskStore!.get(retained.id)!;
      assert.equal(restored.runs.length,1); assert.equal(restored.runs[0].id,originalRun.id);
      assert.equal(restored.runs[0].terminationUnconfirmed,false);
      assert.equal((await readFile(join(workspace,".fixture-retained-starts"),"utf8")).trim().split("\n").length,1);
      await rm(join(workspace,".fixture-retain")); await rm(join(workspace,".fixture-release"));
      await ipc("task:delete",retained.id);
    }
    for (const id of [task.id, next.id]) {
      const finished = (await ipc("app:snapshot")).tasks.find((t: TaskRecord) => t.id === id);
      for (const run of finished.runs) {
        await ipc("terminal:close", id, run.id);
        await waitFor(async () => !(await ipc("terminal:snapshot", id, run.id)).alive);
      }
    }
    const diagnosis = await ipc("remote:diagnose", "offline");
    assert.equal(diagnosis.cwd, workspace);
    assert.equal(diagnosis.checks[0].ok, true);
    assert.ok(diagnosis.checks.some((c: any) => c.detail.includes("codex-fixture")));
    assert.equal(client?.connected, true);
    const fileTask=await ipc("task:create",{workspaceMode:"remote",title:"遠隔ファイル結果",prompt:"結果受領の検証",remoteSystemId:"offline",goalMode:"ai",strategy:"balanced",allowedAgentIds:["antigravity"],modelOverrides:{}});
    // Exceed Linux's per-argument limit; the native CLI must read the complete
    // instructions file instead of receiving the full prompt through argv.
    await taskStore!.update(fileTask.id,{prompt:"長い引き継ぎ記録".repeat(20000)+" END_OF_LONG_INSTRUCTIONS"});
    await ipc("task:run",fileTask.id);
    await waitFor(async()=>(await ipc("app:snapshot")).tasks.find((t:TaskRecord)=>t.id===fileTask.id)?.state==="awaiting-input");
    const fileDone=taskStore!.get(fileTask.id)!;
    assert.equal(fileDone.goal!.objective,"遠隔ファイル通知を検証する");
    assert.equal(fileDone.runs[0].agentId,"antigravity");assert.equal(fileDone.runs[0].state,"completed");
    assert.equal(fileDone.runs[0].displayOutput,"結果を提出しました。");
    assert.match(fileDone.runs[0].structuredResult!,/<goal-draft>/);
    const fileRunDirectory=join(workspace,".agent-harness",fileDone.id,"runs",fileDone.runs[0].id);
    const fileLaunch=JSON.parse(await readFile(join(fileRunDirectory,"launch.json"),"utf8"));
    assert.equal(fileLaunch.cwd, workspace);
    assert.match(await readFile(fileDone.runs[0].logPath!, "utf8"), /Antigravity CLI起動フォルダの信頼確認を自動承認/);
    assert.ok(fileLaunch.args.every((arg:string)=>Buffer.byteLength(arg)<8000));
    assert.ok((await readFile(join(fileRunDirectory,"instructions.txt"),"utf8")).includes("END_OF_LONG_INSTRUCTIONS"));
    assert.ok((await readFile(join(fileRunDirectory,"session-control.json"))).length<1000);
    await waitFor(async()=>!(await ipc("terminal:snapshot",fileTask.id,fileDone.runs[0].id)).alive);
    // Recover the persisted response-completed/work-unfinished shape without
    // invoking a real model or touching a real SSH host.
    const recoveryDraft = await ipc("task:create", { workspaceMode: "remote", title: "障害復旧", prompt: "既存成果を保持", cwd: directory, remoteSystemId: "offline", goalMode: "manual", workflowMode: "primary", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {} });
    // Goal preparation can fail before approval: changing the launch policy
    // must not require approval, start a CLI, or rewrite the draft goal.
    assert.notEqual(recoveryDraft.goal.status, "approved");
    await assert.rejects(ipc("task:codex-permissions", recoveryDraft.id, "full-access", false), /リスク確認/);
    const draftPermissions = await ipc("task:codex-permissions", recoveryDraft.id, "full-access", true);
    assert.equal(draftPermissions.remote.codexPermissions, "full-access");
    assert.deepEqual(draftPermissions.goal, recoveryDraft.goal);
    assert.equal(draftPermissions.state, recoveryDraft.state);
    assert.deepEqual(draftPermissions.runs, []);
    assert.ok(!emitted.filter(e => e.name === "queue:changed").at(-1)!.value.activeTaskIds.includes(recoveryDraft.id), "permission save must not leave a phantom running task in the UI");
    const beforeIdlePause = JSON.stringify(taskStore!.get(recoveryDraft.id));
    emitted.length = 0;
    assert.equal(await ipc("task:cancel", recoveryDraft.id), false);
    assert.equal(JSON.stringify(taskStore!.get(recoveryDraft.id)), beforeIdlePause, "pausing an idle task only resynchronizes the view");
    assert.ok(!emitted.filter(e => e.name === "queue:changed").at(-1)!.value.activeTaskIds.includes(recoveryDraft.id));
    await ipc("task:codex-permissions", recoveryDraft.id, "sandbox", false);
    const recoveryGoal = await ipc("goals:save", recoveryDraft.id, { ...recoveryDraft.goal, questions: [] }, recoveryDraft.goal.revision, true);
    const primary = recoveryGoal.workUnits.find((u: any) => u.primary && !u.planPhase) ?? recoveryGoal.workUnits.find((u: any) => u.role === "worker");
    const failure = "bwrap: setting up uid map: Permission denied";
    const recovery = await taskStore!.update(recoveryGoal.id, { state: "awaiting-input", awaitingReason: "result", autonomyState: "needs-input", error: failure,
      remote: { ...recoveryGoal.remote, resolvedCwd: workspace, ...(client instanceof PreparedRemoteClient ? { preparedTarget: client.target } : {}) },
      workUnits: [
        { ...primary, id: "kept-plan", planPhase: true, delegationHandled: true, checkpointHandled: true, state: "completed", dependsOn: [], output: "Keep the approved plan" },
        { ...primary, id: "retry-work", planPhase: false, state: "completed", dependsOn: ["kept-plan"], assignedAgentId: "codex", checkpointHandled: true, output: `<work-check>${JSON.stringify({ status: "ask-user", summary: failure })}</work-check>` },
        ...recoveryGoal.workUnits.filter((u: any) => ["reporter", "reviewer"].includes(u.role)).map((u: any, i: number, arr: any[]) => ({ ...u, dependsOn: [i === 0 ? "retry-work" : arr[i - 1].id] }))
      ] });
    const beforeRecovery = JSON.stringify(taskStore!.get(recovery.id));
    const inspected = await ipc("task:recovery", recovery.id, "inspect");
    assert.equal(inspected.ready, true); assert.equal(inspected.unitId, "retry-work");
    assert.equal(JSON.stringify(taskStore!.get(recovery.id)), beforeRecovery);
    // A successful earlier diagnosis is not a reusable bypass token.
    await writeFile(join(workspace, ".fixture-diagnostic-fail"), "test failure");
    await assert.rejects(ipc("task:recovery", recovery.id, "resume"), /復旧確認に失敗/);
    assert.equal(JSON.stringify(taskStore!.get(recovery.id)), beforeRecovery);
    assert.equal((await ipc("task:recovery", recovery.id, "inspect")).ready, false);
    await rm(join(workspace, ".fixture-diagnostic-fail"));
    await assert.rejects(ipc("task:codex-permissions", recovery.id, "full-access", false), /リスク確認/);
    await assert.rejects(ipc("task:codex-permissions", recovery.id, "unknown", true), /不正/);
    assert.equal(JSON.stringify(taskStore!.get(recovery.id)), beforeRecovery);
    const fullTask = await ipc("task:codex-permissions", recovery.id, "full-access", true);
    assert.deepEqual(fullTask.goal, recovery.goal); assert.deepEqual(fullTask.workUnits, recovery.workUnits);
    assert.equal(fullTask.state, recovery.state); assert.equal(fullTask.runs.length, 0);
    const fullDiagnosis = await ipc("task:recovery", recovery.id, "inspect");
    assert.equal(fullDiagnosis.ready, true); assert.equal(fullDiagnosis.diagnostic.codexPermissions, "full-access");
    assert.equal(fullDiagnosis.diagnostic.checks.length, 2);
    const originalProfile = (await ipc("remote:list"))[0];
    await assert.rejects(ipc("remote:save", { ...originalProfile, codexPermissions: "full-access" }), /リスク確認/);
    await ipc("remote:save", { ...originalProfile, codexPermissions: "full-access" }, true);
    const future = await ipc("task:create", { workspaceMode: "remote", title: "Full access snapshot", prompt: "No execution", cwd: directory, remoteSystemId: "offline", goalMode: "manual", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {} });
    assert.equal(future.remote.codexPermissions, "full-access");
    assert.equal(taskStore!.get(task.id)!.remote!.codexPermissions, "sandbox");
    await ipc("task:delete", future.id);
    await ipc("remote:save", originalProfile);
    assert.equal(taskStore!.get(recovery.id)!.remote!.codexPermissions, "full-access");
    await ipc("task:recovery", recovery.id, "resume");
    await waitFor(() => Boolean(taskStore!.get(recovery.id)?.runs.length));
    await assert.rejects(ipc("task:codex-permissions", recovery.id, "sandbox", false), /端末|停止/);
    assert.equal(taskStore!.get(recovery.id)!.runs[0].workUnitId, "retry-work");
    assert.equal(taskStore!.get(recovery.id)!.runs[0].codexPermissions, "full-access");
    assert.deepEqual(taskStore!.get(recovery.id)!.goal, recovery.goal);
    assert.equal(taskStore!.get(recovery.id)!.workUnits[0].output, "Keep the approved plan");
    // The stand-in emits a goal proposal, not a valid worker checkpoint: it
    // must stop again without letting the reporter certify unfinished work.
    await waitFor(() => ["paused", "awaiting-input", "blocked"].includes(taskStore!.get(recovery.id)!.state));
    const recoveryRun = taskStore!.get(recovery.id)!.runs[0];
    const launch = JSON.parse(await readFile(join(workspace, ".agent-harness", recovery.id, "runs", recoveryRun.id, "launch.json"), "utf8"));
    assert.equal(launch.args[launch.args.indexOf("--sandbox") + 1], "danger-full-access");
    for (const run of taskStore!.get(recovery.id)!.runs) {
      await ipc("terminal:close", recovery.id, run.id);
      await waitFor(async () => !(await ipc("terminal:snapshot", recovery.id, run.id)).alive);
    }
    assert.equal(taskStore!.get(recovery.id)!.runs.some(r => r.role === "reporter"), false);
    await waitFor(async () => !(await ipc("app:snapshot")).queue.activeTaskIds.includes(recovery.id));
    assert.equal((await ipc("task:codex-permissions", recovery.id, "sandbox", false)).remote.codexPermissions, "sandbox");
    // Resume at the reporter on the SAME remote host, download its PDF for
    // preview, and let the remote reviewer inspect that authoritative output.
    client!.agents = client!.agents.filter(a => a.id === "codex"); // Never launch a host's real CLI in this fixture.
    require("./cli-detect").detectAgents = async () => [{id:"codex",label:"Codex",command:"codex",executable:join(bin,"codex"),installed:true}];
    await ipc("agents:refresh");
    const reportDraft = await ipc("task:create", { workspaceMode: "remote",title:"Remote report build",prompt:"Keep completed work",cwd:directory,remoteSystemId:"offline",goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex"],modelOverrides:{}});
    const reportGoal = await ipc("goals:save",reportDraft.id,{...reportDraft.goal,questions:[]},reportDraft.goal.revision,true);
    const reportUnit = reportGoal.workUnits.find((u: any)=>u.role==='reporter');
    const reviewUnits = reportGoal.workUnits.filter((u: any)=>u.role==='reviewer');
    const reportTask = await taskStore!.update(reportGoal.id, {
      report: await new (require("./report-service").ReportService)(join(process.cwd(),"assets","ipsj-tech-report","runtime")).syncDraft(reportGoal,(await ipc("app:snapshot")).reportSettings,true),
      state:'paused', resumeFromUnitId:reportUnit.id,
      remote:{...reportGoal.remote,resolvedCwd:workspace,codexPermissions:'full-access',...(client instanceof PreparedRemoteClient ? {preparedTarget:client.target}:{})},
      runs:[{id:'previous-reporter',role:'reporter',workUnitId:reportUnit.id,agentId:'codex',providerKey:'openai-default@offline',state:'completed',output:'Prior remote TeX missing',startedAt:new Date(0).toISOString()}],
      workUnits:[{...reportUnit,id:'kept-work',role:'worker',primary:true,state:'completed',checkpointHandled:true,dependsOn:[],output:'Keep completed implementation'},
        {...reportUnit,state:'pending',dependsOn:['kept-work']},...reviewUnits.map((u: any,i: number)=>({...u,state:'pending',dependsOn:[i?reviewUnits[i-1].id:reportUnit.id]}))]
    });
    await uploadReport(client!,reportTask);
    await writeFile(join(remoteReportRoot(reportTask),'report.tex'),'Keep partial report');
    await mkdir(join(remoteReportRoot(reportTask),'logs'), {recursive:true});
    await writeFile(join(remoteReportRoot(reportTask),'logs','experiment.log'),'Keep experiment evidence');
    await downloadReport(client!,reportTask);
    await ipc('task:resume',reportTask.id);
    await waitFor(()=>{const current=taskStore!.get(reportTask.id)!; return current.runs.length > 1 && ['paused','blocked','awaiting-input'].includes(current.state);});
    await waitFor(()=>['paused','blocked','awaiting-input'].includes(taskStore!.get(reportTask.id)!.state));
    const builtTask = taskStore!.get(reportTask.id)!;
    const remoteRun = builtTask.runs.find(r=>r.role==='reporter' && r.executionLocation==='remote')!;
    assert.ok(remoteRun,JSON.stringify({error:builtTask.error,runs:builtTask.runs.map(r=>({state:r.state,error:r.error}))})); assert.equal(remoteRun.providerKey,'openai-default@offline'); assert.equal(remoteRun.codexPermissions,'full-access');
    assert.ok(remoteRun.remoteStartedAt); assert.ok(remoteRun.finishingCheck, builtTask.error);
    assert.equal(builtTask.report?.remoteSnapshotId,undefined,'no local-build upload to the reviewer');
    const reporterOutput = builtTask.workUnits.find(u=>u.id===remoteRun.workUnitId)!.output!;
    assert.match(reporterOutput, /<editorial-check>/); assert.match(reporterOutput, /<work-check>/);
    assert.equal(builtTask.workUnits[0].output,'Keep completed implementation'); assert.deepEqual(builtTask.goal,reportTask.goal);
    assert.equal(await readFile(builtTask.report!.texPath!,'utf8'),'Remotely completed report');
    assert.equal(builtTask.report!.storageLayout,'isolated');
    assert.equal(await readFile(join(remoteReportRoot(builtTask),'logs','experiment.log'),'utf8'),'Keep experiment evidence');
    assert.equal(await readFile(join(remoteReportRoot(builtTask),'report.pdf'),'utf8'),await readFile(builtTask.report!.pdfPath!,'utf8'));
    assert.equal(await readFile(join(remoteReportRoot(reportTask),'report.tex'),'utf8'),'Remotely completed report');
    const remoteReview = builtTask.runs.find(r=>r.role==='reviewer')!; assert.equal(remoteReview.executionLocation,'remote');
    assert.equal(remoteReview.skillUsage?.reads.find(s=>s.id==='script-reuse')?.calls, 1);
    const reviewInstructions = await readFile(join(workspace,'.agent-harness',builtTask.id,'runs',remoteReview.id,'instructions.txt'),'utf8');
    assert.ok(reviewInstructions.includes(remoteReportRoot(builtTask)));
    const reviewSkills = JSON.parse(await readFile(join(workspace,'.agent-harness',builtTask.id,'runs',remoteReview.id,'work-skills.json'),'utf8'));
    const writingSkill = reviewSkills.skills.find((s: {id: string})=>s.id==='writing-rules');
    assert.ok(writingSkill.content.includes(remoteRun.finishingSkill!.rules));
    assert.ok(writingSkill.content.includes(remoteRun.finishingSkill!.revision));
    assert.ok(!reviewSkills.skills.some((s: {id: string})=>s.id==='decision-memory'));
    assert.match(reviewInstructions,/get_skill/);
    for (const run of builtTask.runs.filter(r=>r.terminal)) {
      await ipc('terminal:close',builtTask.id,run.id); await waitFor(async()=>!(await ipc('terminal:snapshot',builtTask.id,run.id)).alive);
    }
    await ipc('task:delete',builtTask.id);
    // Missing MCP instructions must produce a resumable stop through the actual
    // remote hook/supervisor/PTY, without advancing the pending reporter.
    const failedDraft = await ipc('task:create',{workspaceMode:'remote',title:'MCP unavailable',prompt:'Keep goal and artifacts',cwd:directory,remoteSystemId:'offline',goalMode:'manual',strategy:'balanced',allowedAgentIds:['codex'],modelOverrides:{}});
    const failedGoal = await ipc('goals:save',failedDraft.id,{...failedDraft.goal,questions:[]},failedDraft.goal.revision,true);
    const failedWorker = {...failedGoal.workUnits[0],planPhase:false,primary:true,role:'worker',mode:'write',state:'pending',dependsOn:[]};
    const failedReporter = {...failedGoal.workUnits.find((u:any)=>u.role==='reporter'),dependsOn:[failedWorker.id]};
    await taskStore!.update(failedGoal.id,{state:'paused',resumeFromUnitId:failedWorker.id,workUnits:[failedWorker,failedReporter]});
    await writeFile(join(workspace,'.fixture-mcp-failure'),'fixture only');
    for (let attempt=1; attempt<=2; attempt++) {
      await ipc('task:resume',failedGoal.id);
      await waitFor(()=>{const t=taskStore!.get(failedGoal.id)!;return t.runs.length===attempt && t.state==='paused';});
      const stopped=taskStore!.get(failedGoal.id)!;
      assert.match(stopped.error!,/MCP接続・指示取得/);
      assert.equal(stopped.resumeFromUnitId,failedWorker.id);
      assert.deepEqual(stopped.goal,failedGoal.goal);
      assert.equal(stopped.workUnits[1].state,'pending');
      const r=stopped.runs.at(-1)!;
      assert.equal(r.state,'failed'); assert.equal((await ipc('terminal:snapshot',stopped.id,r.id)).inputAllowed,false);
      await assert.rejects(async()=>ipc('terminal:input',stopped.id,r.id,'/login\r'),/終了した担当/);
      await assert.rejects(readFile(join(workspace,'.agent-harness',stopped.id,'active.lock','owner.json')));
      await ipc('terminal:close',stopped.id,r.id);
      await waitFor(async()=>!(await ipc('terminal:snapshot',stopped.id,r.id)).alive);
      await waitFor(async()=>!(await ipc('app:snapshot')).queue.activeTaskIds.includes(stopped.id));
    }
    await rm(join(workspace,'.fixture-mcp-failure'));
    await ipc('task:delete',failedGoal.id);
    // Reconnection can be cancelled without resetting the failed workflow.
    await ipc("remote:disconnect", "offline");
    await waitFor(async () => !(await ipc("remote:snapshot", "offline"))?.alive);
    const disconnectedBefore = JSON.stringify(taskStore!.get(recovery.id));
    emitted.length = 0;
    const recoveryConnecting = ipc("task:recovery", recovery.id, "inspect");
    const recoveryCancelled = assert.rejects(recoveryConnecting, /SSH認証を取り消しました/);
    await waitFor(() => emitted.some(e => e.name === "remote:auth-required"));
    await ipc("remote:task-cancel", recovery.id); await recoveryCancelled;
    assert.equal(JSON.stringify(taskStore!.get(recovery.id)), disconnectedBefore);
    await ipc("task:delete", recovery.id);
    emitted.length = 0;
    const waiting = [];
    for (let i = 0; i < 2; i++) waiting.push(await ipc("task:create", { workspaceMode: "remote", title: `未接続キュー${i}`, prompt: "遠隔でゴールを整理", cwd: "/ignored", remoteSystemId: "offline", goalMode: "ai", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {} }));
    await ipc("queue:start");
    await waitFor(() => emitted.some(e => e.name === "remote:auth-required"));
    const auth = emitted.find(e => e.name === "remote:auth-required")!.value;
    assert.equal(auth.taskId, waiting[0].id);
    await ipc("remote:task-connect", auth.taskId);
    await ipc("remote:task-cancel", auth.taskId);
    await waitFor(async () => !(await ipc("app:snapshot")).queue.running);
    await waitFor(async () => !(await ipc("remote:snapshot", "offline"))?.alive);
    for (const entry of waiting) {
      const saved = (await ipc("app:snapshot")).tasks.find((t: TaskRecord) => t.id === entry.id);
      assert.equal(saved.state, "blocked"); assert.equal(saved.runs.length, 0);
      assert.match(saved.error, entry.id === waiting[0].id ? /取り消しました/ : /作業ディレクトリが重なっています/);
    }
    assert.equal(emitted.filter(e => e.name === "remote:auth-required").length, 1);
    // Different workspaces can start together, but their authentication dialogs
    // are serialized. Cancelling one does not cancel the other task.
    const defaultProfile = { id: "offline-other", name: "Other offline cluster", host: "other-not-a-network-host", cwd: join(remote, "other"), nodeCommand: process.execPath, texCommand: "latexmk", startup: "", instructions: "No execution in this test" };
    await assert.rejects(ipc("remote:save", defaultProfile), /リスク確認/);
    assert.ok(!(await ipc("remote:list")).some((p: any) => p.id === defaultProfile.id));
    await ipc("remote:save", defaultProfile, true);
    const other = await ipc("task:create", { workspaceMode: "remote", title: "別接続の認証", prompt: "ゴール整理", cwd: "/ignored", remoteSystemId: "offline-other", goalMode: "ai", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {} });
    assert.equal(other.remote.codexPermissions, "full-access");
    emitted.length = 0;
    const firstAuth = assert.rejects(ipc("task:run", waiting[0].id), /取り消しました/);
    await waitFor(() => emitted.some(e => e.name === "remote:auth-required"));
    const secondAuth = assert.rejects(ipc("task:run", other.id), /取り消しました/);
    await waitFor(async () => (await ipc("app:snapshot")).queue.activeTaskIds.length === 2);
    assert.equal(emitted.filter(e => e.name === "remote:auth-required").length, 1);
    await ipc("remote:task-cancel", waiting[0].id); await firstAuth;
    await waitFor(() => emitted.some(e => e.name === "remote:auth-required" && e.value.taskId === other.id));
    assert.ok((await ipc("app:snapshot")).queue.activeTaskIds.includes(other.id));
    await ipc("remote:task-cancel", other.id); await secondAuth;
    await ipc("task:delete", other.id);
    if (prepared) {
      emitted.length = 0;
      const snapshotTask = (await ipc("app:snapshot")).tasks.find((t: TaskRecord) => t.id === task.id);
      const reopening = ipc("goals:refine", task.id, "再接続先の検証", snapshotTask.goal.revision);
      const rejected = assert.rejects(reopening, /取り消しました/);
      await waitFor(() => emitted.some(e => e.name === "remote:auth-required"));
      await ipc("remote:task-connect", task.id);
      // The reconnect starts at the first host's cwd, not the recorded final cwd.
      await ipc("remote:input", "offline", "printf '\\nRECONNECTED_SHELL_READY\\n'\r");
      await waitFor(async () => (await ipc("remote:snapshot", "offline")).data.includes("\r\nRECONNECTED_SHELL_READY\r\n"));
      await assert.rejects(ipc("remote:task-ready", task.id), /保存された接続先設定/);
      assert.equal((await ipc("app:snapshot")).tasks.find((t: TaskRecord) => t.id === task.id).runs.length, snapshotTask.runs.length);
      await ipc("remote:task-cancel", task.id); await rejected;
    }
  } finally {
    // A failed reconnect assertion must not leave the fixture's tmux CLI alive.
    if (tmux && taskStore!) for (const task of taskStore!.list()) for (const run of task.runs) if (run.remoteSession) {
      const runDirectory=join(workspace,".agent-harness",task.id,"runs",run.id);
      await writeFile(join(runDirectory,"stop.json"),JSON.stringify({token:run.remoteSession.token})).catch(()=>{});
      const helper=require("./tmux-session");
      for (let i=0;i<80;i++) {
        try { await helper.closeTmuxSession(join(runDirectory,"launch.json")); break; } catch {}
        await new Promise(r=>setTimeout(r,25));
      }
    }
    JsonTaskStore.prototype.init = originalInit;
    events.get("before-quit")?.(); client?.close(); RemoteClient.create = originalCreate; PreparedRemoteClient.create = originalPreparedCreate;
    await new Promise(r => setTimeout(r, 250));
    await rm(directory, { recursive: true, force: true });
  }
});
