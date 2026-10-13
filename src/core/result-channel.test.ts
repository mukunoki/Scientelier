import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readStructuredResult, saveStructuredResult, validateStructuredResult, resultChannelPrompt, resultPermissionDecision, completionResultAlternatives, finishStructuredRun, validateCompletionResults } from "./result-channel";
import { buildInvocation } from "./adapters";
import { readChannelState } from "./channel-state";
import { validateReviewFormat } from "./review-format";
import { validatePlanFormat } from "./plan-format";

test("file completion uses scoped receipts and repairs a confused work-check notification without inventing success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "file-completion-")), token = "this-run";
  const summary = "実機検査の結果を保存しました。物理演算器の利用率は未確認のままです。";
  const check = '<work-check>{"status":"needs-work","summary":"計測は保存済み","remainingWork":"物理演算器の確認","estimatedRemainingMinutes":5,"evidence":[]}</work-check>';
  try {
    await writeFile(join(directory,"completion-contract.json"),JSON.stringify({token,alternatives:[["work-check"],["execution-plan"]]}));
    await assert.rejects(finishStructuredRun(directory,token,summary),/未提出|未受理/);
    await assert.rejects(readFile(join(directory,"handoff.json")),{code:"ENOENT"});
    for (const draft of [JSON.stringify({status:"ready",summary}), "{unfinished", JSON.stringify({token,status:"completed",summary})]) {
      // A hand-written notification without validated receipts must remain
      // correctable, even when it already contains this run's token.
      await writeFile(join(directory,"handoff.json"),draft);
      await saveStructuredResult(directory,token,check);
      assert.equal(await readStructuredResult(directory,token),check);
    }
    await finishStructuredRun(directory,token,summary);
    const handoff = JSON.parse(await readFile(join(directory,"handoff.json"),"utf8"));
    assert.equal(handoff.token,token); assert.equal(handoff.status,"completed");
    assert.equal(handoff.summary,summary); assert.equal(handoff.receiptValidated,true);
    assert.equal(await readStructuredResult(directory,token),check,"needs-work is not promoted to ready");
    await assert.rejects(saveStructuredResult(directory,token,check),/終了済み/);
    await assert.rejects(finishStructuredRun(directory,token,summary),/終了済み/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("file completion requires all role receipts and rejects foreign, rejected and retired submissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "completion-gates-")), token = "run";
  try {
    await writeFile(join(directory,"completion-contract.json"),JSON.stringify({token,alternatives:[["work-check","editorial-check"]]}));
    await saveStructuredResult(directory,token,'<work-check>{"status":"ready"}</work-check>');
    await assert.rejects(validateCompletionResults(directory,token),/editorial-check/);
    await writeFile(join(directory,"structured-result-editorial-check.json"),JSON.stringify({token:"foreign",structured:'<editorial-check>{"status":"completed"}</editorial-check>'}));
    await assert.rejects(validateCompletionResults(directory,token),/未提出|未受理/);
    await writeFile(join(directory,"structured-result-editorial-check.json"),JSON.stringify({token,rejected:true,structured:'<editorial-check>{"status":"completed"}</editorial-check>'}));
    await assert.rejects(finishStructuredRun(directory,token,"完了"),/未提出|未受理/);
    await saveStructuredResult(directory,token,'<editorial-check>{"status":"blocked","concerns":["出典未確認"]}</editorial-check>');
    await validateCompletionResults(directory,token); // A truthful blocked verdict is transported, not certified.
    await assert.rejects(finishStructuredRun(directory,"foreign","完了"),/一致/);
    await assert.rejects(finishStructuredRun(directory,token,'<work-check>{}</work-check>'),/管理JSON/);
    await assert.rejects(finishStructuredRun(directory,token," "),/通常の文章/);
    await writeFile(join(directory,"retired.json"),JSON.stringify({token}));
    await assert.rejects(finishStructuredRun(directory,token,"停止理由","blocked"),/終了済み/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("file completion stdin produces an atomic correct notification; real failure needs no fabricated receipt", async () => {
  for (const mode of ["--finish", "--finish-blocked", "--finish-rate-limited"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "finish-stdin-"));
    try {
      await writeFile(join(directory,"completion-contract.json"),JSON.stringify({token:"run",alternatives:[["work-check"]]}));
      if (mode === "--finish") await saveStructuredResult(directory,"run",'<work-check>{"status":"ready"}</work-check>');
      const child = spawn(process.execPath,[join(__dirname,"result-channel.js"),directory,"run",mode]);
      let err=""; child.stderr.on("data",d=>err+=d); child.stdin.end("具体的な結果または停止理由。未確認事項は保持。");
      assert.equal(await new Promise(resolve=>child.on("close",resolve)),0,err);
      const handoff = JSON.parse(await readFile(join(directory,"handoff.json"),"utf8"));
      assert.equal(handoff.token,"run");
      assert.equal(handoff.status,mode === "--finish" ? "completed" : mode === "--finish-blocked" ? "blocked" : "rate-limited");
    } finally {await rm(directory,{recursive:true,force:true});}
  }
});

test("completion requirements distinguish plans, primary work, reporting and independent milestones", () => {
  const task:any={goal:{status:"approved"},reviewPolicy:{}};
  const requirements=(unit:any,t=task)=>completionResultAlternatives(t,unit);
  assert.deepEqual(requirements({role:"worker",primary:true}),[["work-check"],["execution-plan"]]);
  assert.deepEqual(requirements({role:"worker",primary:true,planPhase:true}),[["execution-plan"]]);
  assert.deepEqual(requirements({role:"worker",primary:true,primaryStep:{}}),[[]]);
  assert.deepEqual(requirements({role:"worker",subtask:{kind:"isolated-work"}}),[[]]);
  assert.deepEqual(requirements({role:"planner",checkpointFor:"worker"}),[["work-check"]]);
  assert.deepEqual(requirements({role:"planner",orchestrator:{}}),[["work-plan"]]);
  assert.deepEqual(requirements({role:"reporter"}),[["editorial-check"]]);
  assert.deepEqual(requirements({role:"reviewer"}),[["goal-evaluation"]]);
  assert.deepEqual(requirements({role:"worker"},{goalPreparation:true}),[["goal-draft"]]);
});

test("first environment failure survives progress replacement and cannot become success", async () => {
  const directory=await mkdtemp(join(tmpdir(),"environment-receipt-"));
  const failure='<work-check>{"status":"environment-blocked","blocker":{"kind":"hardware","summary":"GPUなし","recovery":"権限を確認","check":"Metal device nil"}}</work-check>';
  try {
    await saveStructuredResult(directory,"run",failure);
    await saveStructuredResult(directory,"run",'<work-check>{"status":"ready","summary":"Later progress"}</work-check>');
    await saveStructuredResult(directory,"run",'<editorial-check>{"status":"pass"}</editorial-check>');
    assert.equal(await readStructuredResult(directory,"run"),failure);
    await assert.rejects(readStructuredResult(directory,"other"),/another run/);
    await assert.rejects(readFile(join(directory,"handoff.json")),{code:"ENOENT"});
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("long subject reports retain the first negative receipt across later progress and editorial submissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "long-environment-receipt-"));
  const wrap = (value: unknown) => `<work-check>${JSON.stringify(value)}</work-check>`;
  const failure = wrap({ status: "environment-blocked", summary: "GPUなし", remainingWork: "GPUで実測する", estimatedRemainingMinutes: 0, evidence: [],
    blocker: { kind: "hardware", summary: "GPUなし", recovery: "権限を確認", check: "Metal device nil" },
    workReport: { activities: Array(12).fill("測定".repeat(700)) } });
  try {
    assert.ok(failure.length > 16000);
    await saveStructuredResult(directory, "run", failure);
    const latched = JSON.parse(await readFile(join(directory, "structured-result-environment-blocked.json"), "utf8"));
    assert.equal(latched.structured, failure);
    await saveStructuredResult(directory, "run", wrap({ status: "ready", summary: "Later progress" }));
    await saveStructuredResult(directory, "run", '<editorial-check>{"status":"pass"}</editorial-check>');
    assert.equal(await readStructuredResult(directory, "run"), failure, "later claims cannot replace the original environment failure");
    await assert.rejects(readFile(join(directory, "handoff.json")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("file CLI submission validates plans and never completes the run by itself", async () => {
  const directory = await mkdtemp(join(tmpdir(), "file-result-"));
  const plan = {summary:"日本語の再計画",reason:"Failed peer",primaryWork:"Repair",acceptance:"Verify",criterionIds:["a"],estimatedTokens:2000,estimatedMinutes:5,escalation:"New authority",tasks:[]};
  const wrap = (value: unknown) => `<execution-plan>${JSON.stringify(value)}</execution-plan>`;
  const submit = async (text: string, token = "run") => {
    const child = spawn(process.execPath,[join(__dirname,"result-channel.js"),directory,token,"--submit"]);
    let out = "", err = "";child.stdout.on("data",d=>out+=d);child.stderr.on("data",d=>err+=d);
    child.stdin.end(text);
    const code=await new Promise(resolve=>child.on("close",resolve));return {code,out,err};
  };
  try {
    await writeFile(join(directory,"plan-contract.json"),JSON.stringify({token:"run",criterionIds:["a"],requiredCriterionIds:["a"],maxSubtasks:2}));
    const accepted=await submit(wrap(plan));assert.equal(accepted.code,0,accepted.err);assert.match(accepted.out,/accepted/);
    assert.equal(await readStructuredResult(directory,"run"),wrap(plan));
    await assert.rejects(readFile(join(directory,"handoff.json")),{code:"ENOENT"});
    const rejected=await submit(wrap({...plan,estimatedTokens:"2000"}));assert.equal(rejected.code,1);assert.match(rejected.err,/未受理/);
    assert.equal(JSON.parse(await readFile(join(directory,"structured-result-execution-plan.json"),"utf8")).rejected,true);
    assert.equal((await submit(wrap(plan),"foreign")).code,1);
    await assert.rejects(readStructuredResult(directory,"foreign"),/another run/);
    assert.equal((await submit("x".repeat(48001))).code,1);
    await writeFile(join(directory,"retired.json"),JSON.stringify({token:"run"}));
    const retired=await submit(wrap(plan));assert.equal(retired.code,1);assert.match(retired.err,/終了済み/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("retired runs cannot retrieve instructions/skills or overwrite saved results", async () => {
  const directory=await mkdtemp(join(tmpdir(),"retired-channel-")),token="old-run";
  try {
    const original='<work-check>{"status":"partial"}</work-check>';
    await writeFile(join(directory,"instructions.txt"),"Old instructions");
    await writeFile(join(directory,"work-skills.json"),JSON.stringify({token,skills:[{id:"writing-rules",content:"Frozen rules"}]}));
    await saveStructuredResult(directory,token,original);
    await writeFile(join(directory,"retired.json"),JSON.stringify({token}));
    await assert.rejects(saveStructuredResult(directory,token,'<work-check>{"status":"complete"}</work-check>'),/終了済み/);
    assert.equal(await readStructuredResult(directory,token),original);
    const child=spawn(process.execPath,[join(__dirname,"result-channel.js"),directory,token]);
    let output="";child.stdout.on("data",chunk=>{output+=chunk;});
    child.stdin.end(["get_instructions","get_skill","submit_result"].map((name,id)=>JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:name==="get_instructions"?{}:name==="get_skill"?{id:"writing-rules"}:{result:original}}})).join("\n")+"\n");
    assert.equal(await new Promise(resolve=>child.on("close",resolve)),0);
    const replies=output.trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(replies.length,3);
    for(const reply of replies) {assert.equal(reply.result.isError,true);assert.match(reply.result.content[0].text,/終了済み/);}
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("plan submissions reject specific invalid fields in-session and retain rejected drafts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-contract-"));
  const contract = { token: "run", criterionIds: ["a"], requiredCriterionIds: ["a"], maxSubtasks: 2 };
  const plan = { summary: "Approach", reason: "Initial", primaryWork: "Implement", acceptance: "Run tests", criterionIds: ["a"], estimatedTokens: 900000, estimatedMinutes: 300, escalation: "New authority", tasks: [] };
  const wrap = (v: unknown) => `<execution-plan>${JSON.stringify(v)}</execution-plan>`;
  try {
    await writeFile(join(directory, "plan-contract.json"), JSON.stringify(contract));
    await saveStructuredResult(directory, "run", wrap(plan));
    for (const wrong of [{ ...plan, estimatedTokens: "900000" }, { ...plan, estimatedMinutes: undefined }, { ...plan, criterionIds: ["unknown"] }, { ...plan, tasks: null }]) {
      await assert.rejects(saveStructuredResult(directory, "run", wrap(wrong)), /未受理.*実行計画/s);
      assert.equal(await readStructuredResult(directory, "run"), wrap(wrong));
      assert.equal(JSON.parse(await readFile(join(directory, "structured-result-execution-plan.json"), "utf8")).rejected, true);
    }
    await assert.rejects(saveStructuredResult(directory, "wrong-token", wrap(plan)), /another run/);
    await saveStructuredResult(directory, "run", wrap(plan));
    assert.equal(await readStructuredResult(directory, "run"), wrap(plan));
    assert.equal(validatePlanFormat(plan, contract).estimatedTokens, 900000);
    assert.equal(JSON.parse(await readFile(join(directory, "structured-result-execution-plan.json"), "utf8")).rejected, undefined);
    await assert.rejects(readFile(join(directory, "handoff.json")));
    // Exercise the exact self-contained helper bundle uploaded to SSH hosts.
    for (const file of ["result-channel.js", "agent-messages.js", "redact.js", "execution-blocker.js", "work-check-format.js", "implementation-workspaces.js", "hpc.js", "quality.js", "research-cycle.js", "plan-format.js", "review-format.js", "channel-state.js", "runtime-identity.js"])
      await writeFile(join(directory, file), await readFile(join(__dirname, file)));
    const child = spawn(process.execPath, [join(directory, "result-channel.js"), directory, "run"]);
    let stdout = ""; child.stdout.on("data", chunk => { stdout += chunk; });
    child.stdin.end([
      { id: 1, method: "tools/call", params: { name: "submit_result", arguments: { result: wrap({ ...plan, estimatedMinutes: "300" }) } } },
      { id: 2, method: "tools/call", params: { name: "submit_result", arguments: { result: wrap(plan) } } }
    ].map(r => JSON.stringify({ jsonrpc: "2.0", ...r })).join("\n") + "\n");
    assert.equal(await new Promise(resolve => child.on("close", resolve)), 0);
    const messages = stdout.trim().split("\n").map(s => JSON.parse(s));
    assert.equal(messages[0].result.isError, true);
    assert.match(messages[0].result.content[0].text, /estimatedMinutes/);
    assert.equal(messages[1].result.isError, undefined);
    assert.equal(await readStructuredResult(directory, "run"), wrap(plan));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("review submissions validate against the run contract and self-correct through the same MCP session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-contract-"));
  const contract = { token: "token", goalRevision: 3, criterionIds: ["a"], requireConcerns: true };
  const payload = { goalRevision: 3, criteria: [{ criterionId: "a", status: "unverified", detail: "Missing validation evidence", evidence: [] }], nextAction: "repair", repairInstructions: "Verify the boundary case", summary: "One issue" };
  const wrap = (v: unknown) => `<goal-evaluation>${JSON.stringify(v)}</goal-evaluation>`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await writeFile(join(directory, "review-contract.json"), JSON.stringify(contract));
    const good = wrap({ ...payload, concerns: ["Boundary case needs validation"] });
    await saveStructuredResult(directory, "token", good);
    await assert.rejects(saveStructuredResult(directory, "token", wrap(payload)), /concerns.*配列/);
    const rejected = (await readStructuredResult(directory, "token"))!;
    assert.throws(() => validateReviewFormat(rejected, contract), /concerns/);
    assert.match(rejected, /Verify the boundary case/); // no loss of substantive findings
    await assert.rejects(saveStructuredResult(directory, "other-token", good), /another run/);
    for (const wrong of [{ ...payload, concerns: null }, { ...payload, concerns: "none" }, { ...payload, concerns: [], goalRevision: 2 }, { ...payload, concerns: [], criteria: [] }]) {
      await assert.rejects(saveStructuredResult(directory, "token", wrap(wrong)), /未受理/);
    }
    child = spawn(process.execPath, [join(__dirname, "result-channel.js"), directory, "token"]);
    let stdout = ""; child.stdout!.on("data", chunk => { stdout += chunk; });
    child.stdin!.end([
      { id: 1, method: "tools/call", params: { name: "submit_result", arguments: { result: wrap(payload) } } },
      { id: 2, method: "tools/call", params: { name: "submit_result", arguments: { result: good } } }
    ].map(r => JSON.stringify({ jsonrpc: "2.0", ...r })).join("\n") + "\n");
    assert.equal(await new Promise(resolve => child!.on("close", resolve)), 0);
    const messages = stdout.trim().split("\n").map(s => JSON.parse(s));
    assert.equal(messages[0].result.isError, true);
    assert.match(messages[0].result.content[0].text, /再提出/);
    assert.equal(messages[1].result.isError, undefined);
    assert.equal(await readStructuredResult(directory, "token"), good);
    assert.deepEqual(validateReviewFormat(good, contract).concerns, ["Boundary case needs validation", "Verify the boundary case"]);
    await assert.rejects(readFile(join(directory, "handoff.json"))); // receipt alone never completes review
  } finally { child?.kill(); await rm(directory, { recursive: true, force: true }); }
});

test("management channel accepts one bounded block per call, never arbitrary files or completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "result-channel-"));
  try {
    assert.equal(await readStructuredResult(directory, "a"), undefined);
    await saveStructuredResult(directory, "a", '<work-check>{"status":"ready"}</work-check>');
    assert.equal(await readStructuredResult(directory, "a"), '<work-check>{"status":"ready"}</work-check>');
    await assert.rejects(readStructuredResult(directory, "b"));
    await assert.rejects(readFile(join(directory, "handoff.json")));
    for (const bad of ['{}', '<evil>{}</evil>', '<work-check>[]</work-check>', '<work-check>{}</work-check><work-check>{}</work-check>', 'x'.repeat(48001)]) assert.throws(() => validateStructuredResult(bad));
    assert.match(resultChannelPrompt("Original scope"), /Original scope/);
    assert.match(resultChannelPrompt("Original scope"), /not in the terminal's final answer/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("typed receipts survive later submissions, concurrent types and same-type corrections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "result-types-"));
  const editorial = '<editorial-check>{"status":"completed","summary":"Checked"}</editorial-check>';
  const work = '<work-check>{"status":"ready"}</work-check>';
  try {
    await saveStructuredResult(directory, "run", editorial);
    await saveStructuredResult(directory, "run", work);
    let output = (await readStructuredResult(directory, "run"))!;
    assert.ok(output.includes(editorial)); assert.ok(output.includes(work));
    const correction = '<editorial-check>{"status":"blocked","concerns":["PDF needs repair"]}</editorial-check>';
    await Promise.all([
      saveStructuredResult(directory, "run", correction),
      saveStructuredResult(directory, "run", '<goal-evaluation>{"summary":"Independent result"}</goal-evaluation>')
    ]);
    output = (await readStructuredResult(directory, "run"))!;
    assert.ok(output.includes(correction)); assert.ok(output.includes(work));
    assert.equal([...output.matchAll(/<editorial-check>/g)].length, 1);
    assert.ok(!output.includes(editorial));
    assert.match(output, /goal-evaluation/);
    await assert.rejects(readStructuredResult(directory, "another-run"), /another run/);
    await assert.rejects(readFile(join(directory, "handoff.json")));
    await writeFile(join(directory, "structured-result-work-check.json"), JSON.stringify({token:"run",structured:editorial}));
    await assert.rejects(readStructuredResult(directory, "run"), /type does not match/);
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test("legacy receipts remain readable without duplicating new typed receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "result-legacy-"));
  try {
    const legacy = '<work-check>{"status":"ready"}</work-check>';
    await writeFile(join(directory,"structured-result.json"),JSON.stringify({token:"run",structured:legacy}));
    assert.equal(await readStructuredResult(directory,"run"),legacy);
    const current = '<work-check>{"status":"needs-work"}</work-check>';
    await saveStructuredResult(directory,"run",current);
    assert.equal(await readStructuredResult(directory,"run"),current);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("real stdio MCP exchanges requests; result receipt cannot complete a workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "result-rpc-"));
  const child = spawn(process.execPath, [join(__dirname, "result-channel.js"), directory, "token"]);
  let stdout = ""; child.stdout.on("data", chunk => { stdout += chunk; });
  try {
    await writeFile(join(directory, "instructions.txt"), "Approved instructions only");
    await writeFile(join(directory,"time-budget.json"),JSON.stringify({token:"token",elapsedMinutes:5,targetMinutes:30}));
    child.stdin.end([
      { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { method: "notifications/initialized" }, { id: 2, method: "tools/list" },
      { id: 3, method: "tools/call", params: { name: "submit_result", arguments: { result: '<goal-evaluation>{"goalRevision":1}</goal-evaluation>' } } },
      { id: 4, method: "tools/call", params: { name: "submit_result", arguments: { path: "/should-not-write", result: "invalid" } } },
      { id: 5, method: "tools/call", params: { name: "get_instructions", arguments: {} } },
      { id: 6, method: "tools/call", params: { name: "get_instructions", arguments: { path: "/unrelated" } } },
      { id: 7, method: "tools/call", params: { name: "get_progress", arguments: {} } }
    ].map(r => JSON.stringify({ jsonrpc: "2.0", ...r })).join("\n") + "\n");
    assert.equal(await new Promise(resolve => child.on("close", resolve)), 0);
    const responses = stdout.trim().split("\n").map(s => JSON.parse(s));
    assert.equal(responses[0].result.protocolVersion, "2025-03-26");
    assert.deepEqual(responses[1].result.tools.map((t: any) => t.name), ["get_progress", "get_run_evidence", "get_instructions", "submit_result"]);
    assert.equal(responses[2].result.isError, undefined); assert.equal(responses[3].result.isError, true);
    assert.equal(responses[4].result.content[0].text, "Approved instructions only");
    assert.equal(responses[5].result.isError, true);
    assert.deepEqual(JSON.parse(responses[6].result.content[0].text),{elapsedMinutes:5,targetMinutes:30});
    assert.equal((await readChannelState(directory,"token"))?.phase,"instructions-read");
    assert.equal(await readChannelState(directory,"another-run"),undefined);
    assert.match((await readStructuredResult(directory, "token"))!, /goal-evaluation/);
    await assert.rejects(readFile(join(directory, "handoff.json")));
  } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
});

test("per-run MCP configuration preserves the selected CLI permission policy and scopes result tools", () => {
  for (const id of ["codex", "claude"] as const) {
    const result = buildInvocation({ id, label: id, command: id, installed: true, executable: id }, { prompt: "Hello", mode: "read", cwd: "/tmp", resultCommand: ["node", "/application/result-channel.js", "/private/run", "token"] });
    const args = result.args.join(" ");
    assert.match(args, /agent_harness/); assert.match(args, /submit_result/);
    assert.doesNotMatch(args, /skip-permissions|workspace-write|strict-mcp/);
    if (id === "codex") assert.doesNotMatch(args, /bypass/);
    assert.match(args, id === "codex" ? /read-only/ : /--permission-mode bypassPermissions/);
  }
});

test("Claude pre-tool permission decision is limited to valid management submissions", () => {
  const input = { hook_event_name: "PreToolUse", tool_name: "mcp__agent_harness__submit_result", tool_input: { result: '<work-check>{"status":"ready"}</work-check>' } };
  assert.equal((resultPermissionDecision(input) as any).hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(resultPermissionDecision({ ...input, tool_name: "Bash" }), {});
  assert.deepEqual(resultPermissionDecision({ ...input, hook_event_name: "PermissionRequest" }), {});
  assert.equal((resultPermissionDecision({ ...input, tool_input: { ...input.tool_input, path: "/arbitrary" } }) as any).hookSpecificOutput.permissionDecision, "deny");
});
