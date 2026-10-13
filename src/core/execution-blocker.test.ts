import test from "node:test";
import assert from "node:assert/strict";
import { executionFailure, reportedExecutionFailure, currentExecutionBlocker, executionBlockerPatch, localPermissionFailure, executionEnvironmentGuidance } from "./execution-blocker";
import { parseWorkCheck } from "./work-guidance";
import { resumePatch } from "./recovery";
import type { TaskRecord, WorkUnit } from "./types";

const failure = {kind:"hardware" as const,summary:"必須のMetalデバイスを取得できません。",recovery:"実行権限を確認して同じ工程から再開してください。",check:"MTLCreateSystemDefaultDevice() == nil"};
const check = {status:"environment-blocked",summary:failure.summary,remainingWork:"対象GPUでの実測",estimatedRemainingMinutes:0,evidence:[],blocker:failure};
const wrap = (v: unknown) => `<work-check>${JSON.stringify(v)}</work-check>`;
const writer = {id:"work",title:"実作業",instructions:"Verify required GPU",role:"worker",mode:"write",state:"pending",dependsOn:["plan"],attemptedAgentIds:[]} as WorkUnit;
function fixture(): TaskRecord { return {state:"running",goal:{revision:1,status:"approved"},runs:[],
  workUnits:[{...writer,id:"plan",mode:"read",state:"completed",dependsOn:[],planPhase:true},writer,
    {...writer,id:"report",role:"reporter",dependsOn:["work"]}]} as unknown as TaskRecord; }

test("required failures are explicit and bounded, not inferred from ordinary or optional defects", async () => {
  assert.deepEqual(executionFailure(failure),failure);
  assert.deepEqual(reportedExecutionFailure(wrap(check)),failure);
  assert.equal((await parseWorkCheck(wrap(check),fixture())).status,"environment-blocked");
  for (const v of [{...failure,kind:"unknown"},{...failure,recovery:""},{...failure,check:"x".repeat(1201)},{...failure,summary:4}]) {
    assert.equal(executionFailure(v),undefined);
    await assert.rejects(parseWorkCheck(wrap({...check,blocker:v}),fixture()));
  }
  for (const v of [{...check,status:"ready"},{...check,status:"needs-work",summary:"Optional GPU unavailable; CPU path satisfies goal"},
    {...check,status:"needs-work",summary:"Regression failed"}]) assert.equal(reportedExecutionFailure(wrap(v)),undefined);
  assert.equal(reportedExecutionFailure("Previous log: MTLCreateSystemDefaultDevice() == nil"),undefined);
  assert.equal(reportedExecutionFailure(wrap({...check,status:"needs-work",summary:"過去の bwrap: setting up uid map: Permission denied は解決済み。通常のテスト修正が残る。"})),undefined);
  assert.equal(reportedExecutionFailure(wrap(check)+wrap(check)),undefined);
});
test("legacy concrete sandbox denials stop instead of consuming repair cycles", async () => {
  const legacy = {...check,status:"needs-work",blocker:undefined,summary:"bwrap: setting up uid map: Permission denied"};
  assert.equal(reportedExecutionFailure(wrap(legacy))?.kind,"permission");
  assert.equal((await parseWorkCheck(wrap(legacy),fixture())).status,"environment-blocked");
});
test("long optional subject reports cannot hide a bounded environment blocker", async () => {
  const workReport = { activities: Array(12).fill("測定".repeat(700)) };
  const submitted = wrap({ ...check, workReport });
  assert.ok(submitted.length > 16000 && submitted.length < 48000);
  assert.deepEqual(reportedExecutionFailure(submitted), failure);
  assert.equal((await parseWorkCheck(submitted, fixture())).workReport?.activities.length, 12);
  // Invalid presentation is optional too; it must not erase a valid blocker.
  const malformedDisplay = wrap({ ...check, workReport: { results: "x".repeat(17000) } });
  assert.deepEqual(reportedExecutionFailure(malformedDisplay), failure);
  assert.equal((await parseWorkCheck(malformedDisplay, fixture())).workReport, undefined);
  for (const value of [{ ...check, summary: "x".repeat(16000) }, { ...check, workReport: "x".repeat(48000) }]) {
    assert.equal(reportedExecutionFailure(wrap(value)), undefined, "oversized authoritative data/envelopes stay rejected");
    await assert.rejects(parseWorkCheck(wrap(value), fixture()));
  }
  assert.equal(reportedExecutionFailure(submitted + submitted), undefined);
  const legacy = { ...check, status: "needs-work", blocker: undefined, summary: "bwrap: setting up uid map: Permission denied", workReport };
  assert.equal(reportedExecutionFailure(wrap(legacy))?.kind, "permission");
});
test("permission admission permits planning, read-only, remote and isolated packages", () => {
  const task = fixture();
  assert.ok(localPermissionFailure(task,writer,"codex",false,"sandbox"));
  assert.equal(localPermissionFailure(task,writer,"codex",false,"full-access"),undefined);
  for (const u of [{...writer,planPhase:true},{...writer,mode:"read" as const},{...writer,orchestrator:{} as any},
    {...writer,subtask:{kind:"isolated-work"} as any}]) assert.equal(localPermissionFailure(task,u,"codex",false,"sandbox"),undefined);
  assert.equal(localPermissionFailure(task,writer,"codex",true,"sandbox"),undefined);
  assert.equal(localPermissionFailure(task,writer,"claude",false,"sandbox"),undefined);
  const isolated={...writer,subtask:{kind:"isolated-work"} as any};
  assert.ok(localPermissionFailure({...task,allowedAgentIds:["codex"]},isolated,"codex",false,"sandbox"),"do not spend isolated implementation work on a known impossible integration");
  assert.ok(localPermissionFailure({...task,assignments:{worker:{agentId:"codex",allowFallback:false}}},isolated,"codex",false,"sandbox"));
  assert.match(executionEnvironmentGuidance(),/environment-blocked/);
  assert.match(executionEnvironmentGuidance(),/任意機能の失敗/);
});
test("first blocker owns resume; completed work survives and dependent work is invalidated", () => {
  const task = fixture();
  const blocked = {...task,...executionBlockerPatch(task,"work",failure,"run-a")};
  assert.equal(blocked.state,"blocked"); assert.equal(blocked.resumeFromUnitId,"work");
  const sibling = {...blocked,...executionBlockerPatch(blocked,"report",{...failure,summary:"別の不足"},"run-b")};
  assert.equal(sibling.executionBlocker?.runId,"run-a"); assert.equal(sibling.resumeFromUnitId,"work");
  for(const patch of [{roundNumber:2},{autonomyCycle:2},{goal:{...task.goal!,revision:2}},{workUnits:[]}])
    assert.equal(currentExecutionBlocker({...blocked,...patch}),undefined);
  const resumed = {...sibling,...resumePatch(sibling)};
  assert.equal(resumed.executionBlocker,undefined); assert.equal(resumed.state,"queued");
  assert.deepEqual(resumed.workUnits.map(u=>u.state),["completed","pending","pending"]);
  assert.equal(resumed.goal,task.goal);
});
