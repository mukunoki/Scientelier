import test from "node:test";
import assert from "node:assert/strict";

test("every role, goal preparation and coordinator request Japanese bullet reports without changing schemas",()=>{
  const t=task();
  for(const unit of t.workUnits) {
    const prompt=buildWorkUnitPrompt(t,unit);
    assert.match(prompt,/日本語で書く/);assert.match(prompt,/1項目につき1つ/);assert.match(prompt,/JSONのキー.*改変しない/);
  }
  assert.match(buildWorkUnitPrompt({...t,goalPreparation:true},t.workUnits[0]),/日本語で書く/);
  assert.match(buildWorkUnitPrompt(t,{...t.workUnits[0],orchestrator:{round:1,goalRevision:1,planRevision:1,triggerUnitIds:[]}}),/日本語で書く/);
});
import {
  buildWorkUnitPrompt,
  createStandardWorkflow,
  selectAgent
} from "./orchestration";
import type {
  AgentPolicy,
  AgentStatus,
  ProviderResourceSummary,
  TaskRecord,
  WorkUnit
} from "./types";

const policies: AgentPolicy[] = [
  { agentId: "codex", enabled: true, providerKey: "openai", providerLabel: "OpenAI", authMode: "subscription", priority: 80 },
  { agentId: "claude", enabled: true, providerKey: "anthropic", providerLabel: "Anthropic", authMode: "subscription", priority: 75 },
  { agentId: "gemini", enabled: true, providerKey: "google", providerLabel: "Google", authMode: "subscription", priority: 70 },
  { agentId: "opencode", enabled: true, providerKey: "openai", providerLabel: "OpenAI", authMode: "api-key", priority: 60 }
];

const agents: AgentStatus[] = policies.map((policy) => ({
  id: policy.agentId,
  label: policy.agentId,
  command: policy.agentId,
  installed: true,
  executable: `/usr/local/bin/${policy.agentId}`
}));

function resource(providerKey: string, state: ProviderResourceSummary["state"], usedPercent = 0): ProviderResourceSummary {
  const members = policies.filter((policy) => policy.providerKey === providerKey);
  return {
    providerKey,
    providerLabel: members[0]?.providerLabel ?? providerKey,
    agentIds: members.map((member) => member.agentId),
    authModes: [...new Set(members.map((member) => member.authMode))],
    state,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    runs: 0,
    failures: 0,
    usedPercent,
    windows: [],
    models: [],
    limitSource: "configured"
  };
}

function task(workUnits = createStandardWorkflow()): TaskRecord {
  return {
    id: "task-1",
    title: "Test workflow",
    prompt: "Implement and verify the requested feature.",
    cwd: "/tmp",
    strategy: "balanced",
    allowedAgentIds: policies.map((policy) => policy.agentId),
    modelOverrides: {},
    workUnits,
    runs: [],
    state: "queued",
    output: "",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z"
  };
}

test("when every service wrote artifacts, final review prefers a different provider from the last manuscript editor",()=>{
  const t=task();t.reviewPolicy="adversarial-pair";t.allowedAgentIds=["codex","claude","opencode"];
  const worker=t.workUnits[1],review=t.workUnits[2],reporter=t.workUnits[3];
  const at=new Date().toISOString();
  t.runs=[{id:"w",workUnitId:worker.id,agentId:"claude",providerKey:"anthropic",role:"worker",state:"completed",output:"",startedAt:at},
    {id:"p",workUnitId:reporter.id,agentId:"codex",providerKey:"openai",role:"reporter",state:"completed",output:"",startedAt:at}];
  const input={task:t,unit:review,agents,settings:{agentPolicies:policies,contextMaxChars:20000,warningPercent:75,drainPercent:90},resources:[resource("openai","available"),resource("anthropic","available")]};
  assert.equal(selectAgent(input),"claude");
  assert.equal(selectAgent({...input,agents:agents.filter(a=>a.id!=="claude")}),"codex","writer fallback does not deadlock when no other service is eligible");
});

test("standard workflow is a sequential plan, execute, review, report chain", () => {
  const workflow = createStandardWorkflow();
  assert.deepEqual(workflow.map((unit) => unit.role), ["planner", "worker", "reviewer", "reporter"]);
  assert.equal(workflow[0].mode, "read");
  assert.equal(workflow[1].mode, "write");
  assert.equal(workflow[2].mode, "read");
  assert.equal(workflow[3].mode, "write");
  for (let index = 1; index < workflow.length; index += 1) {
    assert.deepEqual(workflow[index].dependsOn, [workflow[index - 1].id]);
  }
});

