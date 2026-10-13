import test from "node:test";
import assert from "node:assert/strict";
import type { GoalEvaluation, TaskRecord } from "./types";
import { pairUnits, combineReviewPair } from "./review-pair";
import { reviewTimingPatch, requiredReviewPasses, effectiveReviewMode } from "./review-timing";
import { decideIteration, evaluationPrompt, repairUnits } from "./autonomy";
import { budgetStatus } from "./execution-policy";

const now = Date.parse("2026-09-30T01:10:00Z");
function fixture(targetMinutes = 20): TaskRecord {
  return {
    id: "time-review", title:"Time review", prompt:"Verify",cwd:"/tmp",strategy:"balanced",modelOverrides:{},output:"",state:"running",createdAt:"",updatedAt:"",roundNumber: 1, autonomyCycle: 1, reviewPolicy: "adversarial-pair",
    goal: {revision:1,status:"approved",objective:"Verify",deliverables:["report"],constraints:[],outOfScope:[],questions:[],updatedAt:"",criteria:[{id:"correct",required:true,description:"Correctness",verification:"tests"}]},
    autonomy:{enabled:true,maxCycles:3,targetMinutes}, allowedAgentIds:["codex","claude","opencode","antigravity"],
    execution:{reuseContext:true,decompose:true,maxParallel:2,maxSubtasks:4,reviewMode:"cross-service"},
    runs:[{id:"work-run",workUnitId:"work",role:"worker",agentId:"codex",providerKey:"openai",state:"completed",startedAt:"2026-09-30T01:05:00Z",completedAt:"2026-09-30T01:10:00Z",output:""}],
    workUnits:pairUnits([{id:"work",role:"worker",mode:"write",state:"completed",title:"Implementation",instructions:"",dependsOn:[],attemptedAgentIds:[]},
      {id:"report",role:"reporter",mode:"write",state:"completed",title:"Report",instructions:"",dependsOn:["work"],attemptedAgentIds:[]}])
  };
}
test("time pressure reduces cross review to pair, then single, never zero", () => {
  const pair = {...fixture(), ...reviewTimingPatch(fixture(), now)};
  assert.equal(pair.reviewAdjustments![0].mode,"pair");
  assert.equal(pair.workUnits.filter(u=>u.role==="reviewer").length,2);
  assert.equal(effectiveReviewMode(pair),"pair");
  const base = fixture(6), before = JSON.stringify(base), single = {...base,...reviewTimingPatch(base,now)};
  assert.equal(requiredReviewPasses(single),1);
  assert.equal(single.workUnits.filter(u=>u.role==="reviewer").length,1);
  assert.equal(single.reviewAdjustments![0].omittedUnits[0].state,"pending");
  assert.equal(budgetStatus(single).reserve,5000);
  assert.equal(JSON.stringify(base),before);
  assert.equal(requiredReviewPasses(JSON.parse(JSON.stringify(single))),1);
  assert.equal(reviewTimingPatch(single,now),undefined,"stable across restart/next admission");
});
test("parallel review estimates independent batches plus one consolidator before admission", () => {
  const t=fixture(20);t.execution!.reviewMode="parallel";
  assert.equal(reviewTimingPatch(t,now),undefined,"two five-minute batches plus five-minute consolidation fit remaining 15 minutes");
  t.execution!.maxParallel=1;
  assert.equal(reviewTimingPatch(t,now)!.reviewAdjustments![0].mode,"pair");
  t.autonomy!.targetMinutes=6;
  assert.equal(reviewTimingPatch(t,now)!.reviewAdjustments![0].mode,"single");
});
test("past trust/startup waits do not inflate future review duration or cut its schedule",()=>{
  const t=fixture(20);
  t.runs.unshift({id:"previous-review",workUnitId:"archived-review",role:"reviewer",agentId:"claude",providerKey:"anthropic",state:"completed",output:"",
    startedAt:"2026-09-30T00:00:00Z",completedAt:"2026-09-30T01:04:00Z",
    executionTiming:{source:"channel",workStartedAt:"2026-09-30T01:02:00Z"}});
  assert.equal(reviewTimingPatch(t,now),undefined,"two actual minutes, not 64 minutes including trust wait");
});
test("no duration, enough time, ongoing producers, and any started/failed review preserve policy", () => {
  const noTarget=fixture();delete noTarget.autonomy!.targetMinutes;
  assert.equal(reviewTimingPatch(noTarget,now),undefined);
  assert.equal(reviewTimingPatch(fixture(100),now),undefined);
  for (const change of ["producer","started","failed","receipt","cross"] as const) {
    const t=fixture(1), u=t.workUnits.find(u=>u.reviewPass===1)!;
    if(change==="producer")t.workUnits[0].state="running";
    if(change==="started")u.startedAt="2026-09-30T01:10:00Z";
    if(change==="failed")u.state="failed";
    if(change==="receipt")t.runs.push({...t.runs[0],workUnitId:u.id,role:"reviewer"});
    if(change==="cross")u.crossReview={wave:1,providerKey:"openai",sourceUnitIds:[]};
    assert.equal(reviewTimingPatch(t,now),undefined,change);
  }
});
test("single review verifies identity/freshness and still repairs failures; decision cannot leak into next cycle", () => {
  const base=fixture(1),t={...base,...reviewTimingPatch(base,now)},u=t.workUnits.find(u=>u.reviewPass===1)!;
  Object.assign(u,{state:"completed",startedAt:new Date(now).toISOString(),assignedAgentId:"claude"});
  t.runs.push({...t.runs[0],id:"review-run",workUnitId:u.id,role:"reviewer",agentId:"claude",startedAt:new Date(now).toISOString(),completedAt:new Date(now+60000).toISOString()});
  const e:GoalEvaluation={goalRevision:1,cycle:1,round:1,reviewedAt:new Date(now+60000).toISOString(),reviewUnitId:u.id,reviewPass:1,reviewerAgentId:"claude",criteria:[{criterionId:"correct",status:"pass",detail:"Checked",evidence:[{path:"test.json",detail:"result",hash:"abc"}]}],concerns:[],nextAction:"repair",repairInstructions:"",summary:"Verified"};
  assert.equal(decideIteration(t,combineReviewPair(t,[e])),"satisfied");
  const failed={...e,concerns:["Boundary failure"],repairInstructions:"Fix boundary"};
  assert.equal(decideIteration(t,combineReviewPair(t,[failed])),"working");
  const repaired={...t,workUnits:repairUnits(t,failed),autonomyCycle:2};
  assert.equal(requiredReviewPasses(repaired),2);
  assert.match(evaluationPrompt(t,u),/ONE clean independent review/);
  assert.throws(()=>combineReviewPair(t,[{...e,reviewedAt:new Date(now-1).toISOString()}]),/検証できません/);
  t.runs.at(-1)!.continuedFrom="old-session";
  assert.throws(()=>combineReviewPair(t,[e]),/検証できません/);
  assert.equal(requiredReviewPasses({...t,goal:{...t.goal!,revision:2}}),2);
  assert.equal(requiredReviewPasses({...t,roundNumber:2}),2);
});
