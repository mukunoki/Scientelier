import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function projection() {
  const source = await readFile("dist/renderer/task-progress.js", "utf8");
  return runInNewContext(`${source}\n({taskCriterionProgress,taskUpcomingWork,taskPanelGroup,savedTaskWorkUnits})`);
}
function fixture() {
  return {
    state: "paused", roundNumber: 2, autonomyCycle: 3, goal: { revision: 4, criteria: [{ id: "precision", required: true, description: "精度", verification: "照合" }] },
    workUnits: [{ id: "review-a", state: "completed", mode: "read", dependsOn: [] }, { id: "review-b", state: "completed", mode: "read", dependsOn: [] }],
    evaluations: [receipt("review-a", "pass")]
  };
}
function receipt(id: string, status: string) {
  return { reviewUnitId: id, goalRevision: 4, round: 2, cycle: 3, reviewedAt: "2026-09-20T10:00:00Z", criteria: [{ criterionId: "precision", status, detail: "証拠", evidence: [{ path: "test.json", detail: "照合" }] }] };
}
test("progress is saved review evidence, never work-unit completion or a peer majority", async () => {
  const p = await projection(); const t = fixture();
  assert.equal(p.taskCriterionProgress(t)[0].status, "recorded-pass");
  t.evaluations.push(receipt("review-b", "fail"));
  assert.equal(p.taskCriterionProgress(t)[0].status, "needs-work");
  t.evaluations[1].criteria[0].status = "unverified";
  assert.equal(p.taskCriterionProgress(t)[0].status, "unverified");
  t.evaluations = [];
  assert.equal(p.taskCriterionProgress(t)[0].status, "unverified");
});
test("new goal, round, cycle, withdrawn review and subsequent writes require rechecking", async () => {
  const p = await projection();
  for (const key of ["goal", "roundNumber", "autonomyCycle", "retired", "write", "running"] as const) {
    const t = fixture();
    if (key === "goal") t.goal.revision++;
    if (key === "roundNumber") t.roundNumber++;
    if (key === "autonomyCycle") t.autonomyCycle++;
    if (key === "retired") t.workUnits = [];
    if (key === "write" || key === "running") t.workUnits.push({ id: "worker", state: key === "running" ? "running" : "completed", mode: "write", dependsOn: [], ...{ completedAt: "2026-09-20T11:00:00Z" } });
    assert.equal(p.taskCriterionProgress(t)[0].status, "recheck", key);
  }
});
test("only latest receipt for each review is used and projection does not mutate source", async () => {
  const p = await projection(); const t = fixture();
  t.evaluations.push({ ...receipt("review-a", "fail"), reviewedAt: "2026-09-20T09:00:00Z" });
  const before = JSON.stringify(t);
  assert.equal(p.taskCriterionProgress(t)[0].status, "recorded-pass");
  assert.equal(JSON.stringify(t), before);
  t.evaluations.push({ ...receipt("review-a", "fail"), reviewedAt: "2026-09-20T11:00:00Z" });
  assert.equal(p.taskCriterionProgress(t)[0].status, "needs-work");
});
test("upcoming work distinguishes prerequisites, missing dependencies and restart, without claiming launch readiness", async () => {
  const p = await projection();
  const t = { state: "paused", resumeFromUnitId: "retry", workUnits: [
    { id: "done", state: "completed", title: "終了", dependsOn: [] },
    { id: "live", state: "running", title: "実験", dependsOn: [] },
    { id: "next", state: "pending", title: "集計", dependsOn: ["live"] },
    { id: "missing", state: "pending", title: "不明", dependsOn: ["absent"] },
    { id: "eligible", state: "pending", title: "次", dependsOn: ["done"] },
    { id: "retry", state: "failed", title: "復旧", dependsOn: [] }
  ] };
  const before = JSON.stringify(t); const rows = p.taskUpcomingWork(t);
  assert.equal(rows.length, 4); assert.equal(rows[0].unit.id, "retry");
  assert.match(rows[0].reason, /復旧/);
  assert.match(rows.find((r: any) => r.unit.id === "next").reason, /実験/);
  assert.match(rows.find((r: any) => r.unit.id === "missing").reason, /状態確認/);
  assert.match(rows.find((r: any) => r.unit.id === "eligible").reason, /再開/);
  assert.equal(JSON.stringify(t), before);
});
test("eight navigation groups expose goal, plan, work report and history directly and retain specialized views", async () => {
  const p = await projection();
  for (const view of ["overview", "goal", "plan"]) assert.equal(p.taskPanelGroup(view), view);
  assert.equal(p.taskPanelGroup("followup"), "overview");
  for (const view of ["evidence", "quality", "research", "hpc"]) assert.equal(p.taskPanelGroup(view), "evidence");
  for (const view of ["execution", "work-report", "report", "history"]) assert.equal(p.taskPanelGroup(view), view);
});
test("historical work survives repair/replan and report-only legacy rounds", async () => {
  const p = await projection();
  const t = {workUnits:[{id:"a",state:"running"}],retiredWorkUnits:[{id:"b"}],history:[{report:{}},{workUnits:[{id:"a",state:"failed"}]}],autonomyHistory:[{workUnits:[{id:"c"}]}],interruptedHistory:[{workUnits:[{id:"d"}]}]};
  const units = p.savedTaskWorkUnits(t);
  assert.equal(units.map((u:any)=>u.id).join(","), "a,b,c,d"); assert.equal(units[0].state, "running");
});