test("research critics cannot be routed to their experimental ancestor's CLI",()=>{
  const current=task();current.researchCycle=1;
  const writer=current.workUnits[1], critic={...current.workUnits[2],role:"worker" as const,subtask:{key:"critic",title:"Critic",instructions:"Verify",deliverable:"Critique",acceptance:"Evidence",criterionIds:[],dependsOn:[],estimatedTokens:500,researchCritic:true}};
  current.workUnits[2]=critic;
  current.runs=[{id:"run",workUnitId:writer.id,agentId:"codex",providerKey:"openai",role:"worker",state:"completed",output:"result",startedAt:new Date().toISOString()}];
  const input={task:current,unit:critic,agents,settings:{agentPolicies:policies,contextMaxChars:20000,warningPercent:75,drainPercent:90},resources:[resource("openai","available"),resource("anthropic","available")],previousAgentId:"codex" as const};
  assert.notEqual(selectAgent(input),"codex");
  assert.equal(selectAgent({...input,agents:agents.filter(a=>a.id==="codex")}),undefined);
  const earlier={...writer,id:"earlier",dependsOn:[]};
  writer.dependsOn=[earlier.id];current.workUnits.unshift(earlier);
  current.runs.unshift({...current.runs[0],id:"earlier-run",workUnitId:earlier.id,agentId:"claude",providerKey:"anthropic"});
  assert.equal(selectAgent({...input,agents:agents.filter(a=>["codex","claude"].includes(a.id))}),"claude","unrelated earlier writer must not eliminate an independent critic");
  critic.dependsOn.push(earlier.id);
  assert.equal(selectAgent({...input,agents:agents.filter(a=>["codex","claude"].includes(a.id))}),undefined,"explicitly reviewing both writers still requires a third CLI");
});

test("isolated implementation instructions do not inherit read-only consultation prohibitions", () => {
  const current = task();
  const worker = current.workUnits[1];
  worker.subtask = { kind: "isolated-work", ownedFiles: ["kernel.f90"], key: "kernel", title: "Kernel", instructions: "Implement kernel", deliverable: "kernel.f90", acceptance: "Replay matches", criterionIds: [], dependsOn: [], estimatedTokens: 1000 };
  const prompt = buildWorkUnitPrompt(current, worker);
  assert.match(prompt, /Isolated delegated implementation/);
  assert.doesNotMatch(prompt, /# Read-only delegated work/);
  worker.subtask.kind = "investigation";
  worker.mode = "read";
  assert.match(buildWorkUnitPrompt(current, worker), /# Read-only delegated work/);
});

test("reporter separates subject content from operational handoffs and cleans inherited boilerplate", () => {
  const current = task();
  const prompt = buildWorkUnitPrompt(current, current.workUnits[3]);
  assert.match(prompt, /self-contained document about the user's subject/);
  assert.match(prompt, /Do not include agent\/CLI\/model assignments/);
  assert.match(prompt, /application history\/external logs/);
  assert.match(prompt, /remove inherited administration sections/);
  assert.match(prompt, /preserving subject-related scientific content/);
  assert.match(prompt, /Do not invent author names/);
});

test("reviewer uses a different provider when one is available", () => {
  const unit: WorkUnit = { ...createStandardWorkflow()[2], attemptedAgentIds: [] };
  const selected = selectAgent({
    task: task(),
    unit,
    agents,
    settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 },
    resources: [resource("openai", "available"), resource("anthropic", "available"), resource("google", "available")],
    previousAgentId: "codex"
  });
  assert.notEqual(selected, "codex");
  assert.notEqual(selected, "opencode");
});

test("routing prefers a provider that is not draining", () => {
  const unit: WorkUnit = { ...createStandardWorkflow()[1], attemptedAgentIds: [] };
  const selected = selectAgent({
    task: { ...task(), allowedAgentIds: ["codex", "claude"] },
    unit,
    agents,
    settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 },
    resources: [resource("openai", "draining", 90), resource("anthropic", "available", 20), resource("google", "available")]
  });
  assert.equal(selected, "claude");
});

test("quota probe failures do not exclude a CLI; real cooldowns still do", () => {
  for (const id of ["codex", "claude", "opencode"] as const) for (const capacityError of ["HTTP 401", "HTTP 403", "HTTP 429", "Ollama Webログイン未連携"]) {
    const policy = policies.find(p => p.agentId === id)!;
    const current = { ...task(), allowedAgentIds: [id] };
    const quota = { ...resource(policy.providerKey, "available"), limitSource: "unknown" as const, usedPercent: undefined, capacityError };
    const input = { task: current, unit: current.workUnits[1], agents,
      settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 }, resources: [quota] };
    assert.equal(selectAgent(input), id, `${id}: quota-only failure is not a runtime authentication failure`);
    assert.equal(selectAgent({ ...input, resources: [{ ...quota, state: "cooldown" }] }), undefined);
  }
});

