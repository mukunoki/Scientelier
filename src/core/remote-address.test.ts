import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { remoteAddressUpdates } from "./remote-address";
import { JsonTaskStore } from "./task-store";
import type { RemoteSystem, TaskRecord } from "./types";

const profile: RemoteSystem = { id: "cluster", name: "Research", host: "192.0.2.1", username: "login-user", cwd: "base",
  nodeCommand: "node", pythonCommand: "python3", startup: "", instructions: "Batch rules", texCommand: "latexmk", connectionMode: "prepared", codexPermissions: "full-access" };
const next = { ...profile, host: "192.0.2.2" };
const approval = { expectedHost: profile.host, confirmed: true };

function task(id: string, host = profile.host): TaskRecord {
  return { id, title: id, state: "paused", cwd: "/local/cache", prompt: "Continue research", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {},
    remote: { ...profile, host, cwd: "original-base", instructions: "Original instructions", codexPermissions: "sandbox", resolvedCwd: "/home/user/project",
      preparedTarget: { hostname: "original-node", username: "user", home: "/home/user", cwd: "/home/user/project", nodeExecutable: "/opt/node" } },
    goal: {revision:3,status:"approved",updatedAt:"2026-10-01T00:00:00Z",objective:"Preserve the goal",deliverables:[],constraints:[],outOfScope:[],questions:[],criteria:[]},
    workUnits: [{id:"work",title:"Original work",role:"worker",instructions:"Continue",mode:"write",state:"blocked",dependsOn:[],attemptedAgentIds:["codex"],launchBlocked:true}],
    runs: [{id:"original",workUnitId:"work",role:"worker",agentId:"codex",providerKey:"openai",state:"cancelled",terminal:true,output:"Prior evidence",startedAt:"2026-10-01T00:00:00Z",executionLocation:"remote",terminationUnconfirmed:true,
      remoteSession:{token:"original-token",controlDirectory:"/local/original",detached:true}}],
    roundNumber:2,resumeFromUnitId:"work",error:"Original fence",output:"Original summary",createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:10:00Z" };
}

test("explicit IP changes preserve final identities, workspace, account, goal, history and uncertain remote stops", () => {
  const items = [task("one"), task("two", "user@192.0.2.7"), { ...task("other"), remote: {...profile,id:"other"} }, { ...task("local"),remote:undefined }];
  const before = structuredClone(items);
  const updates = remoteAddressUpdates(profile, next, items, approval);
  assert.deepEqual(updates.map(u=>u.id), ["one", "two"]);
  for (const update of updates) {
    const original = items.find(t=>t.id===update.id)!;
    const {host:_old,...rest}=original.remote!, {host:_new,...changed}=update.patch.remote;
    assert.deepEqual(changed, rest);
    assert.equal(update.patch.remote.host, update.id === "two" ? "user@192.0.2.2" : "192.0.2.2");
    assert.deepEqual(Object.keys(update.patch), ["remote"]);
  }
  assert.deepEqual(items, before, "proposal never edits saved tasks or claims stopped processes exited");
  assert.deepEqual(remoteAddressUpdates(next,next,updates.map(u=>({...items.find(t=>t.id===u.id)!,...u.patch})),{...approval,expectedHost:next.host}), []);
});

test("IP reflection rejects stale consent, unrelated connection changes and active work, but not stopped retention fences", () => {
  for (const input of [undefined,null,false,{},approval.expectedHost,{...approval,confirmed:false},{...approval,expectedHost:"stale"}])
    assert.throws(()=>remoteAddressUpdates(profile,next,[task("held")],input));
  for (const patch of [{username:"other"},{port:2222},{cwd:"different"},{nodeCommand:"other-node"},{startup:"new setup"},{pythonCommand:"python-other"},{connectionMode:"direct" as const},{host:"other@192.0.2.2"}])
    assert.throws(()=>remoteAddressUpdates(profile,{...next,...patch},[task("held")],approval),/IP・サーバ名変更だけ/);
  for (const state of ["running","planning","reporting","reviewing"] as const)
    assert.throws(()=>remoteAddressUpdates(profile,next,[{...task("busy"),state}],approval),/一時停止/);
  for (const item of [{...task("busy"),runs:[{...task("busy").runs[0],state:"running" as const}]},
    {...task("busy"),workUnits:[{...task("busy").workUnits[0],state:"running" as const}]}])
    assert.throws(()=>remoteAddressUpdates(profile,next,[item],approval),/一時停止/);
  assert.equal(remoteAddressUpdates(profile,next,[task("retained")],approval).length,1);
});

test("batched address persistence preserves task state and leaves unrelated tasks untouched across reload", async () => {
  const root=await mkdtemp(join(tmpdir(),"harness-address-"));
  try {
    const path=join(root,"tasks.json"),store=new JsonTaskStore(path);await store.init();
    const input={title:"Remote",prompt:"Keep work",cwd:root,strategy:"balanced" as const,allowedAgentIds:["codex" as const],modelOverrides:{},goalMode:"manual" as const};
    const a=await store.create(input,undefined,profile),b=await store.create(input,undefined,profile),local=await store.create(input);
    const beforeLocal=store.get(local.id);
    await store.update(a.id,{state:"paused",remote:task("x").remote,runs:task("x").runs,workUnits:task("x").workUnits,goal:task("x").goal});
    const before=store.get(a.id)!;
    const updates=remoteAddressUpdates(profile,next,store.list(),approval);
    await assert.rejects(store.updateMany([...updates,{id:"missing",patch:{}}]));
    assert.equal(store.get(a.id)!.remote!.host,profile.host,"invalid batches change nothing");
    await store.updateMany(updates);
    const disk=JSON.parse(await readFile(path,"utf8"));
    assert.ok(disk.tasks.filter((t:TaskRecord)=>t.remote).every((t:TaskRecord)=>t.remote!.host===next.host));
    const reload=new JsonTaskStore(path);await reload.init();const after=reload.get(a.id)!;
    assert.deepEqual(after,JSON.parse(JSON.stringify({...before,remote:{...before.remote!,host:next.host},updatedAt:after.updatedAt})));
    assert.equal(reload.get(b.id)!.state,b.state);
    assert.deepEqual(reload.get(local.id),JSON.parse(JSON.stringify(beforeLocal)));
  } finally {await rm(root,{recursive:true,force:true});}
});
