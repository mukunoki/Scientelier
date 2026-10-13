import test from "node:test";
import assert from "node:assert/strict";
import { reportCorrectionPatch } from "./report-correction";
import { validateReviewFormat, ReviewFormatError } from "./review-format";
import { requiredReviewPasses } from "./review-timing";
import type { TaskRecord, WorkUnit, GoalEvaluation } from "./types";

function fixture() {
  const units=[{id:"work",role:"worker",mode:"write",dependsOn:[]},
    {id:"report",role:"reporter",mode:"write",dependsOn:["work"]},
    {id:"review1",role:"reviewer",mode:"read",reviewPass:1,dependsOn:["report"]},
    {id:"review2",role:"reviewer",mode:"read",reviewPass:2,dependsOn:["review1"]}].map(u=>({...u,
      instructions:"existing scope",state:"completed",attemptedAgentIds:["codex"],assignedAgentId:"codex",startedAt:"old",completedAt:"old",output:"old"})) as WorkUnit[];
  const task={id:"task",state:"reviewing",roundNumber:1,autonomyCycle:1,goal:{status:"approved",revision:7},
    autonomy:{enabled:true},workUnits:units,runs:[],report:{texPath:"/report/report.tex"},
    workClosure:{round:1,cycle:1,goalRevision:7,startedAt:"old",reason:"bounded closure",issues:["performance not achieved"]}} as unknown as TaskRecord;
  const reviews=units.filter(u=>u.role==="reviewer").map(u=>({reviewUnitId:u.id,goalRevision:7,round:1,cycle:1,nextAction:"repair",reviewedAt:"old",repairInstructions:"",summary:"findings",
    criteria:[{criterionId:"performance",status:"fail",detail:"negative result",evidence:[]}],concerns:["performance not achieved"],
    reportCorrections:["Replace unsupported bit identity with agreement at stored precision."]})) as GoalEvaluation[];
  return {task,reviews};
}
test("bounded closure repairs only the manuscript once, preserves failures, history and review dependencies",()=>{
  const {task,reviews}=fixture();const before=structuredClone(task);
  const patch=reportCorrectionPatch(task,reviews,1000)!;
  assert.deepEqual(task,before,"patch generation never mutates saved history");
  const next={...task,...patch};assert.equal(next.state,"reporting");assert.deepEqual(next.workClosure!.issues,task.workClosure!.issues);
  assert.equal(next.retiredWorkUnits!.length,3);assert.equal(next.workUnits[0].id,"work");assert.equal(next.workUnits[0].state,"completed");
  const report=next.workUnits.find(u=>u.role==="reporter")!, first=next.workUnits.find(u=>u.reviewPass===1)!,second=next.workUnits.find(u=>u.reviewPass===2)!;
  assert.notEqual(report.id,"report");assert.deepEqual(first.dependsOn,[report.id]);assert.deepEqual(second.dependsOn,[first.id]);
  assert.ok(next.workUnits.slice(1).every(u=>u.state==="pending" && !u.startedAt && !u.output && !u.attemptedAgentIds.length));
  assert.match(report.instructions,/Do not run experiments/);assert.equal(reviews[0].criteria[0].status,"fail");
  assert.equal(reportCorrectionPatch(next,reviews),undefined,"at most one correction, never an infinite loop");
});
test("manuscript correction preserves the saved single-review adjustment and never bypasses blockers or approval",()=>{
  const {task,reviews}=fixture();task.workUnits=task.workUnits.filter(u=>u.reviewPass!==2);reviews.pop();
  task.reviewAdjustments=[{round:1,cycle:1,goalRevision:7,mode:"single",unitIds:["review1"],omittedUnits:[],decidedAt:"old",targetMinutes:90,elapsedMinutes:100,estimatedMinutes:5,reason:"soft target"}];
  const patch=reportCorrectionPatch(task,reviews)!;assert.equal(requiredReviewPasses({...task,...patch}),1);
  for(const changed of [{state:"paused"},{state:"blocked"},{state:"awaiting-input"},{goalRevisionPending:true},{pendingExecution:{}},{pendingFollowup:{}},{runs:[{state:"running"}]},
    {runs:[{terminationUnconfirmed:true}]},{executionBlocker:{kind:"tool",unitId:"work",round:1,cycle:1,goalRevision:7}},
    {autonomy:{enabled:false}},{workClosure:{...task.workClosure,finishedAt:"done"}}]) {
    assert.equal(reportCorrectionPatch({...task,...changed} as TaskRecord,reviews),undefined);
  }
  assert.equal(reportCorrectionPatch(task,[{...reviews[0],nextAction:"ask-user"}]),undefined);
  assert.equal(reportCorrectionPatch(task,[{...reviews[0],goalRevision:6}]),undefined);
  assert.equal(reportCorrectionPatch(task,[{...reviews[0],reportCorrections:[]}]),undefined);
});
test("optional report-only corrections survive format validation without manufacturing evidence",()=>{
  const value={goalRevision:7,criteria:[{criterionId:"c",status:"unverified",detail:"missing",evidence:[]}],concerns:["missing"],
    nextAction:"repair",repairInstructions:"",summary:"finding",reportCorrections:[" Correct the unsupported wording. "]};
  const parse=(v:unknown)=>validateReviewFormat(`<goal-evaluation>${JSON.stringify(v)}</goal-evaluation>`,{goalRevision:7,criterionIds:["c"],requireConcerns:true});
  assert.deepEqual(parse(value).reportCorrections,["Correct the unsupported wording."]);
  assert.equal(parse(value).criteria[0].status,"unverified");
  assert.throws(()=>parse({...value,reportCorrections:[""]}),ReviewFormatError);
  assert.throws(()=>parse({...value,reportCorrections:Array(9).fill("fix")}),ReviewFormatError);
});