test("native execution failures avoid a recently failed service without changing quota or overriding a pin",()=>{
  const t=task();t.allowedAgentIds=["codex","claude"];
  t.execution={scheduling:"balanced",reuseContext:true,decompose:true,maxParallel:2,maxSubtasks:4};
  const now=new Date().toISOString();
  t.runs=[{id:"failed",workUnitId:"old",agentId:"codex",providerKey:"openai",role:"worker",state:"failed",
    startedAt:now,completedAt:now,output:"",executionFailure:{kind:"capacity",summary:"Native capacity failure"}}];
  const resources=[resource("openai","available",10),resource("anthropic","available",10)];
  const input={task:t,unit:t.workUnits[1],agents,settings:{agentPolicies:policies,warningPercent:70,drainPercent:85},resources};
  assert.equal(selectAgent(input),"claude");assert.equal(resources[0].state,"available");assert.equal(resources[0].usedPercent,10);
  t.assignments={worker:{agentId:"codex",allowFallback:false}};
  assert.equal(selectAgent(input),undefined,"a hard pin must not be silently changed");
  t.runs[0].recoveredAt=now;assert.equal(selectAgent(input),"codex");
  t.assignments=undefined;t.runs[0].recoveredAt=undefined;
  t.runs.push({id:"proof",workUnitId:"probe",agentId:"codex",providerKey:"openai",role:"worker",state:"completed",
    startedAt:new Date(Date.now()+1).toISOString(),completedAt:now,output:""});
  assert.equal(selectAgent({...input,agents:agents.filter(a=>a.id==="codex")}),"codex","later successful use clears admission; reliability may still rank alternatives higher");
});

test("provider concentration is a soft ranking hint, never a quota estimate or a mandatory rotation",()=>{
  const t=task();t.allowedAgentIds=["codex","claude"];
  t.execution={scheduling:"balanced",reuseContext:true,decompose:true,maxParallel:2,maxSubtasks:4};
  const input={task:t,unit:t.workUnits[1],agents,settings:{agentPolicies:policies,warningPercent:70,drainPercent:85},
    resources:[resource("openai","available",10),resource("anthropic","available",10)]};
  assert.equal(selectAgent(input),"codex");
  const end=Date.now();
  t.runs=[{id:"long",workUnitId:"old",agentId:"codex",providerKey:"openai",role:"worker",state:"completed",output:"",
    startedAt:new Date(end-60*60000).toISOString(),completedAt:new Date(end).toISOString(),
    executionTiming:{source:"channel",workStartedAt:new Date(end-55*60000).toISOString()}}];
  assert.equal(selectAgent(input),"claude");
  t.assignments={worker:{agentId:"codex",allowFallback:false}};assert.equal(selectAgent(input),"codex");
  t.assignments=undefined;assert.equal(selectAgent({...input,agents:agents.filter(a=>a.id==="codex")}),"codex");
});

test("an unused OpenCode remains competitive when Ollama quota telemetry is unavailable",()=>{
  const t=task();t.allowedAgentIds=["codex","claude","opencode"];
  t.execution={scheduling:"balanced",reuseContext:true,decompose:true,maxParallel:3,maxSubtasks:4};
  const ps=policies.map(p=>p.agentId==="opencode"?{...p,providerKey:"ollama-cloud"}:p);
  const input={task:t,unit:t.workUnits[1],agents,settings:{agentPolicies:ps,warningPercent:75,drainPercent:90},resources:[
    {...resource("openai","available",44),capacityUpdatedAt:new Date().toISOString()},
    {...resource("anthropic","available",50),capacityUpdatedAt:new Date().toISOString()},
    {...resource("ollama-cloud","available"),usedPercent:undefined,capacityError:"Ollama Usage Web未連携"}]};
  assert.equal(selectAgent(input),"opencode");
  assert.equal(input.resources[2].usedPercent,undefined,"unknown quota is not converted to a percentage");
  t.assignments={worker:{agentId:"codex",allowFallback:false}};
  assert.equal(selectAgent(input),"codex");
  t.assignments=undefined;input.resources[2].state="cooldown";
  assert.notEqual(selectAgent(input),"opencode");
  input.resources[2].state="available";t.allowedAgentIds=["codex","claude"];
  assert.notEqual(selectAgent(input),"opencode");
});

