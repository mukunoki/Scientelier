import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FollowupInput, TaskRecord } from "./types";
import { defaultExecution, validateExecution } from "./execution-policy";
import { researchOperation, type ResearchContext } from "./research-cycle";
import { qualityOperation, type QualityContext } from "./quality";
import { workspaceOperation, type WorkspaceContext } from "./implementation-workspaces";
import { JsonTaskStore } from "./task-store";
import type { TerminalControl } from "./terminal-runner";

// Exercise the real IPC/workflow/store/report paths. No external CLI or network is used.
test(process.env.HARNESS_WRITING_RULES_TEST_ONLY === "1"
  ? "workflow IPC delivers canonical writing rules and role-specific skill references"
  : "workflow IPC supports approval, iteration, saved intervention, pause, versions and completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-workflow-integration-"));
  const templates = require("../../scripts/report-template-fixture.cjs").reportTemplateFixture(directory);
  const RealReportService = require("./report-service").ReportService;
  require("./report-service").ReportService = class extends RealReportService {
    constructor() { super(templates, join(process.cwd(), "assets", "document-templates")); }
  };
  let fixtureStore: JsonTaskStore;
  const originalStoreInit=JsonTaskStore.prototype.init;
  JsonTaskStore.prototype.init=async function(){await originalStoreInit.call(this);fixtureStore=this;};
  const handlers = new Map<string, (...args: any[]) => any>();
  const appEvents = new Map<string, () => void>();
  let windowCount = 0, windowFocused = 0, windowRestored = 0;
  const calls: Array<{ prompt: string; mode: string; model?: string; codexPermissions?: string; continueSession?: string; skillContents?: Record<string, string> }> = [];
  let planNext = false, holdSubtasks = false, specialistActive = 0, specialistPeak = 0;
  let expectedSpecialistPeak: number | undefined;
  let separatedReportPrerequisites = false;
  let refinementPlanNext = false;
  let earlyPlanNext = false, earlyPeak=0;
  const earlyActive = new Set<string>();
  let livePlanNext = false;
  let holdPlanNext = false, releasePlan: (()=>void) | undefined;
  let observeSkillsNext = false;
  let primaryMilestonesNext = false, primaryMilestonesSeen = 0;
  let requirementPlanNext: "legacy" | "family" | "skill" | undefined;
  let failIndependentOnce = false;
  let researchWorkflowId: string | undefined, omitResearchCritique = false;
  let coordinatorAddNext = false, coordinatorAdjustNext = false;
  let implementationTaskId: string | undefined, implementationActive=0, implementationPeak=0;
  let specialistFailure = false;
  let retirementFailure = false;
  let denySpecialistAdmission = false;
  let quotaEverySpecialist = false;
  const terminalSnapshots = new Map<string,{alive:boolean;inputAllowed:boolean}>();
  let crossActive = 0, crossPeak = 0;
  let planReplyNext: "invalid" | "bad-estimate" | "ask-user" | undefined;
  let persistentInvalidPlan = false;
  let reviseNext = false;
  const heldSubtasks = new Map<string, (cancelled: boolean) => void>();
  const workerSources = new Set<string>();
  let holdNext = false;
  let invalidGoalNext = false;
  let reviewResults: string[] = [];
  let useResultChannel = false;
  let missingReviewMarkerOnce = false;
  let missingEnvironmentMarkerOnce = false;
  let reviewConcerns: string[][] = [];
  let reportCorrections: string[][] = [];
  let standardContentTaskId:string|undefined, contentContinueOnce=false, contentPeerFailure=false;
  let mutateSecondReview = false;
  let checkResults: string[] = [];
  let failRoleOnce: string | undefined;
  let quotaRoleOnce: string | undefined;
  let nativeFailureRoleOnce: string | undefined;
  let omitDocumentOnce = false;
  let omitEditorialOnce = false;
  let missingReportPrerequisites = 0;
  let qualityFailureNext: "work"|"document"|"substantive"|undefined;
  let held: (() => void) | undefined;
  let exportDialogResult: { canceled: boolean; filePath?: string } = { canceled: true };
  let lessonDialogFiles: string[] = [];
  let promoteResponse = 0;
  let lastQueue: { activeTaskIds: string[] } | undefined;
  const electronId = require.resolve("electron");
  require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: {
    app: { setName: () => {}, setPath: () => {}, setAboutPanelOptions: () => {}, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), getPath: () => directory, getAppPath: () => process.cwd(),
      on: (name: string, listener: () => void) => appEvents.set(name, listener) },
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
    ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
    dialog: { showSaveDialog: async () => exportDialogResult, showOpenDialog: async () => ({canceled:false,filePaths:lessonDialogFiles}), showMessageBox: async () => ({response:promoteResponse}) },
    BrowserWindow: class {
      constructor() { windowCount++; }
      isMinimized() { return true; } restore() { windowRestored++; }
      show() {} focus() { windowFocused++; }
      webContents = { send(name: string, value: any) { if (name === "queue:changed") lastQueue = value; }, setWindowOpenHandler() {}, on() {} }; isDestroyed() { return false; }
      loadFile() { return Promise.resolve(); } on() {} static getAllWindows() { return []; }
    }
  } } as NodeModule;
  require("./cli-detect").detectAgents = async () => ["codex", "claude", "antigravity"].map((id) => ({ id, label: id, command: id, executable: "/fake", installed: true }));
  require("./capacity-probes").readCodexCapacity = async () => ({ limited: false });
  require("./claude-capacity").readClaudeCapacity = async () => ({ limited: false });
  require("./report-service").checkReportEnvironment = async () => ({ tex: { ok: true }, plot: { ok: true }, checkedAt: new Date().toISOString() });
  require("./adapters").buildInvocation = (_agent: unknown, input: object) => ({ command: "fake", args: [JSON.stringify(input)], cwd: directory });
  const actualSelectAgent = require("./orchestration").selectAgent;
  require("./orchestration").selectAgent = (input: any) => denySpecialistAdmission && input.unit.subtask ? undefined : actualSelectAgent(input);
  // Legacy scenarios retain their captured graph/counts. Dedicated scenarios
  // below capture the NEW default through the actual plan/workflow functions.
  const actualContentCapture=require("./content-cycle").contentCycleForPlan;
  require("./content-cycle").contentCycleForPlan=(task:TaskRecord,owner:any)=>task.id===standardContentTaskId?actualContentCapture(task,owner):undefined;
  require("./terminal-runner").TerminalRunner = class {
    snapshot(id:string) { return terminalSnapshots.get(id); }
    async run(_id: string, spec: { args: string[]; cwd: string }, emit: (event: object) => void, control: TerminalControl) {
      if (control?.agentId === "claude" || control?.agentId === "antigravity")
        assert.deepEqual(control.workspaceTrust, { agent: control.agentId, directory: spec.cwd }, "every role binds trust to its actual launch cwd");
      else assert.equal(control?.workspaceTrust, undefined, "other CLIs/login shells never inherit screen-based approval");
      const input = JSON.parse(spec.args[0]); calls.push(input);
      if(contentPeerFailure && input.prompt.includes("# Your role: 内容点検 ·")) {
        contentPeerFailure=false;return {stdout:"",stderr:"fixture advisory CLI failure",exitCode:1,signal:null};
      }
      if(process.env.HARNESS_MESSAGES_TEST_ONLY==="1") {
        if(input.messages) {
          const dir=input.resultCommand.at(-2),token=input.resultCommand.at(-1);
          const {messageOperation}=require("./agent-messages");
          if(input.prompt.includes("You are a read-only specialist")) await messageOperation(dir,token,"send",{to:"lead",kind:"finding",text:"一次資料の境界条件を統合時に確認してください。"});
          else if(input.prompt.includes("# Lead-owned execution plan") && !input.prompt.includes("INITIAL OR REQUIRED REPLAN")) {
            const inbox=await messageOperation(dir,token,"read");assert.ok(inbox.messages.length>0,"main relay must deliver the queued specialist finding before integration");
          }
        } else if(input.prompt.includes("# Your role: Review")) assert.equal(input.messages,false,"blind reviews must have no messenger");
      }
      const earlyRole=input.prompt.match(/# Your role: Early (environment|alternative|challenge|apply|benchmark)\n/)?.[1];
      if(earlyRole) {
        if(["apply","benchmark"].includes(earlyRole)) assert.equal(earlyActive.size,0,"synthesis and measurement drain every peer");
        earlyActive.add(earlyRole);earlyPeak=Math.max(earlyPeak,earlyActive.size);
        if(["alternative","challenge"].includes(earlyRole)) {
          assert.equal(input.mode,"read");assert.equal(input.quality,false);assert.equal(input.workspace,false);assert.equal(input.research,false);assert.equal(input.hpc,false);
          assert.notEqual(input.cwd,directory);assert.match(input.cwd,/agent-harness-handoff-/);
          assert.doesNotMatch(input.prompt,/Workspace:|# Working report|Context manifest/);
          assert.ok(!input.additionalDirectories.includes(directory));
        }
        await new Promise(resolve=>setTimeout(resolve,200));
        earlyActive.delete(earlyRole);
      }
      const workspace: WorkspaceContext | undefined = input.workspace && input.resultCommand
        ? JSON.parse(await readFile(join(input.resultCommand.at(-2),"workspace-context.json"),"utf8")).context : undefined;
      const implementationFixture = workspace?.taskId === implementationTaskId && !!implementationTaskId;
      const fixtureEvidence = implementationFixture ? join(workspace!.root,"evidence.txt") : join(directory,"evidence.txt");
      // Capture the real per-run payload before cleanup. Protocol/access checks
      // are exercised separately; this fixture must not alter channel state.
      if (input.resultCommand) {
        const bundle = JSON.parse(await readFile(join(input.resultCommand.at(-2), "work-skills.json"), "utf8"));
        if (process.env.HARNESS_METRICS_TEST_ONLY === "1") {
          await require("./channel-state").recordChannelState(input.resultCommand.at(-2),input.resultCommand.at(-1),"instructions-read");
          await new Promise(resolve=>setTimeout(resolve,3));
          await writeFile(join(input.resultCommand.at(-2),"usage.json"), JSON.stringify({token:bundle.token,usage:{source:"reported",inputTokens:120,outputTokens:30}}));
          await writeFile(join(input.resultCommand.at(-2),"runtime-identity.json"),JSON.stringify({token:bundle.token,identity:{source:"native-session",
            sessionId:"fixture-current",models:["gpt-fixture"],observedAt:new Date().toISOString()}}));
        }
        assert.equal(bundle.token, input.resultCommand.at(-1));
        input.skillContents = Object.fromEntries(bundle.skills.map((s: { id: string; content: string }) => [s.id, s.content]));
        if (/内容改善の検討|内容改善の採否・実作業への反映/.test(input.prompt)) {
          await require("./channel-state").recordChannelState(input.resultCommand.at(-2), bundle.token, "instructions-read");
          assert.equal(await require("./result-channel").readRunSkill(input.resultCommand.at(-2), bundle.token, { id: "content-refinement" }), input.skillContents["content-refinement"]);
        }
        if (observeSkillsNext && input.skillContents["script-reuse"]) {
          observeSkillsNext = false;
          await require("./channel-state").recordChannelState(input.resultCommand.at(-2), input.resultCommand.at(-1), "instructions-read");
          for (const id of ["script-reuse", "document-checks", "related-research", "writing-rules"]) {
            const content = await require("./result-channel").readRunSkill(input.resultCommand.at(-2), input.resultCommand.at(-1), {id});
            assert.equal(content, input.skillContents[id], "get_skill must return this run's exact saved content");
          }
        }
      } else if (input.additionalDirectories?.length) {
        const root = join(input.additionalDirectories.at(-1), "skills");
        input.skillContents = {};
        for (const file of await readdir(root)) input.skillContents[file.replace(/\.md$/, "")] = await readFile(join(root,file), "utf8");
        if (input.skillContents["script-reuse"]) assert.ok(input.prompt.includes(join(root,"script-reuse.md")));
        assert.doesNotMatch(input.prompt, /agent_harness\.get_skill/);
      }
      if (holdPlanNext && input.prompt.includes("INITIAL OR REQUIRED REPLAN")) {
        holdPlanNext=false;await new Promise<void>(resolve=>{releasePlan=resolve;});releasePlan=undefined;
      }
      if (failIndependentOnce && input.prompt.includes("# Your role: Independent B fixture\n")) {
        failIndependentOnce=false;planReplyNext="ask-user";
        return {stdout:"Legacy B was assigned the same model",stderr:"fixture",exitCode:1,signal:null};
      }
      if (input.prompt.includes("ONE bounded implementation/experiment/writing milestone")) {
        assert.equal(input.mode, "write"); assert.equal(specialistActive, 0);
        assert.doesNotMatch(input.prompt, /# Lead-owned execution plan|# Read-only delegated work/);
        primaryMilestonesSeen++;
      }
      if (input.codingPlan) {
        assert.equal(input.model, input.codingPlan === "ollama-app" ? "ollama/deepseek-v4.1-flash:cloud" : input.codingPlan === "ollama" ? "ollama-cloud/gpt-oss:120b" : "zai-coding-plan/glm-5.3");
        assert.ok(input.resultCommand && input.openCodePluginPath);
        assert.match(await readFile(input.openCodePluginPath, "utf8"), /session.idle/);
        const completion = JSON.parse(await readFile(join(dirname(input.openCodePluginPath), "completion-command.json"), "utf8"));
        assert.equal(completion.command.at(-3), "opencode");
        assert.match(input.launchPrompt, /get_instructions/);
        assert.doesNotMatch(input.prompt, /Notification file:/);
      }
      if (input.prompt.includes("You are a read-only specialist")) {
        assert.equal(input.mode, "read"); assert.equal(input.continueSession, undefined);
        specialistActive++; specialistPeak = Math.max(specialistPeak, specialistActive);
        // Assert actual overlap, not an arbitrary 100ms window that can expire
        // while the sibling is still preparing Git/PTY files on a busy machine.
        if (expectedSpecialistPeak) await waitFor(()=>specialistPeak>=expectedSpecialistPeak!,10000);
        let cancelled = false;
        if (holdSubtasks) cancelled = await new Promise<boolean>(resolve => heldSubtasks.set(_id, resolve));
        else await new Promise(resolve => setTimeout(resolve, 100));
        heldSubtasks.delete(_id); specialistActive--;
        if (cancelled) return { stdout: "partial research", stderr: "", exitCode: null, signal: "SIGTERM" };
        if (retirementFailure) {
          retirementFailure=false;
          return {stdout:"authentication_failed",stderr:"stop not confirmed",exitCode:1,signal:null,stopUnconfirmed:true,processId:process.pid,
            handoff:{status:"blocked",summary:"前の担当の停止確認に失敗しました。"}};
        }
        if (specialistFailure) { specialistFailure = false; return { stdout: "failed research", stderr: "fixture", exitCode: 1, signal: null }; }
        if (quotaEverySpecialist) return { stdout: "Preserve partial investigation", stderr: "", exitCode: 0, signal: null,
          handoff: { status: "rate-limited", summary: "Quota exhausted; investigation remains incomplete." } };
      }
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => { held = resolve; }); held = undefined;
        return { stdout: "Paused partial work", stderr: "", exitCode: null, signal: "SIGTERM" };
      }
      if(implementationFixture && input.prompt.includes("ONE isolated package")) {
        assert.equal(input.mode,"write");assert.equal(input.continueSession,undefined);
        assert.equal(input.quality,false);assert.equal(workspace!.manage,false);
        const ledger=await workspaceOperation({...workspace!,manage:true},{action:"snapshot"});
        const w=ledger.workspaces.find((w:any)=>w.id===workspace!.actor)!;
        assert.equal(input.cwd,w.path);assert.notEqual(input.cwd,workspace!.root);
        implementationActive++;implementationPeak=Math.max(implementationPeak,implementationActive);
        await writeFile(join(input.cwd,w.files[0]),`${w.files[0]} implemented\n`);
        // Start-up includes real Git worktree/RPC preparation. A fixed 250ms
        // mock can finish before its sibling reaches the CLI on a busy Mac.
        // Latch both actual starts; sequential admission must still time out.
        await waitFor(()=>implementationPeak===2,10000);implementationActive--;
      } else if(implementationFixture && workspace!.manage) {
        assert.equal(implementationActive,0,"shared integration must drain every isolated writer");
        const command:string[]=input.resultCommand;
        const rpc=async(request:object)=>{
          const child=spawn(command[0],command.slice(1));let out="";child.stdout.on("data",b=>out+=b);
          child.stdin.end(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"workspace_manage",arguments:{request}}})+"\n");
          assert.equal(await new Promise(r=>child.on("close",r)),0);
          const result=JSON.parse(out).result;assert.ok(!result.isError,out);return JSON.parse(result.content[0].text);
        };
        const ledger=await rpc({action:"snapshot"});
        for(const w of ledger.workspaces.filter((w:any)=>w.state==="active")) {
          const view=await rpc({action:"inspect",id:w.id});assert.match(view.diff,/implemented/);
          await rpc({action:"merge",id:w.id,digest:view.digest,reason:"Verified fixture diff and source checks; run shared regression next"});
        }
      }
      if (input.prompt.includes("You own the substantive research/analysis/implementation")) {
        const source = input.prompt.match(/The (?:IPSJ SIG Technical Report|Beamer learning slide) TeX source is at (.+?)\. The worker/)[1];
        await writeFile(source, "Worker subject-content TeX"); workerSources.add(source);
      }
      if (input.prompt.includes("# TeX build instructions")) {
        const source = input.prompt.match(/Report source: (.+)/)[1];
        if (workerSources.has(source)) {
          assert.equal(await readFile(source, "utf8"), "Worker subject-content TeX", "worker content must survive checkpoint and report preparation");
          workerSources.delete(source);
        }
        await writeFile(source, `${input.prompt.includes("# Paper understanding lesson") ? "\\documentclass{beamer}\n" : ""}Report revision ${calls.length}`);
        await writeFile(source.replace(/\.tex$/, ".pdf"), `%PDF-1.7\nTest revision ${calls.length}`);
        const targets = JSON.parse(input.prompt.match(/# Additional document build targets\n\n([^\n]+)/)[1]);
        const skip = omitDocumentOnce; omitDocumentOnce = false;
        for (const document of Object.values(targets) as any[]) {
          if (skip) continue;
          await writeFile(document.texPath, "Verified extra subject content");
          await writeFile(document.pdfPath, `%PDF-1.7\nAdditional revision ${calls.length}`);
        }
      }
      const role = input.prompt.includes("# TeX build instructions") ? "reporter" : input.prompt.includes("# Required structured goal review") ? "reviewer" : input.prompt.includes("You own the substantive research/analysis/implementation") ? "worker" : "planner";
      // The fake agent uses the real scoped engine. Stable evidence lets unchanged
      // checks survive retries, while production gates remain enabled in this test.
      if(input.quality){
        const control=input.resultCommand?.at(-2)??input.additionalDirectories?.at(-1);
        const {context:q}:{context:QualityContext}=JSON.parse(await readFile(join(control,"quality-context.json"),"utf8"));
        if(q.write)for(const spec of q.specs.filter(s=>q.allowedStages.includes(s.stage))){
          const evidence=`quality-fixture-${spec.id}.txt`;
          await writeFile(join(q.root,evidence),`Verified fixture for ${spec.id}`);
          await qualityOperation(q,{action:"plan",id:spec.id,plan:{method:"manual",procedure:"Verify isolated fixture evidence",targets:[evidence]}});
          const fail=qualityFailureNext && (q.domain==="work"?qualityFailureNext==="work":qualityFailureNext!=="work");
          await qualityOperation(q,{action:"record",id:spec.id,status:fail?"fail":"pass",detail:fail?"Missing verification fixture":"Verified fixture evidence",evidence:[evidence],...(fail?{repairOwner:qualityFailureNext==="document"?"reporter":"worker"}:{})});
          if(fail)qualityFailureNext=undefined;
        }
      }
      if (input.mode === "write" || role === "reporter") {
        assert.match(input.prompt, /# Mandatory report writing rules:/, "every write-capable route receives the writing rules");
        assert.match(input.prompt, /Captured writing rule revision:/);
      }
      if (failRoleOnce === role) { failRoleOnce = undefined; return { stdout: "Interrupted partial work", stderr: "CLI exit fixture", exitCode: 143, signal: null }; }
      if (nativeFailureRoleOnce === role) {
        nativeFailureRoleOnce=undefined;
        await writeFile(join(directory,"capacity-partial.txt"),"Preserve verified partial artifact");
        return {stdout:"Selected model is at capacity",stderr:"",exitCode:0,signal:null,
          handoff:{status:"blocked",summary:"モデルが一時的に混雑しています。",failure:{kind:"capacity",summary:"モデルが一時的に混雑しています。"}}};
      }
      if (quotaRoleOnce === role) {
        quotaRoleOnce=undefined;
        await writeFile(join(directory,"quota-partial.txt"),"Preserve verified partial artifact");
        return {stdout:"Partial artifact saved",stderr:"",exitCode:0,signal:null,
          handoff:{status:"rate-limited",summary:"Quota exhausted; partial artifact quota-partial.txt saved. Remaining: finish verification."}};
      }
      let stdout = "Mock response: verified decisions and findings.\n";
      if (input.prompt.includes("# Your role: Refinement alternative\n")) stdout = "REFINEMENT_ALTERNATIVE: compare a simpler mechanism under the approved test.";
      if (input.prompt.includes("# Your role: Refinement challenge\n")) stdout = "REFINEMENT_CHALLENGE: verify the edge case before adopting the change.";
      if(input.prompt.includes("# Your role: 内容点検 ·")) {
        assert.equal(input.mode,"read");assert.equal(input.continueSession,undefined);
        stdout="CONTENT_READER: Explain the exponent representation and compare the bottleneck alternative using existing evidence.";
      }
      if (input.prompt.includes("initial, read-only ideation phase")) {
        assert.equal(input.mode, "read"); assert.equal(input.continueSession, undefined);
        stdout = "IDEA_HANDOFF_FIXTURE: provisional hypothesis, alternative, rejection condition and minimal test.";
      }
      if (role === "reporter") {
        const requirement = JSON.parse(input.prompt.match(/Editorial check requirements: ([^\n]+)/)[1]);
        if (!omitEditorialOnce) stdout = `<editorial-check>${JSON.stringify({ revision: requirement.revision, status: "completed", summary: "Repetition removed; facts and citations preserved; final output checked", sources: requirement.requiredSources, concerns: [] })}</editorial-check>`;
        if (missingReportPrerequisites > 0) {
          missingReportPrerequisites--;
          const prerequisites=["全6文献の一次資料・異種AI二重照合が未完了。資料取得と独立担当の配置が必要。"];
          stdout = `<editorial-check>${JSON.stringify({ revision: requirement.revision, status: separatedReportPrerequisites ? "completed" : "blocked", summary: "PDF built; primary source verification remains", sources: requirement.requiredSources,
            concerns: separatedReportPrerequisites ? [] : prerequisites, ...(separatedReportPrerequisites ? {prerequisites} : {}) })}</editorial-check>`;
          separatedReportPrerequisites=false;
        }
        omitEditorialOnce = false;
      }
      if (input.prompt.includes("goal preparation ONLY") && !invalidGoalNext) stdout = `<goal-draft>${JSON.stringify({
        objective: "FP4の表現範囲を説明する", deliverables: ["IPSJ形式のTeXとPDF"],
        criteria: [{ id: "range", description: "表現可能値を列挙する", verification: "独立した数値計算と照合する", required: true }],
        constraints: ["元データは変更しない"], outOfScope: ["他の浮動小数点形式の網羅"], questions: []
      })}</goal-draft>`;
      if (input.prompt.includes("goal preparation ONLY") && input.prompt.includes("# Paper understanding lesson")) {
        const source = input.prompt.match(/Current draft: (\{[^\n]+\})/)?.[1];
        assert.ok(source);
        const draft = JSON.parse(source);
        draft.lesson.topics = [{id:"background",title:"計算の背景",reason:"原論文の手法を理解する前提",dependsOn:[],recommended:"foundation",depth:"foundation"}];
        stdout = `<goal-draft>${JSON.stringify({...draft,questions:[]})}</goal-draft>`;
      }
      invalidGoalNext = false;
      if (input.prompt.includes('Return exactly one <work-check>')) {
        const result = checkResults.shift() ?? "ready";
        const reportSource = input.prompt.match(/The (?:IPSJ SIG Technical Report|Beamer learning slide) TeX source is at (.+?)\. The worker/)?.[1];
        stdout = result === "invalid" ? "No structured checkpoint" : `<work-check>${JSON.stringify({ status: result === "sandbox-denied" ? "needs-work" : result, summary: result === "sandbox-denied" ? "bwrap: setting up uid map: Permission denied" : "Worker progress checked", remainingWork: result === "ready" ? "" : result === "report-ready" ? "Compile PDF and inspect all pages" : "Resolve missing substantive work", estimatedRemainingMinutes: 5, evidence: [result === "report-ready" ? reportSource : implementationFixture ? fixtureEvidence : join(directory, "tasks.json")] })}</work-check>`;
        if (result === "path-prose") stdout = `<work-check>${JSON.stringify({status:"ready",summary:"Preserve this substantive uncertainty",remainingWork:"PDF and review still required",estimatedRemainingMinutes:5,evidence:[join(directory,"tasks.json")+" : 全criterion ID別の証拠"]})}</work-check>`;
        if (result === "environment-blocked") stdout = `<work-check>${JSON.stringify({status:result,summary:"必須GPUが利用できない",remainingWork:"GPU実測",estimatedRemainingMinutes:0,evidence:[],
          blocker:{kind:"hardware",summary:"必須のMetalデバイスを取得できません。",recovery:"実行権限を確認し、同じ工程から再開してください。",check:"MTLCreateSystemDefaultDevice() == nil"},
          workReport:{activities:Array(12).fill("測定".repeat(700))}})}</work-check>`;
      }
      if(input.prompt.includes("# 主担当の内容点検・終了判断") && stdout.startsWith("<work-check>")) {
        const value=JSON.parse(stdout.slice("<work-check>".length,-"</work-check>".length));
        value.contentDecision={decision:contentContinueOnce?"continue":"finish",explanation:"表現の定義を根拠に沿って確認・補足",improvement:"代案を比較し、費用と副作用を確認して採否を判断"};
        if(contentContinueOnce){value.status="needs-work";value.remainingWork="承認範囲の一つの改善を小例で確認";contentContinueOnce=false;}
        stdout=`<work-check>${JSON.stringify(value)}</work-check>`;
      }
      if (input.prompt.includes("# Required structured goal review")) {
        if (input.prompt.includes("# Blind independent review") || input.prompt.includes("# Cross-service review") || input.prompt.includes("# Review consolidation")) {
          crossActive++; crossPeak = Math.max(crossPeak, crossActive);
          await new Promise(resolve => setTimeout(resolve, 120)); crossActive--;
        }
        if (mutateSecondReview && input.prompt.includes("連続合格確認 2/2")) {
          mutateSecondReview = false;
          const source = input.prompt.match(/Report source: (.+)/)?.[1];
          if (source) await writeFile(source.replace(/\.tex$/, ".pdf"), "%PDF-1.7\nChanged during review");
          else await writeFile(join(directory, "evidence.txt"), "Changed during second review");
        }
        const goal = JSON.parse(input.prompt.match(/# User-approved goal[^\n]*\n([^\n]+)/)[1]);
        const revision = Number(input.prompt.match(/# User-approved goal \(revision (\d+)\)/)[1]);
        const result = reviewResults.shift() ?? "pass";
        stdout = result === "invalid" ? "I am done without a structured review." : `<goal-evaluation>${JSON.stringify({ goalRevision: revision,
          criteria: goal.criteria.map((c: any) => ({ criterionId: c.id, status: result === "ask-user" ? "unverified" : result, detail: "Fixture verification", evidence: result === "pass" ? [{ path: fixtureEvidence, detail: "Fixture output checked" }] : [] })),
          ...(result === "missing-concerns" ? {} : { concerns: reviewConcerns.shift() ?? [] }), reportCorrections:reportCorrections.shift()??[], nextAction: result === "ask-user" ? "ask-user" : "repair", repairInstructions: result === "pass" ? "" : "Correct the required output", summary: "Fixture review" })}</goal-evaluation>`;
      }
      if (input.prompt.includes("INITIAL OR REQUIRED REPLAN")) {
        const goal = JSON.parse(input.prompt.match(/# User-approved goal[^\n]*\n([^\n]+)/)[1]);
        stdout = `<execution-plan>${JSON.stringify({ summary: "Primary leads concrete work", reason: "Initial plan or recover failed investigation", primaryWork: "Create substantive TeX and evidence", acceptance: "Verify sources and output", criterionIds: goal.criteria.map((c: any) => c.id), estimatedTokens: 8000, estimatedMinutes: 20, escalation: "Ask user for new authority",
          tasks: planNext || livePlanNext ? (livePlanNext ? ["a", "b", "c", "d"] : ["a", "b"]).map(key => ({ key, title: `Research ${key}`, instructions: `Inspect ${key} independently`, deliverable: `Findings ${key}`, acceptance: "Verify sources", criterionIds: [goal.criteria[0].id], dependsOn: [], estimatedTokens: 1000, estimatedMinutes:2 })) : [] })}</execution-plan>`;
        planNext = false;
        livePlanNext = false;
        if (refinementPlanNext) {
          refinementPlanNext = false;
          const plan = JSON.parse(stdout.slice('<execution-plan>'.length, -'</execution-plan>'.length));
          const packageFor = (key: string, kind: string, dependsOn: string[]) => ({ key, kind, title: `Refinement ${key}`, instructions: `Approved bounded ${key}`, deliverable: "Concrete improvement with evidence", acceptance: "Verify approved tests", criterionIds: plan.criterionIds, estimatedTokens: 1000, estimatedMinutes: 2, dependsOn });
          plan.tasks = [packageFor("initial", "primary-work", []), packageFor("alternative", "investigation", ["initial"]), packageFor("challenge", "investigation", ["initial"]), packageFor("apply", "primary-work", ["alternative", "challenge"])];
          plan.refinement = { objective: "Improve one coupled mechanism using independent suggestions", proposalKeys: ["alternative", "challenge"], applicationKey: "apply", stopWhen: "Approved tests pass and no useful affordable change remains" };
          stdout = `<execution-plan>${JSON.stringify(plan)}</execution-plan>`;
        }
        if(earlyPlanNext) {
          earlyPlanNext=false;
          const plan=JSON.parse(stdout.slice('<execution-plan>'.length,-'</execution-plan>'.length));
          const packageFor=(key:string,kind:string,dependsOn:string[])=>({key,kind,title:`Early ${key}`,instructions:`Supplied neutral problem: compare two bounded approaches; ${key} owns only its assigned perspective`,deliverable:"Useful bounded findings",acceptance:"Check assumptions and evidence",criterionIds:plan.criterionIds,estimatedTokens:1000,estimatedMinutes:2,dependsOn});
          plan.tasks=[{...packageFor("environment","primary-work",[]),allowTaskOnlyPeers:true},
            {...packageFor("alternative","investigation",[]),inputScope:"assignment"}, {...packageFor("challenge","investigation",[]),inputScope:"assignment"},
            packageFor("apply","primary-work",["environment","alternative","challenge"]),packageFor("benchmark","primary-work",["apply"])];
          plan.refinement={objective:"Improve a coupled problem from early independent ideas",proposalKeys:["alternative","challenge"],applicationKey:"apply",stopWhen:"Required checks complete; no useful optional change remains"};
          stdout=`<execution-plan>${JSON.stringify(plan)}</execution-plan>`;
        }
        if(implementationFixture) {
          const plan=JSON.parse(stdout.slice('<execution-plan>'.length,-'</execution-plan>'.length));
          plan.tasks=["a","b"].map(key=>({key,kind:"isolated-work",ownedFiles:[`part-${key}.txt`],title:`Implement ${key}`,instructions:`Implement part ${key}`,deliverable:`part-${key}.txt`,acceptance:"Check exact fixture output",criterionIds:plan.criterionIds,estimatedTokens:1000,estimatedMinutes:2,dependsOn:[],purpose:"speed"}));
          stdout=`<execution-plan>${JSON.stringify(plan)}</execution-plan>`;
        }
        if (requirementPlanNext) {
          const scenario=requirementPlanNext;requirementPlanNext=undefined;
          const plan=JSON.parse(stdout.slice('<execution-plan>'.length,-'</execution-plan>'.length));
          const revision=input.skillContents["writing-rules"].match(/Captured writing rule revision: ([a-f0-9]{64})/)[1];
          plan.tasks=[
            {key:"a",kind:"primary-work",title:"Original A fixture",instructions:"Verify source A",deliverable:"Original evidence",acceptance:"Verify",criterionIds:plan.criterionIds,estimatedTokens:500,estimatedMinutes:2,dependsOn:[]},
            {key:"b",kind:"investigation",title:"Independent B fixture",instructions:"Independent B fixture: verify neutral original sources",deliverable:"Independent evidence",acceptance:"Verify",criterionIds:plan.criterionIds,estimatedTokens:500,estimatedMinutes:2,dependsOn:["a"],
              ...(scenario!=="legacy"?{requirements:{independentFrom:["a"],modelFamilies:["gemini"],skills:[{id:scenario==="skill"?"unavailable-required-skill":"writing-rules",...(scenario==="skill"?{}:{revision})}]}}:{})}
          ];
          stdout=`<execution-plan>${JSON.stringify(plan)}</execution-plan>`;
        }
        if (primaryMilestonesNext) {
          primaryMilestonesNext = false;
          const plan = JSON.parse(stdout.slice('<execution-plan>'.length, -'</execution-plan>'.length));
          plan.tasks.unshift({ key: "bootstrap", kind: "primary-work", title: "Small primary implementation milestone", instructions: "Create the bounded starting artifact", deliverable: "Starting artifact", acceptance: "Verify artifact", criterionIds: [goal.criteria[0].id], dependsOn: [], estimatedTokens: 1000, estimatedMinutes: 5 });
          plan.tasks.find((t: any) => t.key === "a").dependsOn = ["bootstrap"];
          plan.coordination = { criticalPath: "bootstrap -> a -> integration", parallelBenefit: "a and b independently verify different evidence", contextPlan: "direct dependencies and artifact paths", resourcePlan: "available providers, preserve review reserve" };
          stdout = `<execution-plan>${JSON.stringify(plan)}</execution-plan>`;
        }
        if (planReplyNext === "invalid") stdout = "No valid execution plan";
        if (planReplyNext === "bad-estimate") stdout = stdout.replace('"estimatedMinutes":20', '"estimatedMinutes":"20"');
        if (persistentInvalidPlan) stdout = "No valid execution plan";
        if (planReplyNext === "ask-user") stdout = '<work-check>{"status":"ask-user","summary":"Need permission for new data","remainingWork":"Wait for user decision","estimatedRemainingMinutes":0,"evidence":[]}</work-check>';
        planReplyNext = undefined;
      } else if (reviseNext && input.prompt.includes("# Lead-owned execution plan")) {
        reviseNext = false;
        const goal = JSON.parse(input.prompt.match(/# User-approved goal[^\n]*\n([^\n]+)/)[1]);
        stdout = `<execution-plan>${JSON.stringify({ summary: "Investigate new discrepancy", reason: "Source evidence contradicted initial assumption", primaryWork: "Integrate verified findings and update report", acceptance: "Check sources and artifacts", criterionIds: goal.criteria.map((c: any) => c.id), estimatedTokens: 8000, estimatedMinutes: 10, escalation: "Ask for new authority", tasks: [{ key: "discrepancy", title: "Independent cross-check", instructions: "Read independent evidence", deliverable: "Source comparison", acceptance: "Compare original references", criterionIds: [goal.criteria[0].id], dependsOn: [], estimatedTokens: 1000 }] })}</execution-plan>`;
      }
      if (input.prompt.includes("# Task-scoped orchestrator: allocation decision only")) {
        assert.equal(input.mode, "read"); assert.equal(input.continueSession, undefined);
        assert.doesNotMatch(input.prompt, /Planning resource snapshot|# User-approved goal/);
        assert.match(input.prompt, /Abridged data is NOT authority/);
        // Synthetic bounded usage from this fake CLI keeps allocation/adjustment
        // scenarios deterministic. Production estimate fallback and manager
        // limits are tested in orchestrator.test; never raise those limits here.
        if (input.resultCommand) await writeFile(join(input.resultCommand.at(-2), "usage.json"), JSON.stringify({ token: input.resultCommand.at(-1), usage: { source: "reported", inputTokens: 800, outputTokens: 100 } }));
        const criterionIds = JSON.parse(input.prompt.match(/Required criterion IDs: ([^\n]+?)\. Current instruction/)[1]);
        stdout = `<work-plan>${JSON.stringify({ action: coordinatorAddNext ? "add" : "wait", reason: coordinatorAddNext ? "Independent boundary evidence saves later integration time" : "Existing packages cover the goal; do not add busywork", tasks: coordinatorAddNext ? [{ key: "dynamic", title: "Dynamic boundary check", instructions: "Read independent existing sources", deliverable: "Boundary evidence", acceptance: "Compare definitions", criterionIds: [criterionIds[0]], dependsOn: [], estimatedTokens: 1000 }] : [] })}</work-plan>`;
        if (coordinatorAdjustNext) {
          const progress = JSON.parse(input.prompt.match(/Progress and findings \(data\): ([^\n]+)/)[1]);
          const target = progress.find((p:any) => p.kind === "integration" && p.refinable);
          assert.ok(target, "integration must be genuinely unstarted");
          stdout = `<work-plan>${JSON.stringify({action:"adjust",reason:"Completed evidence identifies a boundary to verify",tasks:[],refinements:[{unitId:target.id,note:"Check the newly discovered boundary in evidence/boundary.json; retain original acceptance checks."}]})}</work-plan>`;
          coordinatorAdjustNext = false;
        }
        coordinatorAddNext = false;
      }
      // Use the actual per-run capability, validated plan, router and MCP child
      // process. No pre-seeded critic identity or direct judge calls here.
      if (researchWorkflowId && input.research && input.resultCommand) {
        const command:string[]=input.resultCommand;
        const {context:c}:{context:ResearchContext}=JSON.parse(await readFile(join(command.at(-2)!,"research-context.json"),"utf8"));
        const current=await getTask(c.taskId), unit=current.workUnits.find(u=>u.id===c.actor)!;
        if(c.taskId===researchWorkflowId && unit.researchStage==="coding") {
          const rpc=async(request:object, error=false)=>{
            const child=spawn(command[0],command.slice(1));let out="",err="";
            child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
            child.stdin.end(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"research_manage",arguments:{request}}})+"\n");
            assert.equal(await new Promise(r=>child.on("close",r)),0,err);
            const result=JSON.parse(out.trim()).result;
            assert.equal(!!result.isError,error,out);
            return error ? undefined : JSON.parse(result.content[0].text);
          };
          if(unit.planPhase) {
            const evaluator=`${c.taskId}-evaluator.txt`;
            await writeFile(join(directory,evaluator),"Synthetic fixed evaluation protocol");
            assert.equal(c.requireOutputContract,true);
            await rpc({action:"protocol",protocol:{question:"MCP integration fixture",files:[evaluator],maxExperiments:5,metrics:[{id:"score",direction:"max",tolerance:0,subset:true}],outputs:[{id:"execution",format:"file"}]}});
            await rpc({action:"candidate",candidate:{id:"candidate",hypothesis:"Fixture improvement",limitation:"Fixture baseline",novelty:"No scientific claim",falsifier:"No improvement",sources:["fixture://protocol"]}});
            const plan=JSON.parse(stdout.slice('<execution-plan>'.length,-'</execution-plan>'.length));
            plan.tasks=["subset","full","ablation"].flatMap((stage,i)=>[
              {key:stage,kind:"primary-work",title:`Experiment ${stage}`,instructions:`Record ${stage}`,deliverable:"Immutable evidence",acceptance:"Numeric comparison",criterionIds:plan.criterionIds,estimatedTokens:500,dependsOn:i?[`critic-${["subset","full"][i-1]}`]:[]},
              {key:`critic-${stage}`,kind:"investigation",researchCritic:true,title:`Critic ${stage}`,instructions:`Independently judge ${stage}`,deliverable:"Scientific critique",acceptance:"Actual evidence",criterionIds:plan.criterionIds,estimatedTokens:500,dependsOn:[stage]}
            ]);
            stdout=`<execution-plan>${JSON.stringify(plan)}</execution-plan>`;
          } else if(unit.primaryStep) {
            assert.equal(c.write,true);assert.equal(c.manage,true,"saved primary-work has the same management authority as its owner");assert.equal(c.critic,false);
            const stages=unit.subtask!.key==="subset"?["baseline-subset","baseline-full","subset"]:[unit.subtask!.key];
            for(const stage of stages){
              const prefix=`${c.taskId}-${stage}`;
              await writeFile(join(directory,`${prefix}.json`),JSON.stringify({score:stage.startsWith("baseline")?1:2}));
              await writeFile(join(directory,`${prefix}.py`),"# immutable fixture source");
              await writeFile(join(directory,`${prefix}.log`),"fixture execution receipt");
              const outputs={execution:`${prefix}.log`};
              assert.equal((await rpc({action:"check-outputs",outputs})).outputCheck.ok,true);
              await rpc({action:"record",experiment:{id:stage,stage,candidate:"candidate",purpose:"MCP workflow fixture",result:`${prefix}.json`,evidence:[`${prefix}.py`,`${prefix}.log`],outputs,comparedTo:stage==="ablation"?"full":undefined}});
            }
            await rpc({action:"judge",experimentId:unit.subtask!.key,verdict:"accept",reason:"Self-approval must fail"},true);
          } else if(c.critic) {
            const stage=unit.subtask!.key.replace("critic-","");
            const ledger=await researchOperation({...c,user:true},{action:"snapshot"});
            assert.notEqual(ledger.experiments.find(e=>e.id===stage)!.cli,c.cli);
            assert.equal(c.write,false);assert.equal(c.manage,false);
            if(!omitResearchCritique || stage!=="ablation") await rpc({action:"judge",experimentId:stage,verdict:"accept",reason:"Independently checked fixture evidence"});
          } else if(unit.primary) {
            await rpc({action:"select",experimentId:"full"});
            if(omitResearchCritique) {
              // Even an agent's own needs-work response must receive all ledger
              // findings in this attempt, not only after it eventually says ready.
              const check=JSON.parse(stdout.slice('<work-check>'.length,-'</work-check>'.length));
              stdout=`<work-check>${JSON.stringify({...check,status:"needs-work",remainingWork:"Original agent repair remains necessary"})}</work-check>`;
              const {context:q}:{context:QualityContext}=JSON.parse(await readFile(join(command.at(-2)!,"quality-context.json"),"utf8"));
              const spec=q.specs.find(s=>q.allowedStages.includes(s.stage))!;
              const evidence=`quality-fixture-${spec.id}.txt`;
              await qualityOperation(q,{action:"record",id:spec.id,status:"fail",detail:"Unresolved fixture quality",evidence:[evidence],repairOwner:"worker"});
            }
          }
        }
      }
      if (useResultChannel && input.resultCommand && /<(goal-draft|goal-evaluation|execution-plan|work-plan|work-check|editorial-check)>/.test(stdout)) {
        const command = input.resultCommand;
        const environmentFailure = require("./execution-blocker").reportedExecutionFailure(stdout);
        await require("./result-channel").saveStructuredResult(command.at(-2), command.at(-1), stdout);
        if (role === "reporter") {
          // The real CLI submits progress after its editorial receipt. Both
          // must survive until the unchanged finishing gate consumes them.
          await require("./result-channel").saveStructuredResult(command.at(-2), command.at(-1), '<work-check>{"status":"ready","summary":"Reporter progress"}</work-check>');
        }
        stdout = "管理用の結果を提出しました。検証が完了しています。";
        if (environmentFailure && missingEnvironmentMarkerOnce) {
          missingEnvironmentMarkerOnce=false;
          return {stdout,stderr:"",exitCode:0,signal:null,handoff:{status:"blocked",summary:"最終完了通知はありません。"}};
        }
        if (role === "reviewer" && missingReviewMarkerOnce) {
          missingReviewMarkerOnce = false;
          return { stdout, stderr: "", exitCode: 0, signal: null, handoff: { status: "blocked", summary: "指示は取得済みですが、この工程の有効な完了通知がありません。" } };
        }
      }
      if (!input.resultCommand && input.prompt.includes("# Result transport override (file-based CLI") && /<(goal-draft|goal-evaluation|execution-plan|work-plan|work-check|editorial-check)>/.test(stdout)) {
        const notification = input.prompt.match(/Notification file: ([^\n]+)/)![1];
        const token = input.prompt.match(/Completion token: ([^\n]+)/)![1];
        await require("./result-channel").saveStructuredResult(dirname(notification), token, stdout);
        stdout = "管理結果をファイルへ提出しました。";
      }
      emit({ stream: "stdout", text: stdout });
      return { stdout, stderr: "", exitCode: 0, signal: null, handoff: { status: "completed", summary: stdout, sessionId: randomUUID() } };
    }
    cancel(id: string) { held?.(); heldSubtasks.get(id)?.(true); return true; }
    cancelAll() { held?.(); heldSubtasks.forEach(resolve => resolve(true)); }
    shutdown() { this.cancelAll(); }
    forget() {}
  };
  // Full-suite load and real MCP child processes can delay a fixture boundary;
  // retain bounded waits without making an 8-second scheduling race a failure.
  const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error("Workflow state did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const ipc = (name: string, ...args: any[]) => {
    if (name === "task:create") args[0] = { workspaceMode: args[0].remoteSystemId ? "remote" : "existing", ...args[0] };
    return handlers.get(name)!(undefined, ...args);
  };
  const getTask = async (id: string): Promise<TaskRecord> => {
    const value = await ipc("app:snapshot");
    const task = value.tasks.find((task: TaskRecord) => task.id === id);
    if (["awaiting-input", "paused", "completed", "failed", "blocked"].includes(task.state) && value.queue.activeTaskId === id) {
      await waitFor(async () => (await ipc("app:snapshot")).queue.activeTaskId !== id);
      return (await ipc("app:snapshot")).tasks.find((task: TaskRecord) => task.id === id);
    }
    return task;
  };
  try {
    require("../main");
    await waitFor(() => handlers.has("task:create"));
    assert.equal(windowCount, 1);
    appEvents.get("second-instance")?.();
    assert.equal(windowCount, 1, "a repeated Finder launch focuses the existing window");
    assert.equal(windowRestored, 1); assert.equal(windowFocused, 1);
    // Historical scenarios exercise the saved pair policy, not the fresh-install
    // default. Parallel reviews are covered through the real IPC below.
    await ipc("execution:settings-update", defaultExecution);
    if (process.env.HARNESS_CONTINUATION_TEST_ONLY === "1") {
      await writeFile(join(directory, "evidence.txt"), "Synthetic continuation evidence");
      const draft = await ipc("task:create", { title: "Interrupted continuation fixture", prompt: "Verify a concrete artifact", cwd: directory,
        goalMode: "manual", strategy: "balanced", allowedAgentIds: ["codex", "claude", "antigravity"], modelOverrides: {} });
      const approved = await ipc("goals:save", draft.id, { ...draft.goal, questions: [] }, draft.goal.revision, true, { enabled: true, maxCycles: 3 });
      await ipc("task:execution", draft.id, { ...approved.execution, maxParallel: 2, maxSubtasks: 4 });
      planNext = true; useResultChannel = true; checkResults = ["ask-user"];
      await ipc("task:run", draft.id);
      await waitFor(async () => (await getTask(draft.id)).awaitingReason === "result");
      const stopped = await getTask(draft.id);
      assert.equal(stopped.autonomyState, "needs-input", stopped.error);
      assert.ok(stopped.continuationUnitId, stopped.error);
      const completedPeers = stopped.workUnits.filter(u => u.state === "completed" && u.id !== stopped.continuationUnitId).map(u => u.id);
      const topology = stopped.workUnits.map(u => [u.id, u.dependsOn]);
      const before = calls.length;
      const reply: FollowupInput = { instruction: "指定済みの作者設定を使用し、既存成果から続行してください", kind: "continue", assignments: {}, pauseAfterPlan: false };
      await ipc("task:followup", draft.id, reply, false);
      assert.equal((await getTask(draft.id)).roundNumber ?? 1, 1);
      assert.equal(calls.length, before, "saving an answer does not start work");
      await ipc("task:followup", draft.id, reply, true);
      await waitFor(async () => {
        const t = await getTask(draft.id);
        if (["paused", "blocked", "failed"].includes(t.state)) throw new Error(t.error);
        return t.autonomyState === "satisfied";
      });
      const finished = await getTask(draft.id);
      assert.equal(finished.roundNumber ?? 1, 1);
      assert.deepEqual(finished.workUnits.map(u => [u.id, u.dependsOn]), topology);
      assert.equal(finished.executionPlans!.length, stopped.executionPlans!.length);
      assert.equal(finished.resumeInstructions!.length, 1); assert.equal(finished.resumeCount, 1);
      assert.equal(finished.pendingFollowup, undefined);
      assert.deepEqual(finished.runs.slice(0, stopped.runs.length), stopped.runs);
      assert.ok(finished.executionMetrics!.elapsedMs >= stopped.executionMetrics!.elapsedMs);
      assert.equal(finished.workflowMetrics!.totalRuns, finished.runs.length);
      assert.equal(finished.interruptedHistory!.length, 1); assert.equal(finished.history!.length, 1);
      assert.ok(calls[before].prompt.includes(reply.instruction));
      assert.ok(calls[before].prompt.includes("SAME workflow round"));
      assert.ok(!calls.slice(before).some(c => c.prompt.includes("INITIAL OR REQUIRED REPLAN")));
      assert.ok(completedPeers.every(id => finished.runs.filter(r => r.workUnitId === id).length === stopped.runs.filter(r => r.workUnitId === id).length));
      return;
    }
    if(process.env.HARNESS_MESSAGES_TEST_ONLY==="1") {
      await writeFile(join(directory,"evidence.txt"),"Synthetic verified fixture evidence");
      const draft=await ipc("task:create",{title:"Consultation fixture",prompt:"Verify a concrete artifact",cwd:directory,goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex","claude","antigravity"],modelOverrides:{}});
      const approved=await ipc("goals:save",draft.id,{...draft.goal,questions:[]},draft.goal.revision,true,{enabled:true,maxCycles:3});
      await ipc("task:execution",draft.id,{...approved.execution,maxParallel:2,maxSubtasks:4});
      planNext=true;useResultChannel=true;await ipc("task:run",draft.id);
      await waitFor(async()=>{const t=await getTask(draft.id);if(["paused","blocked","failed"].includes(t.state))throw new Error(t.error);return t.awaitingReason==="result";});
      const done=await getTask(draft.id);
      assert.ok(done.agentMessages!.length>=2);assert.ok(done.agentMessages!.every(m=>m.state==="read"));
      assert.equal(done.autonomyState,"satisfied",done.error);return;
    }
    if(process.env.HARNESS_EARLY_PARALLEL_TEST_ONLY==="1") {
      await writeFile(join(directory,"evidence.txt"),"Synthetic verified fixture evidence");
      const draft=await ipc("task:create",{title:"Early parallel fixture",prompt:"Verify a concrete artifact",cwd:directory,goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex","claude","antigravity"],modelOverrides:{}});
      const approved=await ipc("goals:save",draft.id,{...draft.goal,questions:[]},draft.goal.revision,true,{enabled:true,maxCycles:3,targetMinutes:60});
      await ipc("task:execution",draft.id,{...approved.execution,reviewMode:"parallel",scheduling:"throughput",maxParallel:3,maxSubtasks:8,contextTokens:undefined});
      const before=calls.length;earlyPlanNext=true;useResultChannel=true;
      await ipc("task:run",draft.id);
      await waitFor(async()=>{
        const t=await getTask(draft.id);
        if(["paused","blocked","failed"].includes(t.state))throw new Error(t.error);
        return t.awaitingReason==="result";
      });
      const done=await getTask(draft.id);
      assert.equal(done.autonomyState,"satisfied",done.error);assert.equal(earlyPeak,3);
      const first=done.workUnits.filter(u=>["environment","alternative","challenge"].includes(u.subtask?.key??""));
      assert.equal(new Set(first.map(u=>u.assignedAgentId)).size,3,"real router spreads the initial writer and text-only peers across services");
      const firstRuns=first.map(u=>done.runs.find(r=>r.workUnitId===u.id)!);
      assert.ok(Math.max(...firstRuns.map(r=>Date.parse(r.startedAt)))<Math.min(...firstRuns.map(r=>Date.parse(r.completedAt!))),"all three actual run intervals overlap");
      const apply=done.runs.find(r=>r.workUnitId===done.workUnits.find(u=>u.subtask?.key==="apply")!.id)!;
      assert.ok(firstRuns.every(r=>Date.parse(r.completedAt!)<=Date.parse(apply.startedAt)));
      assert.equal(calls.slice(before).filter(c=>c.prompt.includes("INITIAL OR REQUIRED REPLAN")).length,1);
      assert.ok(done.runs.some(r=>r.role==="reporter"&&r.finishingCheck));assert.ok(done.workUnits.some(u=>u.crossReview?.aggregate&&u.state==="completed"));
      await ipc("task:complete",draft.id);return;
    }
    if (process.env.HARNESS_PARALLEL_REVIEW_TEST_ONLY === "1") {
      await writeFile(join(directory,"evidence.txt"),"Synthetic verified fixture evidence");
      for (const scenario of ["pass", "repair", "resume", "serial-cap"] as const) {
        const draft = await ipc("task:create", {title:`Parallel consolidation ${scenario}`,prompt:"Verify a concrete artifact",cwd:directory,goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex","claude","antigravity"],modelOverrides:{}});
        const approved = await ipc("goals:save",draft.id,{...draft.goal,questions:[]},draft.goal.revision,true,{enabled:true,maxCycles:3,targetMinutes:60});
        await ipc("task:execution",draft.id,{...approved.execution,reviewMode:"parallel",scheduling:"throughput",maxParallel:scenario==="serial-cap"?1:3,contextTokens:undefined});
        const before = calls.length; crossPeak = 0; reviewResults = []; reviewConcerns = scenario === "repair" ? [["Unresolved boundary defect"]] : [];
        if (scenario === "resume") failRoleOnce = "reviewer";
        await ipc("task:run",draft.id);
        let preserved: string[] = [];
        if (scenario === "resume") {
          await waitFor(async()=>(await getTask(draft.id)).state==="paused");
          const stopped=await getTask(draft.id);
          preserved=stopped.workUnits.filter(u=>u.crossReview?.wave===1&&u.state==="completed").map(u=>u.id);
          assert.equal(preserved.length,2);
          assert.equal(stopped.workUnits.filter(u=>u.crossReview?.aggregate).length,1);
          assert.equal(stopped.workUnits.find(u=>u.crossReview?.aggregate)!.state,"pending");
          await ipc("task:resume",draft.id);
        }
        await waitFor(async()=>{
          const t=await getTask(draft.id);
          if (["paused","blocked","failed"].includes(t.state)) throw new Error(`${scenario}: ${t.error}`);
          return t.awaitingReason==="result";
        });
        const done=await getTask(draft.id), reviews=done.workUnits.filter(u=>u.crossReview), runs=done.runs.filter(r=>r.role==="reviewer"&&r.state==="completed");
        assert.equal(done.autonomyState,"satisfied",done.error);
        assert.equal(reviews.length,4);assert.ok(reviews.every(u=>u.state==="completed"));
        assert.equal(crossPeak,scenario==="serial-cap"?1:scenario==="resume"?2:3,`${scenario}: independent CLI requests overlap within the cap; a failed request never enters fake review work`);
        const first=reviews.filter(u=>u.crossReview!.wave===1), aggregate=reviews.find(u=>u.crossReview!.aggregate)!;
        assert.equal(new Set(first.map(u=>u.assignedAgentId)).size,3);
        assert.ok(first.every(u=>Date.parse(runs.find(r=>r.workUnitId===u.id)!.completedAt!)<=Date.parse(runs.find(r=>r.workUnitId===aggregate.id)!.startedAt)),"all peers finish before consolidation starts");
        const reviewCalls=calls.slice(before).filter(c=>c.prompt.includes("# Required structured goal review"));
        for(const c of reviewCalls.filter(c=>c.prompt.includes("# Blind independent review"))) assert.doesNotMatch(c.prompt,/Fixture review/);
        const aggregateCalls=reviewCalls.filter(c=>c.prompt.includes("# Review consolidation"));
        assert.equal(aggregateCalls.length,scenario==="repair"?2:1);
        assert.ok(aggregateCalls.every(c=>c.mode==="read"&&!c.continueSession));
        for(const c of aggregateCalls) for(const provider of first.map(u=>u.crossReview!.providerKey)) assert.ok(c.prompt.includes(`"provider":"${provider}"`),`consolidator receives ${provider}'s full source binding`);
        assert.equal(done.autonomyCycle??1,scenario==="repair"?2:1);
        if(scenario==="repair") assert.ok(done.evaluations!.some(e=>!e.reviewUnitId&&e.concerns?.includes("Unresolved boundary defect")),"clean consolidation cannot suppress the minority concern");
        assert.ok(preserved.every(id=>done.runs.filter(r=>r.workUnitId===id).length===1),"resume retains successful independent seats");
        await ipc("task:complete",draft.id);
      }
      return;
    }
    if (process.env.HARNESS_ENVIRONMENT_GATE_TEST_ONLY === "1") {
      const create = async (title:string) => {
        const draft=await ipc("task:create",{title,prompt:"Verify a concrete artifact",cwd:directory,goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex","claude"],modelOverrides:{}});
        return ipc("goals:save",draft.id,{...draft.goal,questions:[]},draft.goal.revision,true,{enabled:true,maxCycles:3,targetMinutes:30});
      };
      await writeFile(join(directory,"evidence.txt"),"verified");
      const sandbox=await create("Environment permission admission");
      await ipc("task:codex-permissions",sandbox.id,"sandbox",false);
      await ipc("task:run",sandbox.id);
      await waitFor(async()=>(await getTask(sandbox.id)).state==="blocked");
      let stopped=await getTask(sandbox.id);
      assert.equal(stopped.executionBlocker?.kind,"permission");
      assert.ok(stopped.runs.every(r=>{const u=stopped.workUnits.find(u=>u.id===r.workUnitId);return u?.planPhase||u?.orchestrator;}),
        `only planning/advice may launch: ${JSON.stringify(stopped.runs.map(r=>({agent:r.agentId,title:stopped.workUnits.find(u=>u.id===r.workUnitId)?.title})))}`);
      assert.equal(stopped.runs.filter(r=>r.role==="reporter"||r.role==="reviewer").length,0);
      const completedPlan=stopped.workUnits.find(u=>u.planPhase&&u.state==="completed")!.id;
      const planningRuns=stopped.runs.filter(r=>r.workUnitId===completedPlan).length;
      await ipc("task:codex-permissions",sandbox.id,"full-access",true);
      await ipc("task:resume",sandbox.id);
      await waitFor(async()=>(await getTask(sandbox.id)).autonomyState==="satisfied");
      stopped=await getTask(sandbox.id);
      assert.equal(stopped.executionBlocker,undefined);
      assert.equal(stopped.runs.filter(r=>r.workUnitId===completedPlan).length,planningRuns,"completed planning is reused");
      for (const transport of ["text","channel","channel-without-completion"]) {
        const blocked=await create(`Required GPU ${transport}`); useResultChannel=transport!=="text";
        missingEnvironmentMarkerOnce=transport==="channel-without-completion";
        checkResults=["environment-blocked"];
        await ipc("task:run",blocked.id);
        await waitFor(async()=>(await getTask(blocked.id)).state==="blocked");
        stopped=await getTask(blocked.id);
        assert.equal(stopped.executionBlocker?.kind,"hardware");
        assert.equal(stopped.runs.filter(r=>r.role==="worker" && !stopped.workUnits.find(u=>u.id===r.workUnitId)?.planPhase).length,1,
          "first environment failure stops without a second work attempt");
        assert.equal(stopped.workClosure,undefined);
        assert.equal(stopped.executionPlans?.length,1,"no replan or repeated repair");
        assert.ok(stopped.workUnits.some(u=>u.role==="reporter"&&u.state==="pending"));
        assert.equal(stopped.runs.filter(r=>r.role==="reporter"||r.role==="reviewer").length,0);
        assert.ok(stopped.resumeFromUnitId);
        await ipc("task:resume",blocked.id);
        await waitFor(async()=>(await getTask(blocked.id)).autonomyState==="satisfied");
        const resumed=await getTask(blocked.id);
        assert.equal(resumed.executionBlocker,undefined); assert.equal(resumed.goal!.revision,stopped.goal!.revision);
        const planId=stopped.workUnits.find(u=>u.planPhase)!.id;
        assert.equal(resumed.runs.filter(r=>r.workUnitId===planId).length,stopped.runs.filter(r=>r.workUnitId===planId).length);
      }
      return;
    }
    if (process.env.HARNESS_LOCAL_PERMISSIONS_TEST_ONLY === "1") {
      const draft=await ipc("task:create",{title:"Local GPU permission",prompt:"Inspect GPU",cwd:directory,goalMode:"manual",workflowMode:"primary",strategy:"balanced",allowedAgentIds:["codex","claude"],modelOverrides:{},localCodexPermissions:"invalid"});
      assert.equal(draft.localCodexPermissions,"full-access","new local tasks capture the application default, not raw renderer properties");
      // Legacy tasks have no explicit local field. Repairing it must not depend
      // on report I/O, and must retain the stopped step and all acceptance data.
      const legacy=await fixtureStore!.update(draft.id,{localCodexPermissions:undefined,state:"blocked",goal:{...draft.goal!,status:"approved"},
        resumeFromUnitId:draft.workUnits[0].id,error:"設定復旧待ち"});
      await assert.rejects(()=>ipc("task:codex-permissions",draft.id,"full-access",false),/確認/);
      const reportPrototype=require("./report-service").ReportService.prototype;
      const syncDraft=reportPrototype.syncDraft;
      reportPrototype.syncDraft=async()=>{throw new Error("Report storage unavailable");};
      let saved: TaskRecord;
      try { saved=await ipc("task:codex-permissions",draft.id,"full-access",true); }
      finally { reportPrototype.syncDraft=syncDraft; }
      assert.equal(saved.localCodexPermissions,"full-access");assert.equal(saved.remote,undefined);
      assert.equal(saved.state,legacy.state);assert.deepEqual(saved.goal,legacy.goal);assert.equal(calls.length,0);
      assert.equal(saved.resumeFromUnitId,legacy.resumeFromUnitId);assert.equal(saved.error,legacy.error);
      assert.deepEqual(saved.workUnits,legacy.workUnits);assert.deepEqual(saved.runs,legacy.runs);
      await fixtureStore!.update(draft.id,{state:draft.state,goal:draft.goal,resumeFromUnitId:undefined,error:undefined});
      saved=await ipc("task:codex-permissions",draft.id,"sandbox",false);assert.equal(saved.localCodexPermissions,"sandbox");
      await fixtureStore!.update(draft.id,{runs:[{id:"live",workUnitId:"fixture",providerKey:"openai",agentId:"codex",role:"worker",state:"completed",startedAt:"",output:""}]});
      terminalSnapshots.set("live",{alive:true,inputAllowed:true});
      await assert.rejects(()=>ipc("task:codex-permissions",draft.id,"full-access",true),/端末/);
      terminalSnapshots.delete("live");
      await fixtureStore!.update(draft.id,{runs:[]});
      await ipc("task:codex-permissions",draft.id,"full-access",true);
      const fresh=await getTask(draft.id);
      await ipc("goals:save",draft.id,{...fresh.goal,questions:[]},fresh.goal!.revision,true,{enabled:false,maxCycles:3});
      holdNext=true;await ipc("task:run",draft.id);await waitFor(()=>Boolean(held));
      assert.equal(calls.at(-1)!.codexPermissions,"full-access");
      assert.match(calls.at(-1)!.prompt, /ローカル実行環境の事前確認/);
      assert.match(calls.at(-1)!.prompt, /Full access（OSサンドボックスなし）/);
      assert.equal((await getTask(draft.id)).runs.at(-1)?.codexPermissions,"full-access");
      await assert.rejects(()=>ipc("task:codex-permissions",draft.id,"sandbox",false),/停止/);
      await mkdir(join(directory,"other-workspace"));
      const idle=await ipc("task:create",{title:"Other stopped task",prompt:"Inspect",cwd:join(directory,"other-workspace"),goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex","claude"],modelOverrides:{}});
      const callCount=calls.length;
      const idleSaved=await ipc("task:codex-permissions",idle.id,"sandbox",false);
      assert.equal(idleSaved.localCodexPermissions,"sandbox","another task's activity must not lock this task's permissions");
      assert.deepEqual(idleSaved.goal,idle.goal);assert.equal(calls.length,callCount,"saving never launches an agent");
      await ipc("task:cancel",draft.id);await waitFor(async()=>(await getTask(draft.id)).state==="paused");
      const reload=new JsonTaskStore(join(directory,"tasks.json"));await reload.init();
      assert.equal(reload.get(draft.id)!.localCodexPermissions,"full-access");
      return;
    }
    const remoteProfile = { id: "fixture-cluster", name: "遠隔テスト", host: "not-a-real-host", cwd: "/work/project", nodeCommand: "node", texCommand: "latexmk", startup: "", instructions: "ジョブは登録された方式で実行する", codexPermissions: "sandbox" };
    assert.equal((await ipc("remote:save", remoteProfile)).length, 1);
    const remoteDraft = await ipc("task:create", { title: "遠隔ゴール", prompt: "遠隔コードを検証", remoteSystemId: remoteProfile.id, cwd: "/not/a/local/path", goalMode: "manual", strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {} });
    assert.deepEqual(remoteDraft.remote, remoteProfile);
    if (process.env.HARNESS_LOGIN_ROUTE_TEST_ONLY === "1") {
      const destination={...remoteProfile,id:"destination",name:"5060ti",host:"192.0.2.50",username:"gateway-user",port:2222,connectionMode:"prepared",codexPermissions:"full-access",cwd:"new-default",nodeCommand:"other-node",instructions:"New defaults"};
      await ipc("remote:save",destination,true);
      const target={hostname:"original-final-node",username:"scientist",home:"/home/scientist",cwd:"/home/scientist/project",nodeExecutable:"/opt/node"};
      const unit=remoteDraft.workUnits[0];
      const run={id:"retained",workUnitId:unit.id,role:unit.role,agentId:"codex" as const,providerKey:"openai",state:"cancelled" as const,terminal:true,executionLocation:"remote" as const,output:"Prior evidence",startedAt:new Date().toISOString(),terminationUnconfirmed:true,
        remoteSession:{token:"original-token",controlDirectory:"/local/original",detached:true}};
      await fixtureStore!.update(remoteDraft.id,{state:"paused",remote:{...remoteDraft.remote!,connectionMode:"prepared",resolvedCwd:target.cwd,preparedTarget:target},runs:[run],workUnits:[{...unit,state:"blocked",launchBlocked:true}],roundNumber:4,instruction:"Keep existing work"});
      const before=fixtureStore!.get(remoteDraft.id)!,count=calls.length;
      await assert.rejects(ipc("task:login-route",remoteDraft.id,destination.id,{updatedAt:"stale",confirmed:true}),/最新状態/);
      terminalSnapshots.set(run.id,{alive:true,inputAllowed:false});
      await assert.rejects(ipc("task:login-route",remoteDraft.id,destination.id,{updatedAt:before.updatedAt,confirmed:true}),/端末/);terminalSnapshots.delete(run.id);
      const changed=await ipc("task:login-route",remoteDraft.id,destination.id,{updatedAt:before.updatedAt,confirmed:true});
      assert.equal(changed.remote!.id,destination.id);assert.equal(changed.remote!.host,destination.host);assert.equal(changed.remote!.username,destination.username);assert.equal(changed.remote!.port,2222);
      const {id:_id,name:_name,host:_host,username:_user,port:_port,...oldFinal}=before.remote!;
      const {id:_nextId,name:_nextName,host:_nextHost,username:_nextUser,port:_nextPort,...newFinal}=changed.remote!;
      assert.deepEqual(newFinal,oldFinal,"first-hop defaults must not change the execution environment or permission policy");
      for(const key of ["goal","runs","workUnits","cwd","state","roundNumber","instruction","report"] as const)assert.deepEqual(changed[key],before[key]);
      assert.equal(changed.runs[0].terminationUnconfirmed,true);assert.equal(changed.workUnits[0].launchBlocked,true);
      assert.equal(changed.loginRouteChanges!.length,1);assert.equal(calls.length,count,"saving a first hop does not connect, copy, launch or terminate a CLI");
      assert.equal(changed.executionMetrics!.totalRuns,1,"the reply retains view metrics instead of replacing them with a raw task record");
      return;
    }
    if (process.env.HARNESS_REMOTE_ADDRESS_TEST_ONLY === "1") {
      const newer={...remoteProfile,host:"192.0.2.45"};
      const consent={expectedHost:remoteProfile.host,confirmed:true};
      const unit=remoteDraft.workUnits[0];
      const retained={id:"old-remote",workUnitId:unit.id,role:unit.role,agentId:"codex" as const,providerKey:"openai",state:"cancelled" as const,
        terminal:true,executionLocation:"remote" as const,terminationUnconfirmed:true,output:"Retained evidence",startedAt:new Date().toISOString(),
        remoteSession:{token:"retained-token",controlDirectory:"/local/original-control",detached:true}};
      await fixtureStore!.update(remoteDraft.id,{state:"paused",remote:{...remoteDraft.remote!,resolvedCwd:"/home/scientist/task",preparedTarget:{hostname:"actual-node",username:"scientist",home:"/home/scientist",cwd:"/home/scientist/task",nodeExecutable:"/opt/node"}},runs:[retained],workUnits:[{...unit,state:"blocked",launchBlocked:true}]});
      const local=await ipc("task:create",{title:"Unrelated",prompt:"Do not edit",cwd:directory,goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex"],modelOverrides:{}});
      const before=fixtureStore!.get(remoteDraft.id)!;
      const callCount=calls.length;
      await assert.rejects(ipc("remote:save",newer,false,{...consent,expectedHost:"stale"}),/読み直して/);
      assert.equal((await ipc("remote:list"))[0].host,remoteProfile.host);
      terminalSnapshots.set(retained.id,{alive:true,inputAllowed:false});
      await assert.rejects(ipc("remote:save",newer,false,consent),/一時停止/);
      terminalSnapshots.delete(retained.id);
      await ipc("remote:save",newer,false,consent);
      const changed=fixtureStore!.get(remoteDraft.id)!;
      assert.deepEqual(changed,{...before,remote:{...before.remote!,host:newer.host},updatedAt:changed.updatedAt});
      assert.equal(changed.runs[0].terminationUnconfirmed,true);
      assert.equal(changed.workUnits[0].launchBlocked,true);
      assert.equal((await ipc("remote:list"))[0].host,newer.host);
      assert.deepEqual(fixtureStore!.get(local.id),local);
      assert.equal(calls.length,callCount,"IP reflection never invokes a CLI or replays completed work");
      // Ordinary profile changes remain defaults-only; explicit reapplication
      // also repairs a profile that was already saved with a new address.
      const newest={...newer,host:"192.0.2.46"};await ipc("remote:save",newest);
      assert.equal(fixtureStore!.get(remoteDraft.id)!.remote!.host,newer.host);
      await ipc("remote:save",newest,false,{expectedHost:newest.host,confirmed:true});
      assert.equal(fixtureStore!.get(remoteDraft.id)!.remote!.host,newest.host);
      assert.equal(calls.length,callCount);
      const {RemoteSystemStore}=require("./remote-systems");
      const save=RemoteSystemStore.prototype.save;
      let releaseSave!:()=>void, saving=false;
      RemoteSystemStore.prototype.save=async function(value:unknown){saving=true;await new Promise<void>(resolve=>{releaseSave=resolve;});return save.call(this,value);};
      const changing=ipc("remote:save",{...newest,host:"192.0.2.47"},false,{expectedHost:newest.host,confirmed:true});
      try {
        await waitFor(()=>saving);
        assert.throws(()=>ipc("queue:start"),/保存中/);
        await assert.rejects(ipc("remote:connect",remoteProfile.id),/保存中/);
        await assert.rejects(ipc("remote:check",remoteProfile.id),/保存中/);
        await assert.rejects(ipc("task:remote-bind",local.id,remoteProfile.id),/保存中/);
        await assert.rejects(ipc("task:create",{title:"Concurrent",prompt:"Do not capture stale IP",remoteSystemId:remoteProfile.id,goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex"],modelOverrides:{}}),/保存中/);
        assert.equal(fixtureStore!.get(remoteDraft.id)!.remote!.host,newest.host);
      } finally { releaseSave(); await changing; RemoteSystemStore.prototype.save=save; }
      assert.equal(fixtureStore!.get(remoteDraft.id)!.remote!.host,"192.0.2.47");
      assert.equal(calls.length,callCount,"persistence locks never launch or stop a user CLI");
      return;
    }
    const instructionsBefore = JSON.stringify(await getTask(remoteDraft.id));
    const instructions = await ipc("task:instructions", remoteDraft.id);
    assert.match(instructions.text, /ジョブは登録された方式で実行する/);
    assert.match(instructions.text, /未承認/);
    assert.equal(JSON.stringify(await getTask(remoteDraft.id)), instructionsBefore);
    assert.equal((await ipc("task:instructions-export", instructions.id)).canceled, true);
    exportDialogResult = { canceled: false, filePath: join(directory, "exported-instructions.txt") };
    assert.equal((await ipc("task:instructions-export", instructions.id)).path, exportDialogResult.filePath);
    assert.equal(await readFile(exportDialogResult.filePath!, "utf8"), instructions.text);
    await assert.rejects(() => ipc("task:instructions-export", "not-a-snapshot"));
    exportDialogResult = { canceled: true };
    assert.equal(remoteDraft.execution.maxParallel, require("./execution-policy").defaultExecution.maxParallel);
    assert.ok(remoteDraft.cwd.startsWith(join(directory, "remote-cache")));
    await ipc("remote:save", { ...remoteProfile, instructions: "新しい手順" });
    assert.equal((await getTask(remoteDraft.id)).remote!.instructions, remoteProfile.instructions);
    await assert.rejects(() => ipc("task:run", remoteDraft.id), /ゴールを承認/);
    assert.equal((await ipc("task:execution", remoteDraft.id, { ...remoteDraft.execution, maxParallel: 2 })).execution.maxParallel, 2);
    await assert.rejects(() => ipc("task:restart", remoteDraft.id, "fresh"), /空の遠隔作業/);
    const remoteCopy = await ipc("task:restart", remoteDraft.id, "carry"); assert.deepEqual(remoteCopy.remote, remoteProfile);
    assert.ok(!lastQueue!.activeTaskIds.includes(remoteDraft.id), "copying a task must not leave the original displayed as running");
    await ipc("task:delete", remoteDraft.id); await ipc("task:delete", remoteCopy.id);
    if (process.env.HARNESS_METRICS_TEST_ONLY === "1") {
      const input={title:"Primary metrics",prompt:"Verify evidence",cwd:directory,goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex","claude"],modelOverrides:{}};
      await assert.rejects(ipc("task:create",{...input,workflowMode:"staged"}),/主担当方式/);
      const draft=await ipc("task:create",input);assert.equal(draft.workflowMode,"primary");assert.ok(draft.execution);
      const approved=await ipc("goals:save",draft.id,{...draft.goal,questions:[]},1,true,{enabled:true,maxCycles:3,targetMinutes:30});
      assert.ok(approved.workUnits[0].primary);
      await writeFile(join(directory,"evidence.txt"),"verified");
      await ipc("task:run",draft.id);
      await waitFor(async()=>!!(await getTask(draft.id)).history?.length);
      const finished=await getTask(draft.id),metrics=finished.executionMetrics!;
      assert.equal(metrics.ticking,false);assert.ok(metrics.elapsedMs>0);
      assert.equal(finished.workUnits.filter(u=>u.timePlanReviewed).length,1,"an over-target plan gets exactly one optimization pass, not a blocked task");
      assert.equal(metrics.unknownMs,0);assert.equal(metrics.peakParallel,1);
      assert.equal(metrics.measuredRuns,finished.runs.length);
      assert.equal(metrics.usage.inputTokens,120*finished.runs.length);
      assert.equal(metrics.usage.outputTokens,30*finished.runs.length);
      assert.equal(finished.usage?.inputTokens,metrics.usage.inputTokens);
      assert.ok(finished.runs.every(r=>r.runtimeIdentity?.models[0]==="gpt-fixture"),"main persists native observations independently of requested aliases");
      const later=await getTask(draft.id);assert.equal(later.executionMetrics!.elapsedMs,metrics.elapsedMs);
      return;
    }
    const legacy = await ipc("task:create", { title: "Mock iterative task", prompt: "Original instruction", cwd: directory,
      workflowMode: "primary", strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {} });
    const builtinSkills = await ipc("skills:list");
    assert.equal(builtinSkills.skills.length,11); assert.equal(builtinSkills.errors.length,0);
    let projectSkill = await ipc("skills:save",legacy.id,{id:"fixture-check",revision:"",content:"---\nname: fixture-check\ndescription: Fixture validation\n---\n\nCheck a known fixture.\n",status:"experimental",evidence:""});
    projectSkill = await ipc("skills:save",legacy.id,{...projectSkill,status:"validated",evidence:"Fixture tests passed"});
    assert.equal((await ipc("skills:list",legacy.id)).skills[0].status,"validated");
    assert.match((await ipc("task:instructions",legacy.id)).text,/Check a known fixture\./);
    assert.equal(await ipc("skills:promote",legacy.id,projectSkill.id,projectSkill.revision),undefined);
    assert.equal((await ipc("skills:list")).skills.length,11);
    promoteResponse=1;
    const promoted = await ipc("skills:promote",legacy.id,projectSkill.id,projectSkill.revision);
    assert.equal(promoted.status,"experimental");
    await assert.rejects(ipc("skills:promote",legacy.id,projectSkill.id,projectSkill.revision),/同じID/);
    assert.ok((await ipc("skills:history",legacy.id,projectSkill.id)).length);
    await ipc("skills:save",legacy.id,{...projectSkill,status:"retired"});
    assert.doesNotMatch((await ipc("task:instructions",legacy.id)).text,/Check a known fixture\./);
    await assert.rejects(() => ipc("task:run", legacy.id), /ゴール/);
    assert.equal((await getTask(legacy.id)).state, "blocked");
    const draftRestart = await ipc("task:restart", legacy.id, "carry");
    assert.equal(draftRestart.goal.status, "draft");
    await assert.rejects(ipc("task:allowed-agents", draftRestart.id, ["codex", "gemini"]), /廃止済み/);
    await ipc("task:allowed-agents", draftRestart.id, ["codex", "claude", "antigravity"]);
    const created = await ipc("goals:save", draftRestart.id, { ...draftRestart.goal, questions: [] }, 1, true, { enabled: false, maxCycles: 3 });
    await writeFile(join(directory, "evidence.txt"), "verified");
    const input: FollowupInput = { instruction: "Additional analysis", kind: "consult", assignments: {}, pauseAfterPlan: true };
    await ipc("task:configure", created.id, input);
    await ipc("task:run", created.id);
    await waitFor(async () => (await getTask(created.id)).awaitingReason === "plan");
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /CLI's completion hook/);
    assert.doesNotMatch(calls[0].prompt, /Notification file:/);
    await assert.rejects(() => ipc("task:complete", created.id));
    await ipc("task:run", created.id);
    await waitFor(async () => (await getTask(created.id)).history?.length === 1);
    let task = await getTask(created.id);
    assert.equal(task.state, "awaiting-input"); assert.equal(task.awaitingReason, "result");
    assert.equal(calls.length, 5); assert.equal(task.report?.state, "ready");
    const oldTex = await readFile(task.report!.texPath!, "utf8");
    const oldVersion = task.history![0].report!.pdfPath!;
    const oldPdf = await readFile(oldVersion,"utf8");
    await ipc("task:followup", created.id, input, true);
    await waitFor(async () => (await getTask(created.id)).history?.length === 2);
    task = await getTask(created.id);
    assert.equal(task.roundNumber, 2); assert.equal(task.runs.length, 6); assert.equal(task.workUnits.length, 1);
    assert.equal(calls[5].mode, "read"); assert.match(calls[5].prompt, /Original instruction/); assert.match(calls[5].prompt, /Additional analysis/);
    assert.equal(await readFile(task.report!.texPath!, "utf8"), oldTex);
    await ipc("task:followup", created.id, { ...input, kind: "report", instruction: "Improve report" }, true);
    await waitFor(async () => (await getTask(created.id)).history?.length === 3);
    assert.equal(await readFile(oldVersion, "utf8"), oldPdf);
    holdNext = true;
    await ipc("task:followup", created.id, { ...input, kind: "continue", pauseAfterPlan: false }, true);
    await waitFor(() => Boolean(held));
    await assert.rejects(ipc("skills:save",created.id,{...projectSkill,status:"experimental"}),/停止/);
    await ipc("task:followup", created.id, input, false);
    assert.deepEqual((await getTask(created.id)).pendingFollowup, input);
    await assert.rejects(() => ipc("task:followup", created.id, input, true));
    await ipc("task:cancel", created.id);
    await waitFor(async () => (await getTask(created.id)).state === "paused");
    const pausedCalls = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(calls.length, pausedCalls);
    await ipc("task:followup", created.id, input, true);
    await waitFor(async () => (await getTask(created.id)).history?.length === 5);
    await assert.rejects(() => ipc("task:complete", created.id), /2回|再検証|変更されています/);
    await ipc("task:followup", created.id, { ...input, kind: "review" }, true);
    await waitFor(async () => (await getTask(created.id)).history?.length === 6);
    // A changed work instruction interrupted before execution cannot be waived
    // by asking for review only. Resume substantive verification before closing.
    await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    await assert.rejects(()=>ipc("task:complete",created.id),/変更されています/);
    await ipc("task:followup",created.id,{...input,kind:"continue",pauseAfterPlan:false},true);
    await waitFor(async()=>(await getTask(created.id)).history?.length===7);
    await ipc("task:complete", created.id);
    assert.equal((await getTask(created.id)).state, "completed");
    const persisted = JSON.parse(await readFile(join(directory, "tasks.json"), "utf8"));
    assert.equal(persisted.tasks.find((t: TaskRecord) => t.id === created.id).history.length, 7);
    const createQueued = async (title: string) => {
      const draft = await ipc("task:create", { title, prompt: "Queue fixture", cwd: directory, goalMode: "manual",
        workflowMode: "primary", strategy: "balanced", allowedAgentIds: ["codex", "claude", "antigravity"], modelOverrides: {} });
      return ipc("goals:save", draft.id, { ...draft.goal, questions: [] }, 1, true, { enabled: false, maxCycles: 3 });
    };
    const first = await createQueued("Plan approval");
    const second = await createQueued("Next queued task");
    await ipc("task:configure", first.id, input);
    await ipc("queue:start");
    await waitFor(async () => !(await ipc("app:snapshot")).queue.running);
    assert.equal((await getTask(first.id)).awaitingReason, "plan");
    assert.equal((await getTask(second.id)).state, "blocked");
    assert.match((await getTask(second.id)).error ?? "", /作業ディレクトリが重なって/);
    await ipc("task:run", second.id);
    await waitFor(async () => (await getTask(second.id)).awaitingReason === "result");
    assert.equal((await getTask(second.id)).awaitingReason, "result");

    // Independent top-level tasks overlap; duplicate starts and workspace aliases do not.
    const parallelA = await ipc("task:create", { title:"Parallel goal A", prompt:"Parallel goal A", cwd:join(directory,"parallel-a"), workspaceMode:"new", goalMode:"ai", strategy:"balanced", allowedAgentIds:["codex","claude"], modelOverrides:{} });
    const parallelB = await ipc("task:create", { title:"Parallel goal B", prompt:"Parallel goal B", cwd:join(directory,"parallel-b"), workspaceMode:"new", goalMode:"ai", strategy:"balanced", allowedAgentIds:["codex","claude"], modelOverrides:{} });
    holdNext = true;
    await ipc("task:run", parallelA.id); await waitFor(() => !!held);
    await assert.rejects(() => ipc("task:run", parallelA.id), /既に実行中/);
    const collision = await ipc("task:create", { title:"Overlapping goal", prompt:"Must not run", cwd:parallelA.cwd, goalMode:"ai", strategy:"balanced", allowedAgentIds:["codex","claude"], modelOverrides:{} });
    await assert.rejects(() => ipc("task:run", collision.id), /作業ディレクトリが重なって/);
    await ipc("task:run", parallelB.id);
    await waitFor(async () => (await getTask(parallelB.id)).awaitingReason === "goal");
    assert.ok((await ipc("app:snapshot")).queue.activeTaskIds.includes(parallelA.id));
    await ipc("task:cancel", parallelA.id);
    await waitFor(async () => (await getTask(parallelA.id)).state === "paused");
    assert.equal((await getTask(parallelB.id)).awaitingReason,"goal");
    await ipc("task:delete", collision.id);
    await assert.rejects(() => ipc("task:create", { title:"No workspace",prompt:"Invalid",cwd:directory,workspaceMode:undefined,strategy:"balanced",allowedAgentIds:["codex"],modelOverrides:{} }), /作業ディレクトリ/);

    // Goal setup uses the same terminal runner but cannot reach a write/report step before approval.
    const setup = await ipc("task:create", { title: "Goal fixture", prompt: "Explain FP4", cwd: directory,
      workflowMode: "primary", goalMode: "manual", strategy: "balanced", allowedAgentIds: ["codex", "claude", "antigravity"], modelOverrides: {} });
    assert.equal(setup.awaitingReason, "goal"); assert.equal(setup.report, undefined);
    await assert.rejects(() => ipc("task:run", setup.id), /ゴール/);
    await assert.rejects(() => ipc("reports:generate", setup.id), /ゴール/);
    await assert.rejects(() => ipc("task:followup", setup.id, input, true), /ゴール/);
    await assert.rejects(() => ipc("task:complete", setup.id));
    await assert.rejects(() => ipc("goals:save", setup.id, setup.goal, 1, true), /確認事項/);
    const beforeGoal = calls.length;
    await ipc("goals:refine", setup.id, "初心者向けに説明", 1);
    await waitFor(async () => (await getTask(setup.id)).awaitingReason === "goal");
    let prepared = await getTask(setup.id);
    assert.equal(calls.length, beforeGoal + 1); assert.equal(calls.at(-1)!.mode, "read");
    assert.equal(prepared.goal!.status, "draft"); assert.equal(prepared.report, undefined);
    assert.equal(prepared.runs.length, 1); assert.equal(prepared.runs[0].goalPreparation, true);
    assert.equal(prepared.goal!.criteria[0].id, "range");
    const goodRevision = prepared.goal!.revision;
    invalidGoalNext = true;
    await ipc("goals:refine", setup.id, "再提案", goodRevision);
    await waitFor(async () => (await getTask(setup.id)).awaitingReason === "goal");
    prepared = await getTask(setup.id);
    assert.equal(prepared.goal!.revision, goodRevision); assert.match(prepared.error!, /取り込めません/);
    holdNext = true;
    await ipc("goals:refine", setup.id, "読みやすく", goodRevision);
    await waitFor(() => Boolean(held));
    await assert.rejects(() => ipc("goals:save", setup.id, prepared.goal, goodRevision, true), /処理中/);
    await ipc("task:cancel", setup.id);
    await waitFor(async () => (await getTask(setup.id)).state === "paused");
    await ipc("task:run", setup.id);
    await waitFor(async () => (await getTask(setup.id)).awaitingReason === "goal");
    prepared = await getTask(setup.id);
    const approved = await ipc("goals:save", setup.id, prepared.goal, prepared.goal!.revision, true);
    assert.equal(approved.state, "queued"); assert.equal(approved.goal.status, "approved");
    assert.equal(approved.workUnits.length, 4);
    await assert.rejects(() => ipc("goals:save", setup.id, prepared.goal, prepared.goal!.revision, false), /更新/);
    const beforeExecution = calls.length;
    observeSkillsNext = true;
    await writeFile(join(directory, "evidence.txt"), "verified");
    await ipc("task:run", setup.id);
    await waitFor(async () => (await getTask(setup.id)).awaitingReason === "result");
    assert.equal(calls.length, beforeExecution + 5);
    const observedRun = (await getTask(setup.id)).runs.find(r=>r.skillUsage?.reads.some(s=>s.id==="script-reuse"))!;
    assert.ok(observedRun);
    assert.equal(observedRun.skillUsage!.reads[0].calls, 1);
    assert.deepEqual(observedRun.skillUsage!.reads.map(s => s.id), ["script-reuse", "document-checks", "related-research", "writing-rules"]);
    assert.ok(observedRun.estimatedTokens! >= require("./execution-policy").tokenEstimate(calls[beforeExecution].prompt) + observedRun.skillUsage!.estimatedTokens);
    assert.ok(calls.slice(beforeExecution).every(call => call.prompt.includes("User-approved goal")));
    assert.match(calls[beforeExecution].prompt, /INITIAL OR REQUIRED REPLAN/, "the primary owner must submit a plan before substantive work");
    assert.match(calls[beforeExecution].prompt, /get_skill/);
    assert.match(calls[beforeExecution].skillContents!["writing-rules"], /文献情報の一次ソース二重チェック/);
    assert.match(calls[beforeExecution].skillContents!["writing-rules"], /異なる2種類のAI/);
    const sharedWritingRevision = calls[beforeExecution].skillContents!["writing-rules"].match(/Captured writing rule revision: ([a-f0-9]{64})/)![1];
    for (const id of ["document-checks", "related-research"]) {
      assert.ok(calls[beforeExecution].skillContents![id].includes(sharedWritingRevision), "the real run delivers role-specific references to its exact writing snapshot");
    }
    assert.doesNotMatch(calls[beforeExecution].skillContents!["document-checks"], /検査候補：①/, "canonical detailed checks are delivered once");
    await assert.rejects(() => ipc("goals:save", setup.id, approved.goal, approved.goal.revision, false), /本作業|処理中/);
    await waitFor(async () => !(await ipc("app:snapshot")).queue.activeTaskId);
    // Keep this bounded regression runnable without the unrelated coordinator
    // timing scenarios below. The real startup, approval and run bundle ran above.
    if (process.env.HARNESS_WRITING_RULES_TEST_ONLY === "1") return;
    await writeFile(join(directory, "evidence.txt"), "verified");
    // Generic assertions test role order/context reuse, not time optimization
    // or context rollover. Those policies have separate explicit-limit tests.
    const createAuto = async (title: string, maxCycles = 3, workflowMode: "primary" = "primary", allowedAgentIds = ["codex", "claude", "antigravity"], targetMinutes: number | null = 60) => {
      const draft = await ipc("task:create", { title, prompt: "Verify a concrete artifact", cwd: directory, goalMode: "manual", workflowMode, strategy: "balanced", allowedAgentIds, modelOverrides: {} });
      const approved=await ipc("goals:save", draft.id, { ...draft.goal, questions: [] }, draft.goal.revision, true, { enabled: true, maxCycles, targetMinutes: targetMinutes ?? undefined });
      return ipc("task:execution",draft.id,{...approved.execution,contextTokens:undefined});
    };
    for(const scenario of ["finish","improve","no-peer","peer-failure","pause"] as const) {
      const draft=await createAuto(`Standard content cycle ${scenario}`);
      standardContentTaskId=draft.id;useResultChannel=true;contentContinueOnce=scenario==="improve";contentPeerFailure=scenario==="peer-failure";
      if(scenario==="no-peer")await ipc("task:execution",draft.id,{...draft.execution,decompose:false,maxSubtasks:1});
      holdSubtasks=scenario==="pause";
      const before=calls.length;
      await ipc("task:run",draft.id);
      if(scenario==="pause") {
        await waitFor(()=>heldSubtasks.size===1);await ipc("task:cancel",draft.id);
        await waitFor(async()=>(await getTask(draft.id)).state==="paused");
        const paused=await getTask(draft.id);
        assert.equal(paused.workUnits.filter(u=>u.contentCheck?.stage==="initial" && !u.planPhase && u.state==="completed").length,1);
        holdSubtasks=false;await ipc("task:resume",draft.id);
      }
      await waitFor(async()=>{
        const task=await getTask(draft.id);if(["paused","blocked","failed"].includes(task.state))throw new Error(task.error);
        return task.awaitingReason==="result";
      });
      const done=await getTask(draft.id),reader=done.workUnits.find(u=>u.contentCheck?.stage==="peer");
      assert.equal(done.autonomyState,"satisfied",done.error);assert.equal(done.roundNumber??1,1);assert.equal(done.autonomyCycle??1,1);
      assert.equal(done.history!.length,1);assert.deepEqual(done.goal,draft.goal);
      assert.equal(done.executionPlans!.length,1,"content response is not a second management plan");
      const source=done.workUnits.find(u=>u.contentCheck?.stage==="initial" && !u.planPhase)!;
      assert.equal(done.runs.filter(r=>r.workUnitId===source.id).length,1,"the initial work never restarts");
      assert.equal(done.runs.filter(r=>r.role==="reporter").length,1);assert.equal(done.runs.filter(r=>r.role==="reviewer").length,2);
      const response=done.workUnits.filter(u=>u.contentCheck?.stage==="response");
      assert.equal(response.length,scenario==="improve"?2:1);assert.ok(response.every(u=>u.output!.includes("contentDecision")));
      if(scenario==="no-peer"||scenario==="peer-failure") {
        assert.equal(reader,undefined);
        if(scenario==="peer-failure")assert.match(done.retiredWorkUnits!.find(u=>u.contentCheck?.stage==="peer")!.error!,/未実施/);
      } else {
        assert.ok(reader);assert.notEqual(reader.assignedAgentId,source.assignedAgentId);
        assert.ok(calls.slice(before).some(c=>c.prompt.includes("# 主担当の内容点検・終了判断")&&c.prompt.includes("CONTENT_READER")));
      }
      assert.ok(calls.slice(before).filter(c=>c.prompt.includes("# 主担当の内容点検・終了判断")).every(c=>c.mode==="write"));
      await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    }
    standardContentTaskId=undefined;contentPeerFailure=false;useResultChannel=false;holdSubtasks=false;
    if(process.env.HARNESS_CONTENT_CYCLE_TEST_ONLY==="1")return;
    // Real IPC, saved graph, router, skill retrieval and report/review gates;
    // only CLI answers and external tools are fixture-backed.
    const refinement = await createAuto("Content improvement fixture");
    const beforeRefinement = calls.length;
    refinementPlanNext = true; specialistPeak = 0; useResultChannel = true;
    await ipc("task:run", refinement.id);
    await waitFor(async () => (await getTask(refinement.id)).awaitingReason === "result");
    useResultChannel = false;
    const refined = await getTask(refinement.id), refinedCalls = calls.slice(beforeRefinement);
    assert.equal(refined.autonomyState, "satisfied", refined.error);
    assert.equal(specialistPeak, 2);
    assert.deepEqual(refined.executionPlans![0].refinement?.proposalKeys, ["alternative", "challenge"]);
    const peers = refined.workUnits.filter(u => ["alternative", "challenge"].includes(u.subtask?.key ?? ""));
    assert.ok(peers.every(u => u.state === "completed"));
    assert.equal(new Set(peers.map(u => u.assignedAgentId)).size, 2, "existing router spreads simultaneous peers across available services");
    assert.ok(peers.every(u => refined.runs.find(r => r.workUnitId === u.id)?.skillUsage?.reads.some(s => s.id === "content-refinement")));
    const adoption = refinedCalls.find(c => c.prompt.includes("# 内容改善の採否・実作業への反映"))!;
    assert.ok(adoption && adoption.mode === "write");
    assert.match(adoption.prompt, /REFINEMENT_ALTERNATIVE/); assert.match(adoption.prompt, /REFINEMENT_CHALLENGE/);
    assert.ok(refined.runs.find(r => r.role === "reporter")?.finishingCheck);
    assert.ok(refined.runs.some(r => r.role === "reviewer" && r.state === "completed"));
    for (const c of refinedCalls.filter(c => c.prompt.includes("# Required structured goal review"))) {
      assert.doesNotMatch(c.prompt, /REFINEMENT_ALTERNATIVE|REFINEMENT_CHALLENGE/);
      assert.ok(!c.skillContents?.["content-refinement"]);
    }
    assert.deepEqual(JSON.parse(await readFile(join(directory, "tasks.json"), "utf8")).tasks.find((t: TaskRecord) => t.id === refinement.id).executionPlans, refined.executionPlans);
    if (process.env.HARNESS_CONTENT_REFINEMENT_TEST_ONLY === "1") return;
    primaryMilestonesSeen = 0; // this scenario's two milestones are not the later milestone fixture
    for (const repair of [false,true]) {
      const timed = await createAuto(`Time adaptive review ${repair}`,3,"primary",["codex","claude","antigravity"],1);
      await ipc("task:execution",timed.id,{...timed.execution,reviewMode:"cross-service"});
      reviewResults=repair?["fail","pass"]:[];reviewConcerns=[];
      await ipc("task:run",timed.id);
      await waitFor(async()=>{
        const t=await getTask(timed.id);
        if(["paused","blocked","failed"].includes(t.state))throw new Error(t.error);
        return t.awaitingReason==="result";
      });
      const done=await getTask(timed.id);
      assert.equal(done.autonomyState,"satisfied",done.error);
      assert.equal(done.workUnits.filter(u=>u.role==="reviewer").length,1);
      assert.equal(done.runs.filter(r=>r.role==="reviewer").length,repair?2:1);
      assert.equal(done.reviewAdjustments?.length,repair?2:1);
      assert.ok(done.reviewAdjustments?.every(a=>a.mode==="single"&&a.omittedUnits.length===1));
      assert.ok(done.workUnits.filter(u=>u.role==="reviewer").every(u=>u.state==="completed"&&!u.crossReview));
      await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskId);
      await ipc("task:complete",timed.id);
      assert.equal((await getTask(timed.id)).state,"completed");
    }
    // Repeated substantive blockers close honestly after one repair. Even a
    // blocked editorial receipt and failed independent reviews are preserved.
    const partialTask = await createAuto("Bounded partial closure",3,"primary");
    useResultChannel=true;
    checkResults=["needs-work","needs-work"];
    reviewResults=["fail","unverified"]; missingReportPrerequisites=1;
    await ipc("task:run",partialTask.id);
    await waitFor(async()=>{
      const t=await getTask(partialTask.id);
      if (["paused","blocked","failed"].includes(t.state)) throw new Error(t.error);
      return !!t.workClosure?.finishedAt;
    });
    const partial=await getTask(partialTask.id);
    assert.equal(partial.autonomyState,"needs-input");
    assert.equal(partial.workUnits.filter(u=>u.primary&&!u.planPhase).length,2);
    assert.equal(partial.runs.filter(r=>r.role==="reporter").length,1);
    assert.equal(partial.runs.find(r=>r.role==="reporter")!.finishingCheck!.status,"blocked");
    assert.equal(partial.workUnits.filter(u=>u.role==="reviewer"&&u.state==="completed").length,2);
    assert.ok(partial.evaluations?.some(e=>e.criteria.some(c=>c.status==="fail")));
    assert.ok(partial.workClosure!.issues.some(s=>s.includes("unverified")));
    assert.ok(partial.report?.pdfPath); assert.equal(partial.error!.length<100,true);
    await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    await assert.rejects(()=>ipc("task:complete",partial.id),/全体合格にはできません/);
    await assert.rejects(()=>ipc("task:resume",partial.id),/再開できる中断工程がありません/);
    useResultChannel=false;
    const reportHandoff = await createAuto("Report handoff preserves quality concerns",3,"primary");
    checkResults=["report-ready"]; qualityFailureNext="work";
    await ipc("task:run",reportHandoff.id);
    await waitFor(async()=>!!(await getTask(reportHandoff.id)).workClosure?.finishedAt);
    const handed=await getTask(reportHandoff.id);
    assert.equal(handed.workUnits.filter(u=>u.primary&&!u.planPhase).length,1,"report handoff must not loop through worker for downstream verification");
    assert.notEqual(handed.autonomyState,"satisfied");
    await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    // An exhausted IDEA stage used to stop indefinitely because future modes
    // were pending. They remain explicitly unperformed, never fake successes.
    const researchClosurePreset=(await ipc("presets:list")).presets.find((p:any)=>p.manifest.id==="research-project");
    // Reproduce saved pre-redesign snapshots, not today's integrated defaults.
    // These cases specifically exercise recovery of unperformed legacy stages.
    const preserveLegacyDocumentWorkflow = async (task: TaskRecord) => {
      const preset=structuredClone(task.workPreset!);
      delete preset.manifest.integratedWorkflow; delete preset.manifest.primaryDocument;
      preset.manifest.document="paper";
      preset.documentTemplate={id:"paper",source:await readFile(join(process.cwd(),"assets/document-templates/paper/main.tex"),"utf8"),latexmkrc:await readFile(join(process.cwd(),"assets/document-templates/latexmkrc"),"utf8")};
      await fixtureStore!.update(task.id,{workPreset:preset});
    };
    const researchClosureDraft=await ipc("task:create",{title:"Early research partial closure",prompt:"Investigate evidence",cwd:directory,
      goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex","claude","antigravity"],modelOverrides:{},
      presetId:"research-project",presetRevision:researchClosurePreset.revision});
    await preserveLegacyDocumentWorkflow(researchClosureDraft);
    const researchClosure=await ipc("goals:save",researchClosureDraft.id,{...researchClosureDraft.goal,questions:[]},researchClosureDraft.goal.revision,true,{enabled:true,maxCycles:2});
    await ipc("task:execution",researchClosure.id,{...researchClosure.execution,reviewMode:"cross-service"});
    checkResults=["needs-work","needs-work"];reviewResults=["fail","unverified"];
    await ipc("task:run",researchClosure.id);
    await waitFor(async()=>{
      const t=await getTask(researchClosure.id);
      if(["paused","blocked","failed"].includes(t.state)||t.state==="awaiting-input"&&!t.workClosure?.finishedAt)throw new Error(t.error);
      return !!t.workClosure?.finishedAt;
    });
    const researchPartial=await getTask(researchClosure.id);
    assert.deepEqual(researchPartial.retiredWorkUnits?.map(u=>u.researchStage),["research","coding","paper"]);
    assert.ok(researchPartial.retiredWorkUnits?.every(u=>u.state==="cancelled"));
    assert.equal(researchPartial.runs.filter(r=>r.role==="reporter").length,1);
    assert.equal(researchPartial.runs.filter(r=>r.role==="reviewer").length,2);
    assert.equal(researchPartial.autonomyCycle,1);
    assert.notEqual(researchPartial.autonomyState,"satisfied");
    await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    // Reproduce a persisted old-version stop through the EXACT renderer IPC.
    // Its last worker has already completed/checkpointHandled, so ordinary
    // resumableUnit cannot find an interrupted unit.
    const legacyUnits=[...researchPartial.workUnits.filter(u=>u.role!=="reporter"&&u.role!=="reviewer"),
      ...researchPartial.retiredWorkUnits!.map(u=>({...u,state:"pending" as const,error:undefined})),
      ...researchPartial.workUnits.filter(u=>u.role==="reporter"||u.role==="reviewer").map(u=>({...u,state:"pending" as const,
        startedAt:undefined,completedAt:undefined,output:undefined,error:undefined,
        ...(u.role==="reporter"?{dependsOn:[researchPartial.retiredWorkUnits!.at(-1)!.id]}:{})}))];
    const preservedRuns=researchPartial.runs.filter(r=>r.role!=="reporter"&&r.role!=="reviewer");
    await fixtureStore!.update(researchPartial.id,{workClosure:undefined,retiredWorkUnits:undefined,history:[],evaluations:[],
      workUnits:legacyUnits,runs:preservedRuns,state:"awaiting-input",awaitingReason:"result",resumeFromUnitId:undefined,
      error:"残作業の差戻し回数上限です。未解決の品質検証を保持。"});
    const beforeLegacy=calls.length;
    reviewResults=["fail","unverified"];
    await ipc("task:resume",researchPartial.id);
    await waitFor(async()=>{
      const t=await getTask(researchPartial.id);
      if(["paused","blocked","failed"].includes(t.state))throw new Error(t.error);
      return !!t.workClosure?.finishedAt;
    });
    const legacyFinished=await getTask(researchPartial.id);
    assert.equal(calls.length-beforeLegacy,3,"resume must run only reporter and two reviews, not workers");
    assert.deepEqual(legacyFinished.goal,researchPartial.goal);
    assert.equal(legacyFinished.retiredWorkUnits!.length,3);
    assert.deepEqual(legacyFinished.runs.slice(0,preservedRuns.length),preservedRuns);
    await assert.rejects(()=>ipc("task:resume",researchPartial.id),/再開できる中断工程がありません/);
    // An old coding closure retired PAPER, then demanded its missing PDF. Real
    // resume IPC must restore that saved stage, not rerun coding or loop over
    // the same missing research protocol. No real CLI, GPU or SSH is invoked.
    const writingDraft=await ipc("task:create",{title:"Recover archived required paper",prompt:"Use existing evidence",cwd:directory,
      goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex","claude","antigravity"],modelOverrides:{},
      presetId:"research-project",presetRevision:researchClosurePreset.revision});
    await preserveLegacyDocumentWorkflow(writingDraft);
    const writingTask=await ipc("goals:save",writingDraft.id,{...writingDraft.goal,questions:[]},writingDraft.goal.revision,true,{enabled:true,maxCycles:3});
    const coding=writingTask.workUnits.find((u:any)=>u.researchStage==="coding")!;
    const paper=writingTask.workUnits.find((u:any)=>u.researchStage==="paper")!;
    const reportUnit=writingTask.workUnits.find((u:any)=>u.role==="reporter")!;
    const reviewUnits=writingTask.workUnits.filter((u:any)=>u.role==="reviewer");
    const report=require("./report-service").ReportService;
    const draftReport=await new report().syncDraft(writingTask,(await ipc("app:snapshot")).reportSettings,true);
    await fixtureStore!.update(writingTask.id,{state:"paused",resumeFromUnitId:reportUnit.id,
      workUnits:[{...coding,state:"completed",planPhase:false,checkpointHandled:true,dependsOn:[],output:"Saved coding evidence"},
        {...reportUnit,dependsOn:[coding.id]},...reviewUnits.map((u:any)=>({...u,dependsOn:u.reviewPass===2?[reviewUnits[0].id]:[reportUnit.id]}))],
      retiredWorkUnits:[{...paper,state:"cancelled",dependsOn:[coding.id],error:"再作業上限のため未実施。部分成果の報告・独立レビューへ移行。"}],
      report:{...draftReport,state:"ready",documents:{paper:{...draftReport.documents.paper,state:"failed",error:"PDF missing"}}},
      workClosure:{round:1,cycle:1,goalRevision:writingTask.goal.revision,startedAt:new Date().toISOString(),reason:"repair cap",issues:["研究の評価条件が未登録です。"]}});
    const beforeWriting=calls.length;
    checkResults=["needs-work"];reviewResults=["fail","unverified"];
    await ipc("task:resume",writingTask.id);
    await waitFor(async()=>{
      const t=await getTask(writingTask.id);
      if(["paused","blocked","failed"].includes(t.state))throw new Error(t.error);
      return !!t.workClosure?.finishedAt;
    });
    const writingDone=await getTask(writingTask.id);
    assert.equal(writingDone.roundNumber,writingTask.roundNumber);
    assert.deepEqual(writingDone.goal,writingTask.goal);
    assert.equal(writingDone.workUnits.find((u:any)=>u.id===paper.id)!.state,"completed");
    assert.equal(writingDone.runs.filter((r:any)=>r.workUnitId===coding.id).length,0,"prior implementation must not restart");
    const paperOwner=writingDone.workUnits.find(u=>u.primary&&!u.planPhase&&u.researchStage==="paper")!;
    assert.equal(writingDone.runs.filter(r=>r.workUnitId===paperOwner.id).length,1,"unfinished scientific conditions must not trigger more writing self-checks");
    assert.equal(paperOwner.workAttempt,undefined,"no additional worker retry is created");
    assert.equal(writingDone.runs.filter((r:any)=>r.role==="reporter").length,1);
    assert.equal(writingDone.runs.filter((r:any)=>r.role==="reviewer").length,2);
    assert.equal(writingDone.report!.documents!.paper!.state,"ready");
    assert.ok(writingDone.workClosure!.issues.some((s:string)=>s.includes("未登録")));
    assert.notEqual(writingDone.autonomyState,"satisfied");
    assert.ok(calls.length-beforeWriting>=5,"paper planning, writing, reporter and independent reviews must actually run");
    await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    // Persist the exact old bug: closure exists, paper result was consumed as a
    // retry-limit stop, reporter/reviews still pending. Resume adds concerns and
    // starts only the downstream stages, retaining all earlier IDs and logs.
    const savedWritingRuns=writingDone.runs.filter(r=>r.role!=="reporter"&&r.role!=="reviewer");
    await fixtureStore!.update(writingDone.id,{state:"awaiting-input",awaitingReason:"result",resumeFromUnitId:undefined,
      error:"残作業の差戻し回数上限です。Writing done; scientific conditions remain unmet.",
      workClosure:{...writingDone.workClosure!,finishedAt:undefined},runs:savedWritingRuns,evaluations:[],
      workUnits:writingDone.workUnits.map(u=>u.role==="reporter"||u.role==="reviewer"?{...u,state:"pending",startedAt:undefined,completedAt:undefined,output:undefined}:u)});
    const beforeClosureResume=calls.length;
    reviewResults=["fail","unverified"];
    await ipc("task:resume",writingDone.id);
    await waitFor(async()=>{
      const t=await getTask(writingDone.id);
      if(["paused","blocked","failed"].includes(t.state))throw new Error(t.error);
      return !!t.workClosure?.finishedAt;
    });
    const closureResumed=await getTask(writingDone.id);
    assert.equal(calls.length-beforeClosureResume,3,"run reporter and two reviews, not another worker");
    assert.deepEqual(closureResumed.runs.slice(0,savedWritingRuns.length),savedWritingRuns);
    assert.deepEqual(closureResumed.goal,writingDone.goal);
    assert.equal(closureResumed.roundNumber,writingDone.roundNumber);
    assert.notEqual(closureResumed.autonomyState,"satisfied");
    await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    // Run the real closing workflow: a concrete manuscript-only defect gets
    // one reporter correction and fresh reviews, never a new research cycle.
    const pendingFinishing=closureResumed.workUnits.map(u=>u.role==="reporter"||u.role==="reviewer"
      ? {...u,state:"pending" as const,startedAt:undefined,completedAt:undefined,output:undefined,error:undefined,assignedAgentId:undefined,attemptedAgentIds:[]} : u);
    const oldReportId=pendingFinishing.find(u=>u.role==="reporter")!.id;
    await fixtureStore!.update(closureResumed.id,{state:"paused",resumeFromUnitId:oldReportId,history:[],evaluations:[],
      workUnits:pendingFinishing,workClosure:{...closureResumed.workClosure!,finishedAt:undefined},
      runs:closureResumed.runs.filter(r=>r.role!=="reporter"&&r.role!=="reviewer")});
    reportCorrections=[["Clarify the saved numeric precision in the manuscript."],[],[],[]];
    reviewResults=["fail","unverified","fail","unverified"];
    const beforeCorrection=calls.length;
    await ipc("task:resume",closureResumed.id);
    await waitFor(async()=>{
      const t=await getTask(closureResumed.id);
      if(["paused","blocked","failed"].includes(t.state))throw new Error(t.error);
      return !!t.workClosure?.finishedAt;
    });
    const correctedClosure=await getTask(closureResumed.id);
    assert.equal(calls.length-beforeCorrection,6,"reporter + two reviews, one corrected reporter + two fresh reviews");
    assert.ok(correctedClosure.workClosure!.reportCorrectionAttemptedAt);
    assert.deepEqual(correctedClosure.goal,closureResumed.goal);
    assert.equal(correctedClosure.autonomyCycle,closureResumed.autonomyCycle);
    assert.notEqual(correctedClosure.autonomyState,"satisfied");
    assert.equal(correctedClosure.evaluations!.length,4,"original independent findings remain in history");
    assert.notEqual(correctedClosure.workUnits.find(u=>u.role==="reporter")!.id,oldReportId);
    assert.ok(correctedClosure.retiredWorkUnits!.some(u=>u.id===oldReportId));
    assert.ok(calls.slice(beforeCorrection).every(c=>!c.prompt.includes("INITIAL OR REQUIRED REPLAN")),"no worker/planner loop");
    reportCorrections=[];
    await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    if(process.env.HARNESS_CLOSURE_TEST_ONLY === "1") return;
    for (const scenario of ["pass", "repair", "format", "resume", "reduce"]) {
      const cross = await createAuto(`Cross services ${scenario}`, 3, "primary");
      await ipc("task:execution", cross.id, { ...cross.execution, scheduling: "throughput", reviewMode: "cross-service", maxParallel: 3 });
      crossPeak = 0; reviewResults = scenario === "format" ? ["invalid"] : [];
      reviewConcerns = scenario === "repair" ? [["Check the numerical boundary"]] : [];
      if (scenario === "resume" || scenario === "reduce") failRoleOnce = "reviewer";
      const before: number = calls.length;
      await ipc("task:run", cross.id);
      let preservedReviews: string[] = [];
      if (scenario === "resume" || scenario === "reduce") {
        await waitFor(async () => (await getTask(cross.id)).state === "paused");
        const paused = await getTask(cross.id);
        preservedReviews = paused.workUnits.filter(u => u.crossReview && u.state === "completed").map(u => u.id);
        assert.equal(preservedReviews.length, 2);
        assert.equal(paused.evaluations?.length, 2);
        assert.ok(paused.workUnits.filter(u => u.crossReview?.wave === 2).every(u => u.state === "pending"));
        if(scenario==="reduce") {
          await waitFor(()=>!lastQueue?.activeTaskIds.includes(cross.id));
          const failed=paused.runs.find(r=>r.state==="failed")!;
          assert.equal((await ipc("terminal:review-reduction",cross.id,failed.id,false)).enabled,true);
          const beforeReduction=JSON.stringify((await getTask(cross.id)).workUnits);
          terminalSnapshots.set(failed.id,{alive:true,inputAllowed:false});
          await assert.rejects(()=>ipc("terminal:review-reduction",cross.id,failed.id,true),/残っています/);
          assert.equal(JSON.stringify((await getTask(cross.id)).workUnits),beforeReduction);
          terminalSnapshots.set(failed.id,{alive:false,inputAllowed:false});
          await ipc("terminal:review-reduction",cross.id,failed.id,true);terminalSnapshots.delete(failed.id);
        } else {
          const draft: FollowupInput = { instruction: "Saved for a separate round, never apply on resume", kind: "continue", assignments: {}, pauseAfterPlan: false };
          await ipc("task:followup", cross.id, draft, false);
          await ipc("task:resume", cross.id);
          assert.deepEqual((await getTask(cross.id)).pendingFollowup, draft);
        }
      }
      await waitFor(async () => {
        const current = await getTask(cross.id);
        if (["paused", "blocked", "failed"].includes(current.state)) throw new Error(JSON.stringify({ scenario, state: current.state, error: current.error, units: current.workUnits.map(u => ({ title: u.title, state: u.state, error: u.error })) }));
        return current.awaitingReason === "result";
      });
      const done = await getTask(cross.id);
      assert.equal(done.autonomyState, "satisfied", done.error);
      assert.equal(crossPeak, scenario==="reduce"?2:3);
      const reviewUnits = done.workUnits.filter(u => u.crossReview);
      assert.equal(reviewUnits.length, scenario==="reduce"?4:6); assert.ok(reviewUnits.every(u => u.state === "completed"));
      assert.equal(new Set(reviewUnits.filter(u => u.crossReview!.wave === 1).map(u => u.crossReview!.providerKey)).size, scenario==="reduce"?2:3);
      if(scenario==="reduce") {
        assert.equal(done.crossReviewReplans?.length,1);assert.equal(done.retiredWorkUnits?.length,2);
        assert.equal(done.runs.filter(r=>r.state==="failed").length,1);
        assert.ok(preservedReviews.every(id=>done.runs.filter(r=>r.workUnitId===id).length===1));
      }
      assert.equal(done.autonomyCycle ?? 1, scenario === "repair" ? 2 : 1);
      const reviewCalls: typeof calls = calls.slice(before).filter(c => c.prompt.includes("# Required structured goal review"));
      assert.ok(reviewCalls.every(c => c.mode === "read" && !c.continueSession));
      for (const c of reviewCalls.filter(c => c.prompt.includes("# Blind independent review"))) assert.doesNotMatch(c.prompt, /Fixture review/);
      for (const c of reviewCalls.filter(c => c.prompt.includes("# Cross-service review"))) assert.match(c.prompt, /Fixture review/);
      if (scenario === "repair") assert.equal(done.autonomyHistory!.at(-1)!.workUnits.filter(u => u.crossReview && u.state === "completed").length, 6);
      if (scenario === "format") assert.equal(reviewCalls.length, 7);
      if (scenario === "resume") {
        assert.equal(reviewCalls.length, 7);
        assert.equal(done.pendingFollowup?.instruction, "Saved for a separate round, never apply on resume");
        assert.ok(calls.slice(before).every(c => !c.prompt.includes("Saved for a separate round, never apply on resume")));
        await assert.rejects(() => ipc("task:complete", cross.id), /保存済みの追加指示/);
        await ipc("task:discard-followup", cross.id);
        assert.ok(preservedReviews.every(id => done.runs.filter(r => r.workUnitId === id).length === 1));
      }
      await ipc("task:complete", cross.id);
    }
    const proseTask = await createAuto("Structured results outside the terminal", 3, "primary", ["codex", "claude"]);
    useResultChannel = true;
    await ipc("task:run", proseTask.id);
    await waitFor(async () => (await getTask(proseTask.id)).awaitingReason === "result");
    const proseResult = await getTask(proseTask.id);
    useResultChannel = false;
    assert.equal(proseResult.autonomyState, "satisfied");
    assert.ok(proseResult.executionPlans?.length);
    assert.ok(proseResult.runs.every(r => !/<(execution-plan|goal-evaluation|work-check)>/.test(r.displayOutput ?? "")));
    assert.ok(proseResult.workUnits.some(u => u.output?.includes("<goal-evaluation>")), "validators still receive the full management result");
    const formatTask = await createAuto("Repair omitted concerns without stopping");
    reviewResults = ["missing-concerns", "pass", "pass"];
    const beforeFormat = calls.length;
    await ipc("task:run", formatTask.id);
    await waitFor(async () => (await getTask(formatTask.id)).awaitingReason === "result");
    const formatResult = await getTask(formatTask.id);
    assert.equal(formatResult.autonomyState, "satisfied"); assert.equal(formatResult.autonomyCycle, 1);
    const firstReview = formatResult.workUnits.find(u => u.reviewPass === 1)!;
    assert.equal(firstReview.reviewFormatRetries, 1);
    assert.equal(formatResult.runs.filter(r => r.workUnitId === firstReview.id).length, 2);
    assert.equal(formatResult.evaluations?.filter(e => e.reviewPass).length, 2);
    assert.ok(calls.slice(beforeFormat).some(c => c.prompt.includes("# Correct this review's rejected submission") && c.prompt.includes("concerns")));
    const formatLoop = await createAuto("Bound repeated schema failures");
    reviewResults = ["missing-concerns", "missing-concerns", "missing-concerns"];
    await ipc("task:run", formatLoop.id);
    await waitFor(async () => (await getTask(formatLoop.id)).state === "paused");
    const formatStopped = await getTask(formatLoop.id);
    assert.match(formatStopped.error!, /自動修正を2回/);
    assert.equal(formatStopped.workUnits.find(u => u.reviewPass === 2)!.state, "pending");
    assert.equal(formatStopped.evaluations?.length ?? 0, 0);
    await ipc("task:resume", formatLoop.id);
    await waitFor(async () => (await getTask(formatLoop.id)).awaitingReason === "result");
    assert.equal((await getTask(formatLoop.id)).autonomyState, "satisfied");
    for (const scenario of ["second-fails", "concern", "changed-evidence"] as const) {
      const current = await createAuto(scenario);
      reviewResults = scenario === "second-fails" ? ["pass", "fail", "pass", "pass"] : [];
      reviewConcerns = scenario === "concern" ? [[], ["Check the unresolved boundary condition"]] : [];
      mutateSecondReview = scenario === "changed-evidence";
      await ipc("task:run", current.id);
      await waitFor(async () => (await getTask(current.id)).awaitingReason === "result");
      const result = await getTask(current.id);
      assert.equal(result.autonomyCycle, 2, scenario);
      assert.equal(result.autonomyState, "satisfied", scenario);
      assert.equal(result.evaluations?.filter(e => e.reviewPass).length, 4);
      assert.ok(result.autonomyHistory?.[0].workUnits.filter(u => u.reviewPass).every(u => u.state === "completed"));
      assert.equal(mutateSecondReview, false);
    }
    const twoCli = await createAuto("Two CLI reviewer fallback", 3, "primary");
    await ipc("task:allowed-agents", twoCli.id, ["codex", "claude"]);
    const twoCliStart = calls.length;
    reviewResults = ["pass", "fail", "pass", "pass"];
    await ipc("task:run", twoCli.id);
    await waitFor(async () => (await getTask(twoCli.id)).awaitingReason === "result");
    const twoCliResult = await getTask(twoCli.id);
    assert.equal(twoCliResult.autonomyState, "satisfied");
    assert.equal(twoCliResult.autonomyCycle, 2);
    assert.deepEqual(twoCliResult.evaluations?.filter(e => e.reviewPass).map(e => e.reviewerAgentId), ["claude", "codex", "claude", "codex"]);
    for (const call of calls.slice(twoCliStart).filter(c => c.prompt.includes("# Required structured goal review"))) {
      assert.equal(call.mode, "read"); assert.equal(call.continueSession, undefined);
      assert.doesNotMatch(call.prompt, /Fixture review/);
    }
    await ipc("task:complete", twoCli.id);
    const shortage = await createAuto("Two available CLIs required");
    // Only one of these tools is installed; it cannot perform both reviews.
    await ipc("task:allowed-agents", shortage.id, ["codex", "opencode"]);
    await assert.rejects(() => ipc("task:allowed-agents", shortage.id, ["codex"]));
    await assert.rejects(() => ipc("task:allowed-agents", shortage.id, ["codex", "claude", "unknown"]));
    await ipc("task:run", shortage.id);
    await waitFor(async () => (await getTask(shortage.id)).state === "blocked");
    const blockedPair = await getTask(shortage.id);
    assert.equal(blockedPair.workUnits.find(u => u.reviewPass === 1)?.state, "completed");
    assert.notEqual(blockedPair.workUnits.find(u => u.reviewPass === 2)?.state, "completed");
    await ipc("task:allowed-agents", shortage.id, ["codex", "claude"]);
    await ipc("task:resume", shortage.id);
    await waitFor(async () => (await getTask(shortage.id)).awaitingReason === "result");
    assert.equal((await getTask(shortage.id)).autonomyState, "satisfied");
    const auto = await createAuto("Autonomous repair");
    reviewResults = ["fail", "pass", "pass"];
    const start = calls.length;
    await ipc("task:run", auto.id);
    await waitFor(async () => (await getTask(auto.id)).awaitingReason === "result");
    const passed = await getTask(auto.id);
    assert.equal(calls.length - start, 8,JSON.stringify(calls.slice(start).map(c=>c.prompt.match(/# Your role: ([^\n]+)/)?.[1]))); assert.equal(passed.autonomyCycle, 2); assert.equal(passed.autonomyState, "satisfied");
    assert.equal(passed.evaluations?.length, 5); assert.equal(passed.autonomyHistory?.length, 1);
    const sequence = passed.evaluations!.filter(e => e.reviewPass);
    assert.deepEqual(sequence.map(e => e.reviewNumber), [1, 2, 3]);
    assert.equal(sequence[0].criteria[0].status, "fail");
    assert.ok(sequence.slice(1).every((e, i) => e.reviewerAgentId !== sequence[i].reviewerAgentId), "adjacent reviewers alternate across repair boundaries");
    assert.equal(passed.autonomyHistory![0].workUnits.filter(u => u.role === "reviewer" && u.state === "completed").length, 1, "do not run a second review of known failing artifacts");
    assert.ok(calls[start + 1].prompt.includes("<work-check>"));
    assert.ok(calls[start + 2].prompt.includes("# TeX build instructions"));
    assert.ok(calls[start + 3].prompt.includes("# Required structured goal review"));
    assert.match(calls[start + 4].prompt, /Repair ONLY/);
    assert.ok(calls.slice(start).every(c => c.prompt.includes(`${auto.autonomy!.targetMinutes} minutes`) && c.prompt.includes("SOFT TARGET")));
    await waitFor(async () => !(await ipc("app:snapshot")).queue.activeTaskId);
    await writeFile(join(directory, "evidence.txt"), "changed after review");
    await assert.rejects(() => ipc("task:complete", auto.id), /検証後/);
    // Review-only remains read-only and can re-establish the evidence, without a repair loop.
    await ipc("task:followup", auto.id, { ...input, kind: "review" }, true);
    await waitFor(async () => (await getTask(auto.id)).awaitingReason === "result");
    await waitFor(async () => !(await ipc("app:snapshot")).queue.activeTaskId);
    await ipc("task:complete", auto.id);
    for (const [name, results, expected, max] of [["bounded", ["fail", "fail"], "cycle-limit", 2], ["question", ["ask-user"], "needs-input", 3]] as const) {
      const current = await createAuto(name, max); reviewResults = [...results];
      await ipc("task:run", current.id);
      await waitFor(async () => (await getTask(current.id)).awaitingReason === "result");
      assert.equal((await getTask(current.id)).autonomyState, expected);
      await assert.rejects(() => ipc("task:complete", current.id));
      await waitFor(async () => !(await ipc("app:snapshot")).queue.activeTaskId);
    }
    const reportOnly = await createAuto("Report-only remaining work",3,"primary");
    checkResults = ["report-ready"];
    await ipc('task:run',reportOnly.id);
    await waitFor(async()=>(await getTask(reportOnly.id)).awaitingReason==='result');
    const transferred = await getTask(reportOnly.id);
    assert.equal(transferred.workUnits.some(u=>u.title.startsWith('残作業の実行')),false);
    assert.equal(transferred.runs.filter(r=>r.role==='reporter').length,1);
    assert.equal(transferred.runs.filter(r=>r.role==='reviewer').length,2);
    assert.ok(transferred.runs.find(r=>r.role==='reporter')?.finishingCheck);
    assert.match(transferred.workUnits.find(u=>u.role==='reporter')!.instructions,/Compile PDF/);
    // The primary owner repairs missing work instead of making the reporter fill the gap.
    const retry = await createAuto("Missing worker artifacts"); checkResults = ["needs-work", "ready"];
    const retryStart = calls.length;
    await ipc("task:run", retry.id);
    await waitFor(async () => (await getTask(retry.id)).awaitingReason === "result");
    assert.equal((await getTask(retry.id)).autonomyState, "satisfied");
    assert.equal(calls.length - retryStart, 6);
    assert.match(calls[retryStart + 2].prompt, /Required remaining work/);
    for (const check of ["ask-user", "invalid"]) {
      const stopped = await createAuto(check); checkResults = check === "invalid" ? [check,check,check] : [check]; const before: number = calls.length;
      await ipc("task:run", stopped.id);
      await waitFor(async () => check === "invalid" ? (await getTask(stopped.id)).state === "paused" : (await getTask(stopped.id)).awaitingReason === "result");
      if (check === "ask-user") { assert.equal((await getTask(stopped.id)).autonomyState, "needs-input"); await assert.rejects(() => ipc("task:resume", stopped.id)); }
      else assert.ok((await getTask(stopped.id)).resumeFromUnitId);
      assert.equal(calls.length - before, check === "invalid" ? 4 : 2);
      assert.ok(!calls.slice(before).some(c => c.prompt.includes("# TeX build instructions")));
      if (check === "invalid") {
        await ipc("task:resume", stopped.id);
        await waitFor(async () => { const t = await getTask(stopped.id); return t.autonomyState === "satisfied" && t.awaitingReason === "result"; });
      }
    }
    // Malformed evidence is returned to the same role, not treated as missing
    // user approval or silently stripped. Real missing work uses the writer loop.
    for (const strategy of ["primary"] as const) {
      const repaired = await createAuto(`Repair evidence ${strategy}`,3,strategy);
      checkResults = strategy === "primary" ? ["path-prose","needs-work","ready"] : ["path-prose","ready"];
      const before: number = calls.length;
      await ipc("task:run",repaired.id);
      await waitFor(async ()=>(await getTask(repaired.id)).autonomyState === "satisfied");
      await waitFor(async ()=>!(await ipc("app:snapshot")).queue.activeTaskId);
      const done = await getTask(repaired.id);
      const retried = done.workUnits.find(u=>u.workCheckRetries === 1)!;
      assert.ok(retried); assert.equal(retried.checkpointHandled,true);
      const correction: typeof calls[number] = calls.slice(before).find(c=>c.prompt.includes("# Correct this rejected progress submission"))!;
      assert.ok(correction); assert.match(correction.prompt,/Preserve this substantive uncertainty/);
      assert.match(correction.prompt,/全criterion ID別の証拠/);
      assert.equal(correction.mode,strategy === "primary" ? "write" : "read");
      assert.equal(done.runs.filter(r=>r.role === "reporter").length,1);
      assert.equal(done.runs.filter(r=>r.role === "reviewer").length,2);
      if (strategy === "primary") {
        const returned = done.workUnits.find(u=>u.title.startsWith("残作業の実行"))!;
        assert.ok(returned); assert.equal(returned.workCheckFeedback,undefined);
      }
    }
    // Interrupted work/build/review resumes the same round and reaches final review.
    for (const role of ["worker", "reporter", "reviewer", "invalid-review"]) {
      const interrupted = await createAuto(`Resume ${role}`);
      if (role === "invalid-review") reviewResults = ["invalid"];
      else failRoleOnce = role;
      await ipc("task:run", interrupted.id);
      await waitFor(async () => (await getTask(interrupted.id)).state === "paused");
      const paused = await getTask(interrupted.id);
      const resumeId = paused.resumeFromUnitId!;
      assert.equal(paused.workUnits.find(u => u.id === resumeId)!.role, role === "invalid-review" ? "reviewer" : role);
      const finished = paused.workUnits.filter(u => u.state === "completed" && u.id !== resumeId).map(u => u.id);
      const beforeResume: number = calls.length;
      let handoffAgent:string|undefined;
      const oldAttempt=paused.runs.filter(r=>r.workUnitId===resumeId).at(-1)!;
      if(role==="worker") {
        await waitFor(()=>!lastQueue?.activeTaskIds.includes(interrupted.id));
        const choices=await ipc("terminal:handoff-options",interrupted.id,oldAttempt.id);
        handoffAgent=choices.find((c:any)=>c.enabled)?.agentId;assert.ok(handoffAgent);
        const before=await getTask(interrupted.id);
        terminalSnapshots.set(oldAttempt.id,{alive:true,inputAllowed:false});
        await assert.rejects(()=>ipc("terminal:handoff",interrupted.id,oldAttempt.id,handoffAgent),/残っています/);
        assert.deepEqual((await getTask(interrupted.id)).workUnits,before.workUnits,"failed exit check must not mutate assignments");
        terminalSnapshots.set(oldAttempt.id,{alive:false,inputAllowed:false});
        await ipc("terminal:handoff",interrupted.id,oldAttempt.id,handoffAgent);
        await assert.rejects(()=>ipc("terminal:handoff",interrupted.id,oldAttempt.id,handoffAgent));
      } else await ipc("task:resume", interrupted.id);
      await assert.rejects(() => ipc("task:resume", interrupted.id));
      await waitFor(async () => { const t = await getTask(interrupted.id); return t.autonomyState === "satisfied" && t.awaitingReason === "result"; });
      const resumed = await getTask(interrupted.id);
      if(handoffAgent) {
        assert.equal(resumed.runs.filter(r=>r.workUnitId===resumeId).at(-1)!.agentId,handoffAgent);
        assert.equal(resumed.runs.find(r=>r.id===oldAttempt.id)!.state,"failed");
        assert.equal(resumed.workUnits.find(u=>u.id===resumeId)!.retryAgentId,undefined);
        await assert.rejects(()=>ipc("terminal:handoff-options",interrupted.id,oldAttempt.id));
        terminalSnapshots.delete(oldAttempt.id);
      }
      assert.equal(resumed.resumeCount, 1); assert.equal(resumed.roundNumber ?? 1, 1);
      assert.ok(finished.every(id => resumed.runs.filter(r => r.workUnitId === id).length === 1));
      assert.ok(calls.slice(beforeResume).some(c => c.prompt.includes("# Required structured goal review")));
      assert.match(calls[beforeResume].prompt, /Resume this interrupted step|Required structured goal review/);
      assert.match(calls[beforeResume].prompt, /run BOTH even after the target has elapsed/);
      await ipc("task:complete", interrupted.id);
    }
    // Primary saves the execution plan, continues its native conversation for
    // substantive work, then builds and independently reviews.
    const primary = await createAuto("Primary mode", 3, "primary");
    const primaryStart = calls.length;
    await ipc("task:run", primary.id);
    await waitFor(async () => (await getTask(primary.id)).awaitingReason === "result");
    const primaryDone = await getTask(primary.id);
    assert.equal(primaryDone.autonomyState, "satisfied");
    assert.equal(calls.length - primaryStart, 5);
    assert.deepEqual(primaryDone.runs.map(r => r.role), ["worker", "worker", "reporter", "reviewer", "reviewer"]);
    assert.equal(new Set(primaryDone.runs.map(r => r.id)).size, 5);
    assert.equal(new Set([primaryDone.runs[1].agentId, primaryDone.runs[3].agentId, primaryDone.runs[4].agentId]).size, 3);
    assert.equal(calls[primaryStart + 4].continueSession, undefined);
    assert.doesNotMatch(calls[primaryStart + 4].prompt, /Fixture review/);
    assert.match(calls[primaryStart].prompt, /INITIAL OR REQUIRED REPLAN/);
    assert.ok(calls[primaryStart + 1].continueSession);
    assert.equal(primaryDone.executionPlans?.length, 1);
    assert.match(calls[primaryStart + 3].prompt, /Independent review context/);
    assert.doesNotMatch(calls[primaryStart + 3].prompt, /Worker progress checked|Primary leads concrete work/);
    assert.equal(calls[primaryStart + 3].mode, "read");
    assert.notEqual(primaryDone.runs[1].providerKey, primaryDone.runs[3].providerKey);
    // A review failure returns to a primary worker, not a planner chain.
    const repairPrimary = await createAuto("Primary repair", 3, "primary");
    reviewResults = ["fail", "pass"];
    const repairStart = calls.length;
    await ipc("task:run", repairPrimary.id);
    await waitFor(async () => (await getTask(repairPrimary.id)).awaitingReason === "result");
    assert.equal((await getTask(repairPrimary.id)).autonomyState, "satisfied");
    assert.equal(calls.length - repairStart, 8);
    assert.ok(calls[repairStart + 4].continueSession, "repair inherits the prior primary conversation");
    assert.equal(calls[repairStart + 7].continueSession, undefined, "final review is always a fresh conversation");
    assert.equal((await getTask(repairPrimary.id)).workUnits[0].primary, true);
    for (const result of ["ask-user", "invalid", "needs-work", "sandbox-denied"]) {
      const current = await createAuto(`Primary ${result}`, 3, "primary");
      checkResults = [result, ...(result === "needs-work" ? ["ready"] : result === "invalid" ? ["invalid","invalid"] : [])];
      const begin: number = calls.length;
      await ipc("task:run", current.id);
      await waitFor(async () => result === "invalid" ? (await getTask(current.id)).state === "paused" : result === "sandbox-denied" ? (await getTask(current.id)).state === "blocked" : (await getTask(current.id)).awaitingReason === "result");
      assert.equal(calls.length - begin, result === "needs-work" ? 6 : result === "invalid" ? 4 : 2);
      if (result === "ask-user") await assert.rejects(() => ipc("task:resume", current.id));
      if (result === "sandbox-denied") {
        const stopped = await getTask(current.id);
        assert.equal(stopped.executionBlocker?.kind, "permission");
        assert.match(stopped.executionBlocker!.recovery, /復旧/);
        assert.equal(stopped.workUnits.find(u => u.role === "reporter")?.state, "pending");
        assert.equal(stopped.runs.filter(r => r.role === "reporter").length, 0);
        await ipc("task:resume", current.id);
        await waitFor(async () => (await getTask(current.id)).autonomyState === "satisfied");
        await waitFor(async () => !(await ipc("app:snapshot")).queue.activeTaskIds.includes(current.id));
      }
      if (result === "invalid") {
        await ipc("task:resume", current.id);
        await waitFor(async () => (await getTask(current.id)).awaitingReason === "result");
        assert.equal((await getTask(current.id)).autonomyState, "satisfied");
        assert.equal((await getTask(current.id)).resumeCount, 1);
      }
    }
    const receiptRecovery = await createAuto("Review receipt survives missing marker", 3, "primary");
    await ipc("task:configure", receiptRecovery.id, { ...input, kind: "continue", pauseAfterPlan: false, assignments: { reviewer: { agentId: "claude", allowFallback: false } } });
    useResultChannel = true; missingReviewMarkerOnce = true;
    await ipc("task:run", receiptRecovery.id);
    await waitFor(async () => (await getTask(receiptRecovery.id)).state === "paused");
    const receiptStopped = await getTask(receiptRecovery.id);
    const failedReceipt = receiptStopped.runs.find(r => r.role === "reviewer" && r.state === "failed")!;
    assert.match(failedReceipt.structuredResult!, /<goal-evaluation>/);
    assert.ok(!receiptStopped.evaluations?.length, "receipt alone must not advance or pass the review");
    const recoveryStart = calls.length;
    await ipc("task:resume", receiptRecovery.id);
    await waitFor(async () => (await getTask(receiptRecovery.id)).awaitingReason === "result");
    assert.match(calls[recoveryStart].prompt, /Recover this same review's saved submission/);
    assert.equal((await getTask(receiptRecovery.id)).autonomyState, "satisfied");
    useResultChannel = false;

    const gatedPrimary = await createAuto("Primary plan approval", 3, "primary");
    await ipc("task:configure", gatedPrimary.id, { ...input, kind: "continue", pauseAfterPlan: true });
    const gateStart = calls.length;
    await ipc("task:run", gatedPrimary.id);
    await waitFor(async () => (await getTask(gatedPrimary.id)).awaitingReason === "plan");
    assert.equal(calls.length - gateStart, 1);
    assert.equal((await getTask(gatedPrimary.id)).executionPlans?.length, 1);
    assert.match(calls.at(-1)!.prompt, /INITIAL OR REQUIRED REPLAN/);
    await ipc("task:run", gatedPrimary.id);
    await waitFor(async () => (await getTask(gatedPrimary.id)).awaitingReason === "result");
    assert.equal((await getTask(gatedPrimary.id)).autonomyState, "satisfied");
    assert.equal(calls.length - gateStart, 5);

    for (const reply of ["invalid", "bad-estimate", "ask-user"] as const) {
      const t = await createAuto(`Plan response ${reply}`, 3, "primary");
      planReplyNext = reply; const start: number = calls.length;
      await ipc("task:run", t.id);
      await waitFor(async () => ["paused", "awaiting-input"].includes((await getTask(t.id)).state));
      const stopped = await getTask(t.id);
      if (reply !== "ask-user") {
        assert.equal(stopped.autonomyState, "satisfied");
        assert.equal(stopped.executionPlans?.length, 1);
        assert.equal(stopped.workUnits[0].planFormatRetries, 1);
        assert.match(calls[start + 1].prompt, /Repair the rejected plan only/);
        assert.match(calls[start + 2].prompt, /You own the substantive research/);
      } else {
        assert.equal(calls.length - start, 1); assert.equal(stopped.executionPlans, undefined);
        assert.ok(!stopped.runs.some(r => r.role === "reporter"));
        await assert.rejects(() => ipc("task:resume", t.id));
      }
    }
    const invalidForever = await createAuto("Bounded plan repair", 3, "primary");
    persistentInvalidPlan = true;
    const invalidStart = calls.length;
    await ipc("task:run", invalidForever.id);
    await waitFor(async () => (await getTask(invalidForever.id)).state === "paused");
    persistentInvalidPlan = false;
    const invalidStopped = await getTask(invalidForever.id);
    assert.equal(calls.length - invalidStart, 3);
    assert.equal(invalidStopped.workUnits[0].planFormatRetries, 2);
    assert.equal(invalidStopped.executionPlans, undefined);
    assert.ok(!invalidStopped.runs.some(r => r.role === "reporter"));
    await ipc("task:resume", invalidForever.id);
    await waitFor(async () => (await getTask(invalidForever.id)).awaitingReason === "result");
    assert.equal((await getTask(invalidForever.id)).autonomyState, "satisfied");
    const adaptive = await createAuto("Revise after findings", 3, "primary");
    reviseNext = true;
    await ipc("task:run", adaptive.id);
    await waitFor(async () => (await getTask(adaptive.id)).awaitingReason === "result");
    const adapted = await getTask(adaptive.id);
    assert.equal(adapted.executionPlans?.length, 2);
    assert.equal(adapted.workUnits.filter(u => u.subtask).length, 1);
    assert.equal(adapted.runs.filter(r => !adapted.workUnits.some(u => u.id === r.workUnitId && u.orchestrator)).length, 7);
    assert.match(adapted.executionPlans![1].reason, /contradicted/);
    assert.ok(adapted.runs.filter(r => r.primary).slice(1).every(r => r.continuedFrom));
    const plansOnDisk = JSON.parse(await readFile(join(directory, "tasks.json"), "utf8")).tasks.find((t: TaskRecord) => t.id === adaptive.id).executionPlans;
    assert.deepEqual(plansOnDisk, adapted.executionPlans);

    // No eligible service is an admission failure, not a reason to discard the
    // approved decomposition or spend another planner call. Manual retries also
    // preserve the same units until service availability recovers.
    const unavailable = await createAuto("Unavailable services keep the plan", 3, "primary");
    planNext = true; denySpecialistAdmission = true;
    const unavailableStart = calls.length;
    await ipc("task:run", unavailable.id);
    await waitFor(async () => (await getTask(unavailable.id)).state === "blocked" && !lastQueue?.activeTaskIds.includes(unavailable.id));
    const unavailableTask = await getTask(unavailable.id);
    const originalPackageIds = unavailableTask.workUnits.filter(u => u.subtask).map(u => u.id);
    assert.equal(originalPackageIds.length, 2);
    assert.equal(unavailableTask.executionPlans?.length, 1);
    assert.equal(unavailableTask.retiredWorkUnits?.length ?? 0, 0);
    assert.equal(calls.length - unavailableStart, 1, "only the initial planner ran");
    assert.ok(unavailableTask.workUnits.some(u => u.subtask && u.launchBlocked));
    assert.match(unavailableTask.error!, /計画と成果物は保持/);
    await ipc("task:resume", unavailable.id);
    await waitFor(async () => (await getTask(unavailable.id)).state === "blocked" && !lastQueue?.activeTaskIds.includes(unavailable.id));
    assert.equal(calls.length - unavailableStart, 1);
    denySpecialistAdmission = false;
    await ipc("task:resume", unavailable.id);
    await waitFor(async () => (await getTask(unavailable.id)).awaitingReason === "result");
    const availableAgain = await getTask(unavailable.id);
    assert.equal(availableAgain.autonomyState, "satisfied", availableAgain.error);
    assert.equal(availableAgain.executionPlans?.length, 1);
    assert.deepEqual(availableAgain.workUnits.filter(u => u.subtask).map(u => u.id), originalPackageIds);

    // A retirement failure must not trigger the ordinary failure replanner.
    const fenced=await createAuto("Unconfirmed old CLI",3,"primary");
    planNext=true;retirementFailure=true;
    await ipc("task:run",fenced.id);
    await waitFor(async()=>(await getTask(fenced.id)).state==="blocked" && !lastQueue?.activeTaskIds.includes(fenced.id));
    const blocked=await getTask(fenced.id), oldRun=blocked.runs.find(r=>r.terminationUnconfirmed)!;
    assert.ok(oldRun);assert.equal(blocked.executionPlans?.length,1);
    assert.ok(blocked.workUnits.find(u=>u.id===oldRun.workUnitId)?.launchBlocked);
    const callsBeforeRetry=calls.length;
    await ipc("task:resume",fenced.id);
    await waitFor(async()=>(await getTask(fenced.id)).state==="blocked" && !lastQueue?.activeTaskIds.includes(fenced.id));
    assert.equal(calls.length,callsBeforeRetry,"manual resume must not bypass an old live process");
    terminalSnapshots.set(oldRun.id,{alive:false,inputAllowed:false});
    await ipc("task:resume",fenced.id);
    await waitFor(async()=>(await getTask(fenced.id)).awaitingReason==="result");
    assert.equal((await getTask(fenced.id)).runs.find(r=>r.id===oldRun.id)?.terminationUnconfirmed,false);
    terminalSnapshots.delete(oldRun.id);

    // Real workflow state + concurrent mock PTYs: no lost run/unit updates,
    // bounded readers, one writer, retained siblings on failure and all-agent pause.
    for (const scenario of ["parallel", "serial", "failure", "pause", "milestones"]) {
      const parallel = await createAuto(`Delegation ${scenario}`, 3, "primary");
      if (scenario === "serial") await ipc("task:execution", parallel.id, { ...parallel.execution, maxParallel: 1 });
      planNext = true; specialistPeak = 0; specialistFailure = scenario === "failure"; holdSubtasks = scenario === "pause";
      primaryMilestonesNext = scenario === "milestones";
      expectedSpecialistPeak=scenario==="serial" ? 1 : 2;
      const startCalls: number = calls.length;
      await ipc("task:run", parallel.id);
      if (scenario === "pause") {
        await waitFor(() => heldSubtasks.size === 2);
        const queued = await ipc("task:execution", parallel.id, { ...parallel.execution, maxParallel: 1 });
        assert.equal(queued.execution.maxParallel,2);assert.equal(queued.pendingExecution.policy.maxParallel,1);
        holdSubtasks = false;
        await ipc("task:cancel", parallel.id);
        await waitFor(async () => (await getTask(parallel.id)).state === "paused");
        assert.equal(heldSubtasks.size, 0);
        assert.equal((await getTask(parallel.id)).runs.filter(r => r.state === "running").length, 0);
        assert.equal((await getTask(parallel.id)).pendingExecution?.policy.maxParallel,1,"pause retains the reserved settings");
        await ipc("task:resume", parallel.id);
      } else if (scenario === "failure") {
        await waitFor(async () => (await getTask(parallel.id)).awaitingReason === "result");
        const partial = await getTask(parallel.id);
        const done = partial.workUnits.find(u => u.subtask && u.state === "completed")!;
        assert.ok(done); assert.equal(partial.executionPlans?.length, 2);
        assert.equal(partial.retiredWorkUnits?.length, 1);
        assert.equal((await getTask(parallel.id)).runs.filter(r => r.workUnitId === done.id).length, 1);
      }
      await waitFor(async () => (await getTask(parallel.id)).awaitingReason === "result");
      const finished = await getTask(parallel.id);
      assert.equal(finished.autonomyState, "satisfied");
      if(scenario==="pause") { assert.equal(finished.pendingExecution,undefined);assert.equal(finished.execution!.maxParallel,1); }
      assert.equal(specialistPeak, scenario === "serial" ? 1 : 2,scenario);
      assert.equal(finished.workUnits.filter(u => u.subtask).length, scenario === "failure" ? 1 : scenario === "milestones" ? 3 : 2);
      assert.ok(finished.workUnits.every(u => u.state === "completed"));
      assert.equal(finished.runs.filter(r => !finished.workUnits.some(u => u.id === r.workUnitId && u.orchestrator)).length, scenario === "pause" ? 9 : ["failure", "milestones"].includes(scenario) ? 8 : 7);
      assert.equal(new Set(finished.runs.map(r => r.id)).size, finished.runs.length);
      assert.equal(finished.runs.filter(r => r.primary && r.continuedFrom).length, ["failure", "milestones"].includes(scenario) ? 2 : 1);
      if (scenario === "milestones") {
        assert.equal(primaryMilestonesSeen, 1);
        assert.ok(finished.executionPlans?.[0].coordination);
        assert.match(calls.slice(startCalls).find(c => c.prompt.includes("INITIAL OR REQUIRED REPLAN"))!.prompt, /Planning resource snapshot/);
      }
      assert.ok(calls.slice(startCalls).filter(c => c.prompt.includes("You are a read-only specialist")).every(c => c.mode === "read" && !c.continueSession));
      for (const r of finished.runs) assert.ok((await readFile(r.logPath!, "utf8")).length > 0);
    }
    expectedSpecialistPeak=undefined;
    // Save during live PTYs: no cancellation, no graph loss, then changed
    // admission and routing at the next boundary. Decreasing drains siblings.
    const live=await createAuto("Live execution settings",3,"primary");
    await ipc("task:execution",live.id,{...live.execution,maxParallel:1});
    livePlanNext=true;holdPlanNext=true;holdSubtasks=true;specialistPeak=0;
    await ipc("task:run",live.id);await waitFor(()=>!!releasePlan);
    const planningLive=await getTask(live.id);
    await ipc("task:execution",live.id,{...planningLive.execution,maxSubtasks:1});
    releasePlan!();await waitFor(()=>heldSubtasks.size===1);
    const beforeLive=await getTask(live.id), runningLive=beforeLive.runs.find(r=>r.state==="running")!;
    assert.equal(beforeLive.execution!.maxSubtasks,1);assert.equal(beforeLive.executionPlans![0].tasks.length,4,"in-flight plan is validated under its original 4-package contract");
    const liveSaved=await ipc("task:execution",live.id,{...beforeLive.execution,maxParallel:3,scheduling:"throughput",contextTokens:undefined},beforeLive.executionRevision);
    assert.equal(liveSaved.execution.maxParallel,1);assert.equal(liveSaved.pendingExecution.policy.maxParallel,3);
    assert.equal(liveSaved.runs.find((r:any)=>r.id===runningLive.id).state,"running");
    assert.deepEqual(liveSaved.workUnits,beforeLive.workUnits);
    await assert.rejects(()=>ipc("task:execution",live.id,{...beforeLive.execution,maxParallel:2},beforeLive.executionRevision),/更新/);
    await assert.rejects(()=>ipc("task:execution",live.id,{...beforeLive.execution,reviewMode:"cross-service"}),/レビュー/);
    const firstRelease=heldSubtasks.values().next().value!;firstRelease(false);
    await waitFor(()=>heldSubtasks.size===3);
    const afterLive=await getTask(live.id);assert.equal(afterLive.execution!.maxParallel,3);assert.equal(afterLive.pendingExecution,undefined);
    assert.equal(afterLive.runs.find(r=>r.id===runningLive.id)!.state,"completed");
    assert.ok(new Set(afterLive.runs.filter(r=>r.state==="running").map(r=>r.agentId)).size>1,"throughput routing uses several services when independent slots exist");
    await ipc("task:execution",live.id,{...afterLive.execution,maxParallel:1,decompose:false,maxSubtasks:1});
    const releases=[...heldSubtasks.values()];releases[0](false);await waitFor(()=>heldSubtasks.size===2);
    assert.equal((await getTask(live.id)).execution!.maxParallel,3,"remaining siblings retain original settings");
    holdSubtasks=false;releases.slice(1).forEach(release=>release(false));
    await waitFor(async()=>(await getTask(live.id)).awaitingReason==="result");
    const liveDone=await getTask(live.id);assert.equal(liveDone.autonomyState,"satisfied",liveDone.error);
    assert.equal(liveDone.execution!.maxParallel,1);assert.equal(liveDone.execution!.decompose,false);assert.equal(liveDone.pendingExecution,undefined);
    assert.equal(liveDone.workUnits.filter(u=>u.subtask).length,4,"saved plan not discarded by lowering future decomposition limits");
    assert.ok(liveDone.runs.every(r=>r.state==="completed"));assert.equal(specialistPeak,3);
    // Hard contracts are enforced before PTY creation. Legacy failed delegates
    // can be restored through IPC without repeating successful source checks.
    for (const scenario of ["legacy","family","skill"] as const) {
      const draft=await ipc("task:create",{title:`Assignment recovery ${scenario}`,prompt:"Verify independent references",cwd:directory,goalMode:"manual",workflowMode:"primary",strategy:"balanced",allowedAgentIds:scenario==="family"?["codex","claude"]:["codex","claude","antigravity"],modelOverrides:{codex:"gpt-6-astra",claude:"claude-sonnet-4-5",antigravity:"gemini-3.8-flash-high"}});
      await ipc("goals:save",draft.id,{...draft.goal,questions:[]},draft.goal.revision,true,{enabled:true,maxCycles:3});
      await ipc("task:configure",draft.id,{assignments:{worker:{agentId:"codex",allowFallback:false}},pauseAfterPlan:false});
      const configured=await getTask(draft.id);
      await ipc("task:execution",draft.id,{...configured.execution,scheduling:"throughput",maxParallel:1});
      requirementPlanNext=scenario;failIndependentOnce=scenario==="legacy";
      await ipc("task:run",draft.id);
      await waitFor(async()=>{const t=await getTask(draft.id);return scenario==="legacy"?t.awaitingReason==="result":t.state==="blocked";});
      await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskIds.includes(draft.id));
      const stopped=await getTask(draft.id), a=stopped.workUnits.find(u=>u.subtask?.key==="a")!;
      assert.ok(a,JSON.stringify({scenario,error:stopped.error,plans:stopped.executionPlans,units:stopped.workUnits}));
      assert.equal(a.state,"completed");assert.equal(stopped.executionPlans!.length,1);
      const options=await ipc("task:assignment-options",draft.id);assert.equal(options.length,1);
      const b=options[0],peer=b.peers.find((p:any)=>p.key==="a");assert.equal(peer.model,"gpt-6-astra");assert.ok(peer.writingRevision);
      if(scenario!=="legacy") {
        assert.ok(stopped.workUnits.find(u=>u.id===b.id)!.launchBlocked);
        assert.ok(!stopped.runs.some(r=>r.workUnitId===b.id),"no CLI or run created for unsatisfied launch conditions");
      }
      if(scenario==="skill")continue; // Missing skills may not be silently removed.
      const requirements={modelFamilies:["gemini"],independentFrom:["a"],skills:[{id:"writing-rules",revision:peer.writingRevision},{id:"document-checks"},{id:"related-research"}]};
      await assert.rejects(()=>ipc("task:repair-assignment",draft.id,b.id,requirements,"stale"),/更新/);
      const repaired=await ipc("task:repair-assignment",draft.id,b.id,requirements,stopped.updatedAt);
      assert.equal(repaired.state,"paused");assert.deepEqual(repaired.workUnits.find((u:any)=>u.id===a.id),a);
      assert.deepEqual(repaired.goal,stopped.goal);assert.deepEqual(repaired.execution,stopped.execution);
      if(scenario==="family")await ipc("task:allowed-agents",draft.id,["codex","claude","antigravity"]);
      const start:number=calls.length;
      await ipc("task:resume",draft.id);
      await waitFor(async()=>(await getTask(draft.id)).awaitingReason==="result");
      const done=await getTask(draft.id);assert.equal(done.autonomyState,"satisfied",done.error);
      assert.equal(done.runs.filter(r=>r.workUnitId===a.id).length,1);
      const bRun=done.runs.find(r=>r.workUnitId===repaired.resumeFromUnitId&&r.state==="completed")!;
      assert.equal(bRun.agentId,"antigravity");assert.equal(bRun.finishingSkill!.revision,peer.writingRevision);
      const bCall:(typeof calls)[number]=calls.slice(start).find(c=>c.prompt.includes("# Your role: Independent B fixture\n"))!;
      assert.match(bCall.skillContents!["writing-rules"],new RegExp(peer.writingRevision));
      assert.equal(bCall.mode,"read");assert.equal(bCall.continueSession,undefined);
      assert.ok(done.workUnits.filter(u=>u.role==="reviewer").every(u=>u.state==="completed"));
    }
    // A real main-process coordinator consumes an idle slot, persists a new
    // dependency, and starts it before the unrelated slow specialist finishes.
    // Test two completion-driven decisions without a duration target. With a
    // target, later turns are deliberately reserved for the time checkpoints.
    const dynamic = await createAuto("Dynamic allocation", 3, "primary", ["codex", "claude", "antigravity"], null);
    planNext = true; holdSubtasks = true; coordinatorAddNext = true; useResultChannel = true;
    await ipc("task:run", dynamic.id);
    await waitFor(() => heldSubtasks.size === 2);
    const fastId = [...heldSubtasks.keys()][0];
    heldSubtasks.get(fastId)!(false);
    await waitFor(async () => (await getTask(dynamic.id)).orchestratorDecisions?.some(d => d.status === "added") === true && heldSubtasks.size === 2);
    const reallocating = await getTask(dynamic.id);
    const extra = reallocating.workUnits.find(u => u.allocatedBy)!;
    assert.equal(extra.state, "running");
    assert.equal(reallocating.workUnits.filter(u => u.subtask && u.state === "running").length, 2);
    assert.ok(reallocating.workUnits.find(u => u.primary && !u.planPhase)!.dependsOn.includes(extra.id));
    assert.ok(reallocating.runs.find(r => r.workUnitId === extra.allocatedBy)?.structuredResult?.includes("<work-plan>"));
    coordinatorAdjustNext = true;
    const originalIntegration = reallocating.workUnits.find(u => u.primary && !u.planPhase)!;
    holdSubtasks = false; heldSubtasks.forEach(resolve => resolve(false));
    await waitFor(async () => (await getTask(dynamic.id)).awaitingReason === "result");
    useResultChannel = false;
    const dynamicDone = await getTask(dynamic.id);
    assert.equal(dynamicDone.autonomyState, "satisfied");
    assert.equal(dynamicDone.runs.filter(r => r.role === "reviewer").length, 2);
    assert.ok(dynamicDone.runs.find(r => r.role === "reporter")?.finishingCheck);
    const adjusted = dynamicDone.workUnits.find(u => u.id === originalIntegration.id)!;
    assert.equal(adjusted.instructions, originalIntegration.instructions);
    assert.deepEqual(adjusted.dependsOn, originalIntegration.dependsOn);
    assert.equal(adjusted.coordinationNotes?.length, 1,JSON.stringify(dynamicDone.orchestratorDecisions));
    assert.ok(dynamicDone.orchestratorDecisions?.some(d => d.status === "adjusted"));
    assert.ok(calls.some(c => c.prompt.includes("# Saved-plan refinements for this assignment") && c.prompt.includes("evidence/boundary.json")));
    assert.deepEqual(JSON.parse(await readFile(join(directory, "tasks.json"), "utf8")).tasks.find((t: TaskRecord) => t.id === dynamic.id).orchestratorDecisions, dynamicDone.orchestratorDecisions);
    const constrained = await createAuto("Saved token target is telemetry", 3, "primary");
    await ipc("task:execution", constrained.id, { ...constrained.execution, tokenBudget: 1000 });
    const beforeBudget = calls.length;
    await ipc("task:run", constrained.id);
    await waitFor(async () => (await getTask(constrained.id)).awaitingReason === "result");
    assert.equal((await getTask(constrained.id)).autonomyState, "satisfied");
    assert.ok(calls.length > beforeBudget,"estimated total tokens never prevent useful execution");
    assert.equal((await getTask(constrained.id)).execution!.tokenBudget,1000,"legacy telemetry target is preserved");

    // Presets pass through real IPC, file capture, goal approval and every role.
    for(const failure of ["work","document","substantive"] as const){
      const t=await createAuto(`Quality repair ${failure}`,3,"primary");
      qualityFailureNext=failure;
      await ipc("task:run",t.id);
      await waitFor(async()=>(await getTask(t.id)).awaitingReason==="result");
      const done=await getTask(t.id);
      assert.equal(done.autonomyState,"satisfied",done.error);
      assert.equal(done.runs.filter(r=>r.role==="reporter").length,failure==="work"?1:2);
      if(failure==="document")assert.equal(done.workUnits.find(u=>u.role==="reporter")!.qualityRetries,1);
      if(failure==="substantive") {
        assert.equal(done.reportRepairs?.length,1,"scientific prerequisites route to a bounded owner plan, not another PDF-only pass");
        assert.ok(done.workUnits.some(u=>u.title==="主担当 · レポートの不足確認を再計画" && u.state==="completed"));
      }
      const view=await ipc("quality:snapshot",t.id);
      assert.equal(view.domains.reduce((n:number,d:any)=>n+d.snapshot.blockers.length,0),0);
    }
    const presetCatalog = await ipc("presets:list");
    assert.deepEqual(presetCatalog.presets.map((p: any) => p.manifest.id), ["research-project", "idea", "research", "coding", "hpc-refactoring", "paper", "poster", "paper-explainer"]);
    assert.equal(presetCatalog.defaultPresetId, "research-project");
    const codingPreset = presetCatalog.presets.find((p: any) => p.manifest.id === "coding");
    assert.equal(handlers.has("presets:copy"), false);
    const customPreset = await ipc("presets:save-rules", "coding", codingPreset.revision, codingPreset.rules + "\nWorkflow fixture coding");
    const modeInput = { title: "Preset workflow", prompt: "Verify an implementation", cwd: directory, workflowMode: "primary", goalMode: "manual", strategy: "balanced", allowedAgentIds: ["codex", "claude", "antigravity"], modelOverrides: {}, presetId: customPreset.manifest.id, presetRevision: customPreset.revision };
    await assert.rejects(() => ipc("task:create", { ...modeInput, presetRevision: "stale" }), /変更/);
    await assert.rejects(() => ipc("task:create", { ...modeInput, presetId: "missing" }), /読み込めません/);
    const modeTask = await ipc("task:create", modeInput);
    assert.equal(modeTask.workPreset.revision, customPreset.revision);
    assert.equal(modeTask.goal.status, "draft"); assert.ok(modeTask.goal.criteria.some((c: any) => c.id === "behavior"));
    await ipc("presets:save-rules", customPreset.manifest.id, customPreset.revision, customPreset.rules + "\nFUTURE_ONLY_RULE");
    assert.doesNotMatch((await getTask(modeTask.id)).workPreset!.rules, /FUTURE_ONLY_RULE/);
    await ipc("goals:save", modeTask.id, { ...modeTask.goal, questions: [] }, modeTask.goal.revision, true, { enabled: true, maxCycles: 3 });
    const presetStart: number = calls.length;
    await ipc("task:run", modeTask.id);
    await waitFor(async () => (await getTask(modeTask.id)).awaitingReason === "result");
    const modeFinished = await getTask(modeTask.id);
    assert.equal(modeFinished.autonomyState, "satisfied");
    assert.equal(calls.length - presetStart, 5);
    for (const c of calls.slice(presetStart)) { assert.match(c.prompt, /Task work preset/); assert.doesNotMatch(c.prompt, /FUTURE_ONLY_RULE/); }
    assert.match(calls[presetStart].prompt, /## 主担当の計画/);
    assert.match(calls[presetStart + 1].prompt, /## 作業/);
    assert.match(calls[presetStart + 2].prompt, /## レポート/);
    assert.match(calls[presetStart + 3].prompt, /## 検証/);
    assert.doesNotMatch(calls[presetStart + 3].prompt, /## 主担当の計画|## 作業|## レポート/);
    assert.equal((await getTask(primary.id)).workPreset, undefined, "existing tasks are not assigned a preset");
    // Native selection -> immutable import -> AI proposal -> user choice ->
    // actual workflow IPC. No external model or user paper is used.
    const lessonRoot = join(directory,"lesson-fixture"); await mkdir(lessonRoot);
    const lessonPdf = join(lessonRoot,"input.pdf"); await writeFile(lessonPdf,"%PDF-1.7\nfixture paper");
    lessonDialogFiles = [lessonPdf];
    const picked = await ipc("lesson:choose-pdfs"); assert.equal(picked.length,1);
    const lessonInput = {...modeInput,cwd:directory,presetId:"paper-explainer",presetRevision:undefined,goalMode:"ai",title:"Lesson fixture",lesson:{attachmentIds:picked.map((p:any)=>p.id),references:["https://example.org/code"],audience:"GPU初学者",interests:"具体例",language:"ja"}};
    await assert.rejects(()=>ipc("task:create",{...lessonInput,lesson:{...lessonInput.lesson,attachmentIds:["unknown"]}}),/選び直し/);
    const lessonTask = await ipc("task:create",lessonInput);
    assert.equal(lessonTask.lessonSources.length,1); assert.equal(lessonTask.lessonSkills.length,3);
    const lessonStart = calls.length;
    await ipc("task:run",lessonTask.id);
    await waitFor(async()=>(await getTask(lessonTask.id)).awaitingReason==="goal");
    const proposedLesson = await getTask(lessonTask.id);
    assert.equal(proposedLesson.goal!.lesson!.topics[0].depth,"foundation");
    assert.ok(proposedLesson.runs.every(r=>r.goalPreparation));
    proposedLesson.goal!.lesson!.topics[0].depth="deep";
    await ipc("goals:save",lessonTask.id,proposedLesson.goal,proposedLesson.goal!.revision,true,{enabled:true,maxCycles:3});
    await ipc("task:run",lessonTask.id);
    await waitFor(async()=>{const t=await getTask(lessonTask.id);if (["paused","blocked","failed"].includes(t.state)) throw new Error(`Lesson flow: ${t.error}`);return t.awaitingReason==="result";});
    const doneLesson = await getTask(lessonTask.id);
    assert.equal(doneLesson.autonomyState,"satisfied",doneLesson.error);
    assert.equal(doneLesson.goal!.lesson!.topics[0].depth,"deep");
    assert.equal(doneLesson.report!.documents,undefined);
    assert.match(await readFile(doneLesson.report!.texPath!,"utf8"),/beamer/);
    const lessonPrompts = calls.slice(lessonStart);
    assert.ok(lessonPrompts.some(c=>c.prompt.includes('"depth":"deep"')));
    assert.equal(doneLesson.runs.filter(r=>r.role==="reviewer").length,2);
    // Real worktrees + main scheduler + run-scoped MCP integration. Fake CLIs
    // write actual independent files; no external AI or user repository is used.
    const implementationRoot=join(directory,"implementation-fixture");await mkdir(implementationRoot);
    for(const f of ["part-a.txt","part-b.txt","evidence.txt"])await writeFile(join(implementationRoot,f),"fixture baseline\n");
    const git=promisify(execFile);
    await git("git",["-C",implementationRoot,"init"]);await git("git",["-C",implementationRoot,"add","."]);
    await git("git",["-C",implementationRoot,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","-m","fixture"]);
    const implementationPreset=(await ipc("presets:list")).presets.find((p:any)=>p.manifest.id==="coding");
    const implementationTask=await ipc("task:create",{...modeInput,cwd:implementationRoot,title:"Isolated implementation fixture",allowedAgentIds:["codex","claude"],presetRevision:implementationPreset.revision});
    implementationTaskId=implementationTask.id;
    await ipc("goals:save",implementationTask.id,{...implementationTask.goal,questions:[]},implementationTask.goal.revision,true,{enabled:true,maxCycles:1});
    await ipc("task:execution",implementationTask.id,{...implementationTask.execution,maxParallel:2});
    await ipc("task:run",implementationTask.id);
    await waitFor(async()=>(await getTask(implementationTask.id)).awaitingReason==="result");
    const implementationDone=await getTask(implementationTask.id);
    assert.equal(implementationDone.autonomyState,"satisfied",implementationDone.error);
    assert.equal(implementationPeak,2);
    assert.equal(await readFile(join(implementationRoot,"part-a.txt"),"utf8"),"part-a.txt implemented\n");
    assert.equal(await readFile(join(implementationRoot,"part-b.txt"),"utf8"),"part-b.txt implemented\n");
    assert.equal(implementationDone.runs.filter(r=>r.role==="reviewer").length,2);
    const workspaceLedgerPath=join(implementationRoot,`.agent-harness/${implementationTask.id}/implementation/ledger.json`);
    const workspaceLedger=JSON.parse(await readFile(workspaceLedgerPath,"utf8"));
    assert.ok(workspaceLedger.workspaces.every((w:any)=>w.state==="merged"));
    workspaceLedger.workspaces[0].state="active";await writeFile(workspaceLedgerPath,JSON.stringify(workspaceLedger));
    await assert.rejects(ipc("task:complete",implementationTask.id),/分離実装/);
    workspaceLedger.workspaces[0].state="merged";await writeFile(workspaceLedgerPath,JSON.stringify(workspaceLedger));
    implementationTaskId=undefined;
    // A CLI's claimed ready handoff cannot skip the HPC ledger/verification gate.
    const hpcPreset = presetCatalog.presets.find((p: any) => p.manifest.id === "hpc-refactoring");
    const hpcTask = await ipc("task:create", { ...modeInput, title:"HPC gate fixture", presetId:hpcPreset.manifest.id, presetRevision:hpcPreset.revision });
    await ipc("goals:save",hpcTask.id,{...hpcTask.goal,questions:[]},hpcTask.goal.revision,true,{enabled:true,maxCycles:1});
    const hpcStart = calls.length;
    await ipc("task:run",hpcTask.id);
    await waitFor(async ()=>(await getTask(hpcTask.id)).awaitingReason === "result");
    await waitFor(async ()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    const hpcPartial=await getTask(hpcTask.id);
    assert.match(hpcPartial.workClosure!.issues.join("\n"),/HPC検証ゲート/);
    assert.ok(hpcPartial.workClosure!.finishedAt);
    assert.notEqual(hpcPartial.autonomyState,"satisfied");
    assert.ok(calls.slice(hpcStart).some(c=>c.prompt.includes("# TeX build instructions")&&c.prompt.includes("NOT successful acceptance")),"unverified code may be documented only as a partial result");
    assert.match(calls[hpcStart].prompt,/hpc_manage/);
    await ipc("hpc:action",hpcTask.id,{action:"budget",budget:{jobs:2}});
    assert.equal((await ipc("hpc:action",hpcTask.id,{action:"snapshot"})).budget.jobs,2);
    await writeFile(join(directory,"hpc-kernel.cpp"),"int x=1;\n");
    await writeFile(join(directory,"hpc-reference.json"),'{"values":{"x":[1]}}');
    await writeFile(join(directory,"hpc-actual.json"),'{"values":{"x":[1]}}');
    await writeFile(join(directory,"hpc-environment.json"),'{"compiler":"fixture"}');
    await writeFile(join(directory,"hpc-verifier.sh"),"# fixture\n");
    await ipc("hpc:action",hpcTask.id,{action:"define",unit:{id:"kernel",title:"kernel",files:["hpc-kernel.cpp"],dependsOn:[],policyNote:"approved exact match",cases:["reference","replay","unit","integration"].map(stage=>({id:stage,stage,absolute:0,relative:0}))}});
    for (const caseId of ["reference","replay","unit","integration"]) await require("./hpc").hpcOperation({root:directory,taskId:hpcTask.id,actor:"fixture",write:true,manage:true},{action:"verify",unitId:"kernel",caseId,reference:"hpc-reference.json",actual:"hpc-actual.json",environment:"hpc-environment.json",verifier:"hpc-verifier.sh"});
    await ipc("task:followup",hpcTask.id,{kind:"continue",instruction:"Continue verified migration",assignments:{},pauseAfterPlan:false},true);
    await waitFor(async ()=>(await getTask(hpcTask.id)).autonomyState === "satisfied");
    await waitFor(async ()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    await writeFile(join(directory,"hpc-kernel.cpp"),"int x=2;\n");
    await assert.rejects(ipc("task:complete",hpcTask.id),/HPC検証が未完了/);

    // Legacy research executes its captured dedicated modes in order.
    // Synthetic evidence isolates workflow sequencing from real scientific execution.
    // The production gate remains enabled: a bare ready handoff is insufficient.
    const seedResearch = async (taskId: string) => {
      const writer: ResearchContext = {root:directory,taskId,actor:"fixture-writer",cli:"codex",write:true,manage:true};
      const critic: ResearchContext = {...writer,actor:"fixture-critic",cli:"claude",write:false,manage:false,critic:true};
      const evaluator=`${taskId}-evaluator.txt`;
      await writeFile(join(directory,evaluator),"Synthetic test protocol, not actual research evidence");
      await researchOperation(writer,{action:"protocol",protocol:{question:"Fixture comparison",files:[evaluator],maxExperiments:5,metrics:[{id:"score",direction:"max",tolerance:0,subset:true}]}});
      await researchOperation(writer,{action:"candidate",candidate:{id:"candidate",hypothesis:"Fixture improvement",limitation:"Fixture baseline",novelty:"Not a scientific claim",falsifier:"No improvement",sources:["fixture://protocol"]}});
      for (const stage of ["baseline-subset","baseline-full","subset","full","ablation"]) {
        const prefix=`${taskId}-${stage}`;
        await writeFile(join(directory,`${prefix}.json`),JSON.stringify({score:stage.startsWith("baseline")?1:2}));
        await writeFile(join(directory,`${prefix}.py`),"# synthetic source snapshot");
        await writeFile(join(directory,`${prefix}.log`),"synthetic execution receipt");
        await researchOperation(writer,{action:"record",experiment:{id:stage,stage,candidate:"candidate",purpose:"Workflow fixture",result:`${prefix}.json`,evidence:[`${prefix}.py`,`${prefix}.log`],comparedTo:stage==="ablation"?"full":undefined}});
        if (!stage.startsWith("baseline")) await researchOperation(critic,{action:"judge",experimentId:stage,verdict:"accept",reason:"Synthetic test verification"});
      }
      await researchOperation(writer,{action:"select",experimentId:"full"});
      assert.deepEqual((await ipc("research:snapshot",taskId)).blockers,[]);
    };
    const researchPreset = (await ipc("presets:list")).presets.find((p:any)=>p.manifest.id === "research-project");
    // Today's default is one continuous primary loop, with all four method
    // rule sets available and only one manuscript, not four forced handoffs.
    const adaptiveResearch=await ipc("task:create",{...modeInput,title:"Integrated primary research",presetId:"research-project",presetRevision:researchPreset.revision});
    await seedResearch(adaptiveResearch.id);
    await ipc("goals:save",adaptiveResearch.id,{...adaptiveResearch.goal,questions:[]},adaptiveResearch.goal.revision,true,{enabled:true,maxCycles:3});
    const adaptiveStart=calls.length;
    await ipc("task:run",adaptiveResearch.id);
    await waitFor(async()=>(await getTask(adaptiveResearch.id)).awaitingReason==="result");
    await waitFor(async()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    const adaptiveDone=await getTask(adaptiveResearch.id);
    assert.equal(adaptiveDone.autonomyState,"satisfied",adaptiveDone.error);
    assert.equal(adaptiveDone.workUnits.some(u=>u.researchStage),false);
    assert.equal(adaptiveDone.report?.documents,undefined);
    assert.equal(adaptiveDone.runs.filter(r=>r.role==="reporter").length,1);
    assert.equal(adaptiveDone.runs.filter(r=>r.role==="reviewer").length,2);
    const owners=adaptiveDone.runs.filter(r=>r.primary);
    assert.ok(owners.length>=2);assert.equal(new Set(owners.map(r=>r.agentId)).size,1);
    assert.match(calls[adaptiveStart].prompt,/integrated research/i);
    assert.match(calls[adaptiveStart+1].prompt,/FUTURE_ONLY_RULE/,"integration uses the saved constituent writing rules when executing, not just planning");
    const researchTask = await ipc("task:create",{...modeInput,title:"Sequential research",presetId:"research-project",presetRevision:researchPreset.revision});
    await preserveLegacyDocumentWorkflow(researchTask);
    assert.equal(researchTask.researchCycle,1);
    assert.match((await ipc("research:snapshot",researchTask.id)).blockers[0],/評価条件が未登録/);
    await assert.rejects(ipc("task:complete",researchTask.id),/評価条件が未登録/);
    await ipc("goals:save",researchTask.id,{...researchTask.goal,questions:[]},researchTask.goal.revision,true,{enabled:true,maxCycles:3});
    await assert.rejects(ipc("task:complete",researchTask.id),(error:Error)=>{
      assert.match(error.message,/評価条件が未登録/);assert.match(error.message,/品質検証/);assert.match(error.message,/report/);return true;
    });
    await seedResearch(researchTask.id);
    const researchStart: number = calls.length;
    await ipc("task:run",researchTask.id);
    await waitFor(async ()=>(await getTask(researchTask.id)).awaitingReason === "result");
    await waitFor(async ()=>!(await ipc("app:snapshot")).queue.activeTaskId);
    const researchDone = await getTask(researchTask.id);
    assert.equal(researchDone.autonomyState,"satisfied");
    const stageRuns = researchDone.runs.filter(r=>researchDone.workUnits.find(u=>u.id === r.workUnitId)?.researchStage);
    assert.deepEqual(stageRuns.map(r=>researchDone.workUnits.find(u=>u.id === r.workUnitId)!.researchStage),["idea","idea","research","research","coding","coding","paper","paper"]);
    assert.equal(calls.length-researchStart,11);
    assert.equal(researchDone.runs.filter(r=>r.role === "reporter").length,1);
    assert.equal(researchDone.runs.filter(r=>r.role === "reviewer").length,2);
    assert.match(calls[researchStart+5].prompt,/FUTURE_ONLY_RULE/,"new research tasks use the current edited coding mode");
    for(const index of [0,2,4,6]) assert.equal(calls[researchStart+index].continueSession,undefined,"new mode starts with fresh context");
    for(const index of [0,1,2,3,6,7]) assert.doesNotMatch(calls[researchStart+index].prompt,/FUTURE_ONLY_RULE/,"other stages do not inherit coding-only rules");
    for(const missing of [false,true]) {
      const integrated=await ipc("task:create",{...modeInput,title:"Actual planned research critics",allowedAgentIds:["codex","claude"],presetId:"research-project",presetRevision:researchPreset.revision,
        execution:{reuseContext:true,decompose:true,maxSubtasks:8,maxParallel:2,contextTokens:32000}});
      await preserveLegacyDocumentWorkflow(integrated);
      researchWorkflowId=integrated.id;omitResearchCritique=missing;useResultChannel=true;
      await ipc("goals:save",integrated.id,{...integrated.goal,questions:[]},integrated.goal.revision,true,{enabled:true,maxCycles:1});
      await ipc("task:run",integrated.id);
      // This fixture includes all research stages, up to three bounded
      // controller turns and real MCP child processes. Allow fixture startup
      // headroom; this is not a production deadline or relaxed completion gate.
      try { await waitFor(async ()=>(await getTask(integrated.id)).awaitingReason==="result", 45000); }
      catch(error) {
        const stalled=await getTask(integrated.id);
        throw new Error(`${String(error)}: ${JSON.stringify({state:stalled.state,error:stalled.error,
          units:stalled.workUnits.map(u=>({title:u.title,state:u.state,error:u.error}))})}`);
      }
      await waitFor(async ()=>!(await ipc("app:snapshot")).queue.activeTaskId);
      const done=await getTask(integrated.id), critics=done.workUnits.filter(u=>u.subtask?.researchCritic);
      assert.equal(critics.length,3);assert.ok(critics.every(u=>u.state==="completed"));
      if(missing){
        assert.notEqual(done.autonomyState,"satisfied");
        // The bounded-repair policy may now finish an explicitly partial report
        // rather than stop forever. Missing scientific judgement never becomes
        // acceptance: all original blockers must survive either disposition.
        const unresolved = done.workClosure?.finishedAt ? done.workClosure.issues.join("\n") : done.error!;
        assert.match(unresolved,/quality_manage/);assert.match(unresolved,/research_manage/);
        assert.match(unresolved,/Original agent repair remains necessary/);
        if (!done.workClosure?.finishedAt) assert.equal(done.runs.filter(r=>r.role==="reporter").length,0,"completed terminal without judge must not bypass research gate");
        else assert.ok(done.workClosure.issues.length && done.runs.some(r=>r.role==="reviewer"),"partial closure discloses blockers and still requires independent inspection");
      }else{assert.equal(done.autonomyState,"satisfied");assert.deepEqual((await ipc("research:snapshot",done.id)).blockers,[]);}
    }
    researchWorkflowId=undefined;omitResearchCritique=false;useResultChannel=false;
    const scopeTask = await ipc("task:create", { ...modeInput, title: "Blocked scope fixture", presetRevision: (await ipc("presets:list")).presets.find((p:any)=>p.manifest.id === "coding").revision });
    const scopeLimit = "着想検討に専念する。", scopeExclusion = "演算カーネルの実装、性能ベンチマークや数値実験の実行。";
    const scopeApproved = await ipc("goals:save", scopeTask.id, { ...scopeTask.goal, questions: [], constraints: ["FP64命令は禁止", scopeLimit], outOfScope: [scopeExclusion, "別マシンの使用"] }, scopeTask.goal.revision, true, { enabled:true,maxCycles:3 });
    await ipc("task:run", scopeTask.id);
    await waitFor(async () => (await getTask(scopeTask.id)).awaitingReason === "result");
    const scopeStart: number = calls.length;
    const scopeInput = { instruction:"Apple M5で実装・精度検証・性能実験を進める。FP64禁止は維持する。",kind:"continue",assignments:{},pauseAfterPlan:false,
      scopeChange:{goalRevision:scopeApproved.goal.revision,removeConstraints:[scopeLimit],removeOutOfScope:[scopeExclusion],implementation:true,confirmed:true} };
    await ipc("task:followup",scopeTask.id,scopeInput,false);
    assert.deepEqual((await getTask(scopeTask.id)).goal!.outOfScope,[scopeExclusion,"別マシンの使用"]);
    assert.equal(calls.length,scopeStart);
    await ipc("task:followup",scopeTask.id,scopeInput,true);
    await waitFor(async () => (await getTask(scopeTask.id)).awaitingReason === "result");
    const scopeDone = await getTask(scopeTask.id);
    assert.equal(scopeDone.goal!.revision,scopeApproved.goal.revision+1);
    assert.equal(scopeDone.goal!.status,"approved"); assert.equal(scopeDone.autonomyState,"satisfied");
    assert.deepEqual(scopeDone.goal!.constraints,["FP64命令は禁止"]); assert.deepEqual(scopeDone.goal!.outOfScope,["別マシンの使用"]);
    assert.equal(calls.length-scopeStart,5); assert.equal(calls[scopeStart+1].mode,"write");
    const receivedGoal=JSON.parse(calls[scopeStart+1].prompt.match(/# User-approved goal[^\n]*\n([^\n]+)/)![1]);
    assert.deepEqual(receivedGoal.constraints,["FP64命令は禁止"]); assert.deepEqual(receivedGoal.outOfScope,["別マシンの使用"]);
    await assert.rejects(ipc("task:followup",scopeTask.id,scopeInput,true),/更新/);
    for (const id of ["idea", "research", "research-project"]) {
      const preset = (await ipc("presets:list")).presets.find((p: any) => p.manifest.id === id);
      const task = await ipc("task:create", { ...modeInput, title: id, presetId: id, presetRevision: preset.revision });
      if (id === "research-project") await preserveLegacyDocumentWorkflow(task);
      if (id === "research-project") await seedResearch(task.id);
      else assert.equal(task.researchCycle,undefined,"dedicated modes are not forced into an empirical research cycle");
      assert.equal(task.report, undefined);
      await ipc("goals:save", task.id, { ...task.goal, questions: [] }, task.goal.revision, true, { enabled: true, maxCycles: 3 });
      if (id === "research-project") {
        const configured = await ipc("task:configure", task.id, { assignments: { planner: { agentId: "claude", allowFallback: true } }, pauseAfterPlan: false });
        assert.equal(configured.workUnits.filter((u: any) => u.researchStage).length, 4);
        assert.equal(configured.workUnits.filter((u: any) => u.role === "planner").length, 1);
        assert.equal(configured.workUnits.filter((u: any) => u.reviewPass).length, 2, "assignment changes retain both review gates");
        const reset = await ipc("task:configure", task.id, { assignments: {}, pauseAfterPlan: false });
        assert.equal(reset.workUnits.filter((u: any) => u.role === "planner").length, 0);
        assert.equal(reset.workUnits[0].researchStage,"idea");
        assert.equal(reset.workUnits.filter((u: any) => u.reviewPass).length, 2);
      }
      const before: number = calls.length;
      if (id === "research-project") failRoleOnce = "planner";
      await ipc("task:run", task.id);
      if (id === "research-project") {
        await waitFor(async () => (await getTask(task.id)).state === "paused");
        const stopped = await getTask(task.id);
        assert.equal(stopped.workUnits[0].researchStage,"idea");
        assert.equal(stopped.workUnits[1].state, "pending", "no work starts after interrupted ideation");
        assert.equal(calls.length - before, 1);
        const configured = await ipc("task:configure", task.id, { assignments: {}, pauseAfterPlan: false });
        assert.equal(configured.workUnits[0].id, stopped.workUnits[0].id, "ideation is not mistaken for optional planner during recovery");
        await ipc("task:resume", task.id);
      }
      try { await waitFor(async () => (await getTask(task.id)).awaitingReason === "result"); }
      catch (error) {
        const stalled = await getTask(task.id);
        throw new Error(`${String(error)}: ${JSON.stringify({preset:id,state:stalled.state,error:stalled.error,
          units:stalled.workUnits.map(u=>({title:u.title,state:u.state,error:u.error}))})}`);
      }
      const done = await getTask(task.id);
      assert.equal(done.autonomyState, "satisfied");
      assert.equal(calls.length - before, id === "research-project" ? 12 : 5);
      if (id === "idea") {
        assert.equal(calls[before+1].mode,"write");
        assert.match(calls[before+1].prompt,/実機上で予備評価/);
        assert.match(calls[before+1].prompt,/一つの方法に固執せず/);
        assert.doesNotMatch(calls[before+1].prompt,/検証は設計までとし実行しない/);
      }
      assert.equal(done.report?.documents?.paper?.state, id === "research-project" ? "ready" : undefined);
      assert.equal(done.workUnits.filter(u => u.researchStage && !u.planPhase && !u.subtask).length, id === "research-project" ? 4 : 0);
      if (id === "research-project") {
        assert.match(calls[before + 2].prompt, /# Current research stage: idea/);
        assert.match(calls[before + 3].prompt, /# Current research stage: research/);
        assert.doesNotMatch(calls[calls.length - 1].prompt, /# Current research stage:/);
        assert.doesNotMatch(calls[calls.length - 2].prompt, /# Current research stage:/);
      }
      assert.ok(done.workUnits.every(u => u.state === "completed"));
      if (id === "idea") {
        const beforeTransition: number = calls.length;
        const followup = { instruction: "Implement the chosen idea and compare measured results with the baseline", kind: "continue", assignments: {}, pauseAfterPlan: false, implementation: true };
        await ipc("task:followup", task.id, followup, false);
        assert.equal((await getTask(task.id)).workPreset?.manifest.focus, "idea");
        assert.equal((await getTask(task.id)).pendingFollowup?.implementation, true);
        assert.equal(calls.length, beforeTransition, "saving cannot elevate scope or run commands");
        const draft = await ipc("task:followup", task.id, followup, true);
        assert.equal(calls.length, beforeTransition, "transition waits for goal approval without invoking a CLI");
        assert.equal(draft.goal.status, "draft"); assert.equal(draft.goalRevisionPending, true);
        assert.equal(draft.workPreset.manifest.focus, "implementation");
        assert.equal(draft.history.at(-1).workPreset.manifest.focus, "idea");
        assert.deepEqual(draft.runs, done.runs); assert.equal(draft.report.texPath, done.report!.texPath);
        await assert.rejects(ipc("task:run", task.id), /ゴールを承認/);
        const approved = await ipc("goals:save", task.id, { ...draft.goal, questions: [] }, draft.goal.revision, true, draft.autonomy);
        assert.equal(approved.goalRevisionPending, undefined);
        await ipc("task:run", task.id);
        await waitFor(async () => (await getTask(task.id)).awaitingReason === "result");
        const finished = await getTask(task.id);
        assert.equal(finished.autonomyState, "satisfied");
        assert.equal(calls.length - beforeTransition, 5);
        assert.equal(calls[beforeTransition + 1].mode, "write");
        assert.match(calls[beforeTransition + 1].prompt, /User-approved scope transition/);
        assert.doesNotMatch(calls[beforeTransition + 1].prompt, /着想検討に専念する/);
        assert.equal(finished.workUnits.filter(u => u.reviewPass).length, 2);
      }
    }
    for (const id of ["paper", "poster"]) {
      const preset = presetCatalog.presets.find((p: any) => p.manifest.id === id);
      const documentTask = await ipc("task:create", { ...modeInput, title: id, presetId: id, presetRevision: preset.revision });
      if (id === "paper") await preserveLegacyDocumentWorkflow(documentTask);
      assert.equal(documentTask.report, undefined, "goal preparation must not initialize files");
      await ipc("goals:save", documentTask.id, { ...documentTask.goal, questions: [] }, documentTask.goal.revision, true, { enabled: true, maxCycles: 3 });
      const before: number = calls.length;
      if (id === "poster") omitDocumentOnce = true;
      await ipc("task:run", documentTask.id);
      if (id === "poster") {
        await waitFor(async () => (await getTask(documentTask.id)).state === "paused");
        const paused = await getTask(documentTask.id);
        assert.equal(paused.report!.state, "ready", "standard PDF is independently available");
        assert.equal(paused.report!.documents!.poster!.state, "failed");
        assert.match(paused.error!, /ポスター/);
        assert.equal(calls.length - before, 3, "review cannot start without the poster PDF");
        await ipc("task:resume", documentTask.id);
      }
      await waitFor(async () => (await getTask(documentTask.id)).awaitingReason === "result");
      const finished = await getTask(documentTask.id);
      assert.equal(calls.length - before, id === "poster" ? 6 : 5);
      assert.equal(finished.report!.documents![id as "paper" | "poster"]!.state, "ready");
      assert.match(calls[before + 1].prompt, /Registered document targets/);
      assert.match(calls[before + 2].prompt, /EVERY additional target/);
      assert.match(calls[calls.length - 1].prompt, /reviewers inspect every PDF/);
      assert.match(Buffer.from(await ipc("reports:read-pdf", documentTask.id, 1, id)).toString(), /Additional revision/);
      const unchanged = JSON.stringify(await getTask(documentTask.id));
      const restartCallCount: number = calls.length;
      const carry = await ipc("task:restart", documentTask.id, "carry");
      const fresh = await ipc("task:restart", documentTask.id, "fresh");
      assert.equal(calls.length, restartCallCount, "restart creation must not call a CLI");
      assert.deepEqual(carry.goal, finished.goal); assert.deepEqual(fresh.goal, finished.goal);
      assert.equal(carry.cwd, finished.cwd); assert.notEqual(fresh.cwd, finished.cwd);
      assert.deepEqual(await readdir(fresh.cwd), []);
      assert.equal(fresh.report, undefined); assert.equal(fresh.restart.handoff, undefined);
      assert.equal(carry.report.state, "draft"); assert.notEqual(carry.report.texPath, finished.report!.texPath);
      assert.equal(await readFile(carry.report.documents[id].texPath, "utf8"), "Verified extra subject content");
      assert.equal(JSON.stringify(await getTask(documentTask.id)), unchanged);
      await assert.rejects(() => ipc("task:restart", fresh.id, "fresh"), /停止/);
      await assert.rejects(() => ipc("task:restart", documentTask.id, "invalid"), /方法/);
      if (id === "paper") {
        const beforeRestartRun: number = calls.length;
        await ipc("task:run", carry.id);
        await waitFor(async () => (await getTask(carry.id)).awaitingReason === "result");
        assert.equal(calls.length - beforeRestartRun, 5);
        assert.equal(calls[beforeRestartRun].continueSession, undefined, "new task starts a new CLI conversation");
        assert.match(calls[beforeRestartRun].prompt, /Restart handoff/);
        assert.deepEqual((await getTask(carry.id)).goal, finished.goal);
        assert.equal(JSON.stringify(await getTask(documentTask.id)), unchanged);
      }
    }

    // Repeated reporter prerequisites go back to owner planning, not a false pass.
    const prerequisiteTask = await createQueued("Reporter prerequisite recovery");
    missingReportPrerequisites = 1;
    separatedReportPrerequisites=true;
    await ipc("task:run", prerequisiteTask.id);
    await waitFor(async () => (await getTask(prerequisiteTask.id)).state === "paused");
    const prerequisitePaused = await getTask(prerequisiteTask.id);
    assert.equal(prerequisitePaused.state, "paused");
    assert.equal(prerequisitePaused.reportRecovery?.kind, "prerequisite");
    assert.equal(prerequisitePaused.reportRecovery?.pdfAvailable, true);
    assert.equal(prerequisitePaused.reportRecovery?.canReplan, true);
    assert.equal(prerequisitePaused.runs.find(r=>r.role==="reporter")!.finishingCheck?.status,"completed");
    assert.equal(prerequisitePaused.runs.filter(r=>r.role==="reviewer").length,0,"editorial completion never bypasses unresolved source prerequisites");
    const priorWorker = prerequisitePaused.workUnits.find(u => u.role === "worker")!;
    await ipc("task:resume", prerequisiteTask.id);
    await waitFor(async () => (await getTask(prerequisiteTask.id)).awaitingReason === "result");
    const prerequisiteDone = await getTask(prerequisiteTask.id);
    assert.equal(prerequisiteDone.reportRepairs?.length, 1);
    assert.equal(prerequisiteDone.workUnits.find(u => u.id === priorWorker.id)?.completedAt, priorWorker.completedAt);
    assert.equal(prerequisiteDone.runs.filter(r => r.workUnitId === priorWorker.id).length, 1);
    assert.equal(prerequisiteDone.runs.filter(r => r.role === "reporter").length, 2);
    assert.equal(prerequisiteDone.runs.filter(r => r.role === "reviewer").length, 2);
    assert.equal(prerequisiteDone.reportRecovery, undefined);

    const prerequisiteDraft = await ipc("task:create", { title: "Bounded automatic report recovery", prompt: "Verify sources", cwd: directory, goalMode: "manual", workflowMode: "primary", strategy: "balanced", allowedAgentIds: ["codex", "claude", "antigravity"], modelOverrides: {} });
    const automaticReport = await ipc("goals:save", prerequisiteDraft.id, { ...prerequisiteDraft.goal, questions: [] }, 1, true, { enabled: true, maxCycles: 3 });
    missingReportPrerequisites = 3;
    await ipc("task:run", automaticReport.id);
    await waitFor(async () => (await getTask(automaticReport.id)).state === "paused");
    const exhaustedReport = await getTask(automaticReport.id);
    assert.equal(exhaustedReport.reportRepairs?.length, 2);
    assert.equal(exhaustedReport.runs.filter(r => r.role === "reporter").length, 3);
    assert.equal(exhaustedReport.runs.filter(r => r.role === "reviewer").length, 0);
    assert.equal(exhaustedReport.reportRecovery?.canReplan, false);
    await assert.rejects(() => ipc("task:resume", automaticReport.id), /2回/);
    missingReportPrerequisites = 0;

    // Missing editorial receipt cannot advance to reviews, even with a valid PDF.
    const editorialTask = await createQueued("Mandatory finishing gate");
    const editorialStart: number = calls.length;
    omitEditorialOnce = true; useResultChannel = true;
    await ipc("task:run", editorialTask.id);
    await waitFor(async () => (await getTask(editorialTask.id)).state === "paused");
    const editorialPaused = await getTask(editorialTask.id);
    assert.match(editorialPaused.error!, /レポート執筆ルール/);
    assert.equal(editorialPaused.runs.filter(r => r.role === "reviewer").length, 0);
    const captured = editorialPaused.runs.find(r => r.role === "reporter")!.finishingSkill!;
    assert.ok(captured.revision);
    const editing = await ipc("finishing:get");
    const revised = await ipc("finishing:save", editing.current.revision, editing.current.rules + "\n実装テスト用の追加ルール");
    await assert.rejects(() => ipc("finishing:save", editing.current.revision, editing.current.rules), /変更/);
    assert.equal((await getTask(editorialTask.id)).runs.find(r => r.role === "reporter")!.finishingSkill!.revision, captured.revision);
    await ipc("task:resume", editorialTask.id);
    await waitFor(async () => (await getTask(editorialTask.id)).awaitingReason === "result");
    const editorialDone = await getTask(editorialTask.id);
    const finalReporter = [...editorialDone.runs].reverse().find(r => r.role === "reporter")!;
    assert.equal(finalReporter.finishingCheck?.revision, finalReporter.finishingSkill?.revision);
    assert.notEqual(finalReporter.finishingSkill?.revision, captured.revision);
    assert.ok(finalReporter.finishingSkill?.rules.includes(revised.rules));
    assert.deepEqual([...finalReporter.finishingSkill!.rules.matchAll(/^## .+ \[(.+)\]$/gm)].map(m => m[1]), ["common", "style", "verification", "paper", "poster", "slides"]);
    assert.doesNotMatch(finalReporter.finishingSkill!.rules, /name: report-writing-(academic|expression)/, "imported rules are consolidated, not appended a second time");
    assert.ok(finalReporter.finishingCheck!.sources.includes(await realpath(editorialDone.report!.texPath!)));
    const retainedReceipts = editorialDone.workUnits.find(u=>u.id===finalReporter.workUnitId)!.output!;
    assert.match(retainedReceipts, /<editorial-check>/); assert.match(retainedReceipts, /<work-check>/);
    assert.doesNotMatch(finalReporter.displayOutput!, /<editorial-check>/, "native management receipt stays out of terminal final prose");
    assert.equal(editorialDone.runs.filter(r => r.role === "reviewer").length, 2);
    for (const call of calls.slice(-2)) {
      assert.equal(call.mode, "read");
      const rules = call.skillContents?.["writing-rules"] ?? call.prompt;
      if (call.skillContents) {
        assert.match(call.prompt, /get_skill|skills\/writing-rules\.md/);
        assert.doesNotMatch(call.prompt, /実装テスト用の追加ルール/);
      }
      assert.match(rules, /実装テスト用の追加ルール/);
      assert.match(rules, /文献情報の一次ソース二重チェック/);
      assert.match(rules, /相手の判定を根拠にせず/);
      assert.match(rules, /et al\./);
    }
    assert.ok(calls.length > editorialStart);
    useResultChannel = false;

    // Antigravity uses the native interactive, file-handoff workflow, independently of Gemini.
    require("./cli-detect").detectAgents = async () => ["codex", "claude", "opencode", "antigravity"].map(id => ({ id, label: id, command: id, executable: "/fake", installed: true }));
    await ipc("agents:refresh");
    assert.equal((await ipc("antigravity-login:status")).state, "unverified");
    const agyDraft = await ipc("task:create", { title: "Antigravity task", prompt: "Verify Antigravity integration", cwd: directory,
      goalMode: "manual", workflowMode: "primary", strategy: "balanced", allowedAgentIds: ["claude", "antigravity"], modelOverrides: {} });
    await ipc("goals:save", agyDraft.id, { ...agyDraft.goal, questions: [] }, 1, true, { enabled: false, maxCycles: 3 });
    await ipc("task:configure", agyDraft.id, { kind: "revise", instruction: "Run the verified task", pauseAfterPlan: false,
      assignments: { planner: { agentId: "antigravity" }, worker: { agentId: "antigravity" }, reporter: { agentId: "antigravity" } } });
    const agyStart = calls.length;
    await ipc("task:run", agyDraft.id);
    await waitFor(async () => (await getTask(agyDraft.id)).awaitingReason === "result");
    const agyDone = await getTask(agyDraft.id);
    assert.ok(agyDone.runs.some(r => r.agentId === "antigravity" && r.state === "completed"));
    assert.equal(agyDone.runs.filter(r => r.role === "reviewer").length, 2);
    assert.match(calls[agyStart].prompt, /Notification file:/);
    assert.ok(agyDone.runs.some(r => r.providerKey === "google-antigravity"));

    const agyPlan = await ipc("task:create", { title:"Antigravity file plan",prompt:"Verify file-based plan submission",cwd:directory,
      goalMode:"manual",workflowMode:"primary",strategy:"balanced",allowedAgentIds:["claude","antigravity"],modelOverrides:{} });
    await ipc("goals:save",agyPlan.id,{...agyPlan.goal,questions:[]},1,true,{enabled:false,maxCycles:3});
    await ipc("task:configure",agyPlan.id,{kind:"revise",instruction:"Submit the plan before working",pauseAfterPlan:false,
      assignments:{worker:{agentId:"antigravity"},reporter:{agentId:"antigravity"}}});
    await ipc("task:run",agyPlan.id);
    await waitFor(async()=>(await getTask(agyPlan.id)).awaitingReason==="result");
    const filePlanDone=await getTask(agyPlan.id);
    const planRun=filePlanDone.runs.find(r=>r.structuredResult?.includes("<execution-plan>"))!;
    assert.equal(planRun.agentId,"antigravity");assert.equal(planRun.state,"completed");
    assert.doesNotMatch(planRun.displayOutput!,/<execution-plan>/);
    assert.ok(filePlanDone.executionPlans?.length);
    assert.equal(filePlanDone.runs.filter(r=>r.role==="reviewer").length,2);

    // GLM configuration flows through real main IPC into native OpenCode work units.
    await assert.rejects(() => ipc("opencode:configure", "zai", "zai/glm-5.3"));
    const glm = await ipc("opencode:configure", "zai", "zai-coding-plan/glm-5.3");
    assert.equal(glm.settings.agentPolicies.find((p: any) => p.agentId === "opencode").providerKey, "zai-coding-plan");
    const glmDraft = await ipc("task:create", { title: "GLM task", prompt: "Verify OpenCode integration", cwd: directory,
      goalMode: "manual", workflowMode: "primary", strategy: "balanced", allowedAgentIds: ["claude", "opencode"], modelOverrides: {} });
    await ipc("goals:save", glmDraft.id, { ...glmDraft.goal, questions: [] }, 1, true, { enabled: false, maxCycles: 3 });
    await ipc("task:configure", glmDraft.id, { kind: "revise", instruction: "Run the verified task", pauseAfterPlan: false,
      assignments: { planner: { agentId: "opencode" }, worker: { agentId: "opencode" }, reporter: { agentId: "opencode" } } });
    const glmStart = calls.length; useResultChannel = true;
    await ipc("task:run", glmDraft.id);
    await waitFor(async () => (await getTask(glmDraft.id)).awaitingReason === "result");
    const glmDone = await getTask(glmDraft.id);
    assert.ok(glmDone.runs.some(r => r.agentId === "opencode" && r.state === "completed"));
    assert.ok(calls.length > glmStart);
    assert.equal(glmDone.runs.filter(r => r.role === "reviewer").length, 2);
    useResultChannel = false;

    // Switching to Ollama retains Z.AI history and drives the same native workflow.
    await assert.rejects(() => ipc("opencode:configure", "invalid", "ollama-cloud/gpt-oss:120b"));
    await assert.rejects(() => ipc("opencode:configure", "ollama", "zai-coding-plan/glm-5.3"));
    const ollamaSettings = await ipc("opencode:configure", "ollama", "ollama-cloud/gpt-oss:120b");
    const ollamaPolicy = ollamaSettings.settings.agentPolicies.find((p: any) => p.agentId === "opencode");
    assert.equal(ollamaPolicy.providerKey, "ollama-cloud");
    assert.equal(ollamaPolicy.openCodeModels.zai, "zai-coding-plan/glm-5.3");
    assert.ok((await getTask(glmDone.id)).runs.some(r => r.providerKey === "zai-coding-plan"), "old runs retain their original provider");
    const ollamaDraft = await ipc("task:create", { title: "Ollama Cloud task", prompt: "Verify Ollama integration", cwd: directory,
      goalMode: "manual", workflowMode: "primary", strategy: "balanced", allowedAgentIds: ["claude", "opencode"], modelOverrides: {} });
    await ipc("goals:save", ollamaDraft.id, { ...ollamaDraft.goal, questions: [] }, 1, true, { enabled: false, maxCycles: 3 });
    await ipc("task:configure", ollamaDraft.id, { kind: "revise", instruction: "Run with Ollama", pauseAfterPlan: false,
      assignments: { planner: { agentId: "opencode" }, worker: { agentId: "opencode" }, reporter: { agentId: "opencode" } } });
    useResultChannel = true;
    await ipc("task:run", ollamaDraft.id);
    await assert.rejects(() => ipc("opencode:configure", "zai", "zai-coding-plan/glm-5.3"), /停止/);
    await waitFor(async () => (await getTask(ollamaDraft.id)).awaitingReason === "result");
    const ollamaDone = await getTask(ollamaDraft.id);
    assert.ok(ollamaDone.runs.some(r => r.agentId === "opencode" && r.providerKey === "ollama-cloud" && r.state === "completed"));
    assert.equal(ollamaDone.runs.filter(r => r.role === "reviewer").length, 2);
    useResultChannel = false;

    // Existing Ollama login route shares Cloud accounting but uses native ollama/... models.
    const appSettings = await ipc("opencode:configure", "ollama-app", "ollama/deepseek-v4.1-flash:cloud");
    const appPolicy = appSettings.settings.agentPolicies.find((p: any) => p.agentId === "opencode");
    assert.equal(appPolicy.providerKey, "ollama-cloud");
    assert.equal(appPolicy.openCodeModels.ollama, "ollama-cloud/gpt-oss:120b");
    const appCli = await ipc("opencode-login:start", "ollama-app");
    assert.equal(typeof appCli,"string","existing Ollama authentication opens a user-operated CLI rather than requiring a second login");
    assert.equal((await ipc("opencode-login:snapshot",appCli)).alive,true);
    await ipc("opencode-login:close",appCli);
    const appDraft = await ipc("task:create", { title: "Ollama app task", prompt: "Verify installed Ollama route", cwd: directory,
      goalMode: "manual", workflowMode: "primary", strategy: "balanced", allowedAgentIds: ["claude", "opencode"], modelOverrides: {} });
    await ipc("goals:save", appDraft.id, { ...appDraft.goal, questions: [] }, 1, true, { enabled: false, maxCycles: 3 });
    await ipc("task:configure", appDraft.id, { kind: "revise", instruction: "Run with installed Ollama", pauseAfterPlan: false,
      assignments: { planner: { agentId: "opencode" }, worker: { agentId: "opencode" }, reporter: { agentId: "opencode" } } });
    useResultChannel = true;
    await ipc("task:run", appDraft.id);
    await waitFor(async () => (await getTask(appDraft.id)).awaitingReason === "result");
    const appDone = await getTask(appDraft.id);
    assert.ok(appDone.runs.some(r => r.agentId === "opencode" && r.providerKey === "ollama-cloud" && r.state === "completed"));
    assert.equal(appDone.runs.filter(r => r.role === "reviewer").length, 2);
    useResultChannel = false;

    // System strategy defaults affect new tasks, never silently mutate saved tasks.
    const originalDefaults = validateExecution((await ipc("app:snapshot")).executionDefaults);
    const savedTaskPolicy = structuredClone((await getTask(editorialDone.id)).execution);
    const systemPolicy = { ...originalDefaults, scheduling: "throughput", reviewMode: "cross-service", maxParallel: 4, contextTokens: undefined };
    await ipc("execution:settings-update", systemPolicy);
    assert.deepEqual((await ipc("app:snapshot")).executionDefaults, systemPolicy);
    assert.deepEqual((await getTask(editorialDone.id)).execution, savedTaskPolicy);
    const defaultTask = await ipc("task:create", { title: "System strategy", prompt: "Verify defaults", cwd: directory, goalMode: "manual", workflowMode: "primary", strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {} });
    assert.deepEqual(defaultTask.execution, systemPolicy);
    const explicitTask = await ipc("task:create", { title: "Explicit strategy", prompt: "Verify explicit values", cwd: directory, goalMode: "manual", workflowMode: "primary", strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {}, execution: originalDefaults });
    assert.deepEqual(explicitTask.execution, originalDefaults);
    const cleared = await ipc("task:execution", explicitTask.id, { ...explicitTask.execution, contextTokens: undefined });
    assert.equal(cleared.execution.contextTokens, undefined);
    assert.equal((await getTask(explicitTask.id)).execution?.contextTokens, undefined);
    await assert.rejects(ipc("execution:settings-update", { ...systemPolicy, maxParallel: 99 }));
    await ipc("execution:settings-update", originalDefaults);

    // A failing provider must not block the other provider or trigger repeated requests.
    let claudeRefreshes = 0;
    let codexRefreshes = 0;
    const { CapacityRequestError } = require("./claude-capacity");
    require("./claude-capacity").readClaudeCapacity = async () => {
      claudeRefreshes++;
      throw new CapacityRequestError("Usage API HTTP 429", 429, 600_000);
    };
    require("./capacity-probes").readCodexCapacity = async () => {
      codexRefreshes++;
      return { limited: false, usedPercent: 12 };
    };
    await Promise.all([ipc("capacity:refresh"), ipc("capacity:refresh")]);
    const refreshed = await ipc("capacity:refresh");
    assert.equal(claudeRefreshes, 1);
    assert.equal(codexRefreshes, 1);
    const failed = refreshed.find((item: any) => item.capacityError?.includes("HTTP 429"));
    assert.ok(failed);
    assert.ok(Date.parse(failed.capacityRetryAt) > Date.now() + 590_000);
    assert.ok(refreshed.some((item: any) => item.usedPercent === 12));

    // Native backend failure retries the same assignment, not a new plan or
    // an invented account quota. Two other services can finish independently.
    const nativeFailureTask=await createAuto("Native capacity handoff",3,"primary");
    nativeFailureRoleOnce="worker";
    await ipc("task:run",nativeFailureTask.id);
    await waitFor(async()=>(await getTask(nativeFailureTask.id)).awaitingReason==="result");
    const nativeDone=await getTask(nativeFailureTask.id);
    assert.equal(nativeDone.autonomyState,"satisfied",nativeDone.error);
    const failedRun=nativeDone.runs.find(r=>r.executionFailure?.kind==="capacity")!;assert.ok(failedRun);
    assert.equal(failedRun.state,"failed");
    const fallback=nativeDone.runs.find(r=>r.workUnitId===failedRun.workUnitId&&r.state==="completed")!;
    assert.ok(fallback);assert.notEqual(fallback.agentId,failedRun.agentId);
    assert.equal(nativeDone.runs.some(r=>r.state==="rate-limited"),false);
    assert.equal(await readFile(join(directory,"capacity-partial.txt"),"utf8"),"Preserve verified partial artifact");

    // Run quota admission last: its real persistent cooldown intentionally
    // prevents further admissions on that provider until reset.
    const quotaTask=await createAuto("Quota handoff",3,"primary");
    const quotaStart=calls.length;quotaRoleOnce="worker";
    await ipc("task:run",quotaTask.id);
    await waitFor(async()=>(await getTask(quotaTask.id)).awaitingReason==="result");
    const quotaDone=await getTask(quotaTask.id);
    assert.equal(quotaDone.autonomyState,"satisfied",quotaDone.error);
    const limited=quotaDone.runs.find(r=>r.state==="rate-limited")!;assert.ok(limited);
    const successor=quotaDone.runs.find(r=>r.workUnitId===limited.workUnitId&&r.state==="completed")!;
    assert.ok(successor);assert.notEqual(successor.agentId,limited.agentId);
    const planners=quotaDone.runs.filter(r=>r.role==="planner");
    assert.equal(new Set(planners.map(r=>r.workUnitId)).size,planners.length,"completed planning/checkpoint units are not repeated");
    assert.equal(await readFile(join(directory,"quota-partial.txt"),"utf8"),"Preserve verified partial artifact");
    assert.ok(calls.slice(quotaStart).some(c=>c.prompt.includes("Provider quota interrupted this attempt")&&c.prompt.includes("quota-partial.txt")));

    const exhaustedTask = await createAuto("All remaining services hit quota", 3, "primary");
    planNext = true; quotaEverySpecialist = true;
    await ipc("task:run", exhaustedTask.id);
    await waitFor(async () => (await getTask(exhaustedTask.id)).state === "blocked" && !lastQueue?.activeTaskIds.includes(exhaustedTask.id));
    quotaEverySpecialist = false;
    const exhausted = await getTask(exhaustedTask.id);
    assert.equal(exhausted.executionPlans?.length, 1, "quota exhaustion must not consume replans");
    assert.equal(exhausted.retiredWorkUnits?.length ?? 0, 0);
    assert.equal(exhausted.workUnits.filter(u => u.subtask).length, 2);
    assert.ok(exhausted.workUnits.some(u => u.subtask && u.launchBlocked));
    assert.ok(exhausted.runs.some(r => r.state === "rate-limited"));
    assert.ok(!exhausted.runs.some(r => r.state === "running"));
  } finally {
    JsonTaskStore.prototype.init=originalStoreInit;
    appEvents.get("before-quit")?.();
    if (handlers.has("app:snapshot")) await waitFor(async () => !(await ipc("app:snapshot")).queue.activeTaskId);
    await rm(directory, { recursive: true, force: true });
  }
});