test("balanced and throughput investigation routing allow every active CLI without relaxing launch contracts", () => {
  for (const scheduling of ["balanced", "throughput"] as const) for (const id of ["antigravity", "opencode"] as const) {
    const current = task();
    current.execution = { scheduling, reuseContext: true, decompose: true, maxParallel: 2, maxSubtasks: 4 };
    current.allowedAgentIds = [id];
    current.modelOverrides[id] = id === "antigravity" ? "gemini-3-pro" : "ollama/deepseek-v4.1-flash:cloud";
    const unit: WorkUnit = { ...current.workUnits[1], mode: "read", subtask: {key:"inspect",title:"Inspect",instructions:"Read sources",deliverable:"Evidence",acceptance:"Compare",criterionIds:[],dependsOn:[],estimatedTokens:1000} };
    const policy: AgentPolicy = { agentId: id, enabled: true, providerKey: id, providerLabel: id, authMode: "subscription", priority: 70 };
    const input = { task: current, unit, agents: [{ id, label:id,command:id,installed:true,executable:"/fake" }],
      settings: { agentPolicies:[policy],warningPercent:70,drainPercent:90 }, resources:[resource(id,"available")] };
    assert.equal(selectAgent(input), id, `${scheduling}: ${id} is a valid investigator`);
    assert.equal(selectAgent({...input,resources:[resource(id,"cooldown",100)]}), undefined);
    assert.equal(selectAgent({...input,settings:{...input.settings,agentPolicies:[{...policy,enabled:false}]}}), undefined);
    assert.equal(selectAgent({...input,task:{...current,allowedAgentIds:[]}}), undefined);
    assert.equal(selectAgent({...input,unit:{...unit,subtask:{...unit.subtask!,requirements:{modelFamilies:["anthropic"]}}}}), undefined);
  }
});

test("routing applies a model-specific quota only when that model is requested", () => {
  const unit: WorkUnit = { ...createStandardWorkflow()[1], attemptedAgentIds: [] };
  const openai = {
    ...resource("openai", "available", 3),
    models: [
      { id: "gpt-latest", label: "GPT Latest", isDefault: true, source: "catalog" as const },
      { id: "gpt-fast", label: "GPT Fast", source: "catalog" as const }
    ],
    windows: [
      { id: "shared", label: "Shared", usedPercent: 3, scope: "shared" as const },
      { id: "fast", label: "Fast", usedPercent: 90, scope: "model" as const, model: "GPT Fast" }
    ]
  };
  const normal = selectAgent({
    task: { ...task(), allowedAgentIds: ["codex", "claude"] },
    unit,
    agents,
    settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 },
    resources: [openai, resource("anthropic", "available", 20)]
  });
  assert.equal(normal, "codex");

  const overridden = selectAgent({
    task: {
      ...task(),
      allowedAgentIds: ["codex", "claude"],
      modelOverrides: { codex: "gpt-fast" }
    },
    unit,
    agents,
    settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 },
    resources: [openai, resource("anthropic", "available", 20)]
  });
  assert.equal(overridden, "claude");
});

test("handoff prompt includes prior completed output", () => {
  const workflow = createStandardWorkflow();
  workflow[0] = { ...workflow[0], state: "completed", assignedAgentId: "codex", output: "Plan result" };
  const prompt = buildWorkUnitPrompt(task(workflow), workflow[1]);
  assert.match(prompt, /Plan result/);
  assert.match(prompt, /Required handoff/);
});

test("manual assignments respect strict pinning and permitted capacity fallback", () => {
  const current = task(); const unit = current.workUnits[1];
  current.allowedAgentIds = ["codex", "claude"];
  current.assignments = { worker: { agentId: "codex", model: "specific", allowFallback: false } };
  const args = { task: current, unit, agents, settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 },
    resources: [resource("openai", "available", 100), resource("anthropic", "available", 10)] };
  assert.equal(selectAgent(args), undefined);
  current.assignments.worker!.allowFallback = true;
  assert.equal(selectAgent(args), "claude");
  args.resources[0].usedPercent = 30;
  assert.equal(selectAgent(args), "codex");
});

test("iteration routing keeps the previous worker if capacity remains", () => {
  const current = task();
  current.runs = [{ id: "prior", workUnitId: "prior-unit", agentId: "claude", providerKey: "anthropic", role: "worker", state: "completed", output: "", startedAt: current.createdAt }];
  const args = { task: current, unit: current.workUnits[1], agents, settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 },
    resources: [resource("openai", "available", 1), resource("anthropic", "available", 40), resource("google", "available", 10)] };
  assert.equal(selectAgent(args), "claude");
  args.resources[1].usedPercent = 90;
  assert.notEqual(selectAgent(args), "claude");
});

test("progress checkpoints return to the planner, not the earlier ideation agent", () => {
  const current = task(), planner = current.workUnits[0];
  current.workUnits.unshift({ ...planner, id: "idea", ideaPhase: true });
  current.runs = [
    { id: "idea-run", workUnitId: "idea", agentId: "codex", providerKey: "openai", role: "planner", state: "completed", output: "Idea findings", startedAt: current.createdAt },
    { id: "plan-run", workUnitId: planner.id, agentId: "claude", providerKey: "anthropic", role: "planner", state: "completed", output: "Work plan", startedAt: current.createdAt }
  ];
  assert.equal(selectAgent({ task: current, unit: { ...planner, id: "checkpoint", checkpointFor: current.workUnits[2].id }, agents,
    settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 }, resources: [] }), "claude");
});
