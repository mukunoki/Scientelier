import test from "node:test";
import assert from "node:assert/strict";
import { loginRoutePatch, sameRemoteConnection } from "./login-route";
import { continuation } from "./execution-policy";
import type { RemoteSystem, TaskRecord } from "./types";

const old:RemoteSystem={id:"old",name:"sx40",host:"192.0.2.1",username:"gateway",cwd:"base",nodeCommand:"node",pythonCommand:"python3",startup:"",instructions:"Original final-host rules",texCommand:"latexmk",connectionMode:"prepared",codexPermissions:"sandbox",
  resolvedCwd:"/home/user/project",preparedTarget:{hostname:"final-node",username:"user",home:"/home/user",cwd:"/home/user/project",nodeExecutable:"/opt/node"}};
const next:RemoteSystem={...old,id:"new",name:"5060ti",host:"192.0.2.2",username:"new-gateway",port:2222,cwd:"other-default",nodeCommand:"other-default-node",instructions:"Do not copy these defaults",codexPermissions:"full-access"};
function task():TaskRecord{return {id:"task",title:"Continue",cwd:"/local/cache",prompt:"Same goal",state:"paused",strategy:"balanced",execution:{reuseContext:true,decompose:true,maxSubtasks:2,maxParallel:2},allowedAgentIds:["codex"],modelOverrides:{},remote:old,
  workUnits:[{id:"worker",role:"worker",title:"Original",instructions:"Original",mode:"write",primary:true,state:"blocked",dependsOn:[],attemptedAgentIds:["codex"],launchBlocked:true}],
  runs:[{id:"run",workUnitId:"worker",role:"worker",agentId:"codex",providerKey:"openai",state:"cancelled",output:"Preserve evidence",startedAt:"2026-10-01T00:00:00Z",terminationUnconfirmed:true,remoteSession:{token:"original",controlDirectory:"/original",detached:true}}],
  goal:{status:"approved",revision:3,updatedAt:"2026-10-01",objective:"Same goal",deliverables:[],criteria:[],constraints:[],outOfScope:[],questions:[]},roundNumber:4,instruction:"Continue prior work",output:"Prior work",createdAt:"2026-10-01",updatedAt:"2026-10-02"};}

test("first-hop selection changes only the gateway and retains final identity, execution policy, history and uncertain termination fences",()=>{
  const t=task(),before=structuredClone(t),patch=loginRoutePatch(t,next,{updatedAt:t.updatedAt,confirmed:true});
  assert.deepEqual(patch.remote,{...old,id:next.id,name:next.name,host:next.host,username:next.username,port:next.port});
  assert.deepEqual(Object.keys(patch),["remote","loginRouteChanges"]);assert.deepEqual(t,before);
  assert.equal(patch.remote!.preparedTarget!.hostname,"final-node");assert.equal(patch.remote!.codexPermissions,"sandbox");
  assert.equal(t.runs[0].terminationUnconfirmed,true);assert.equal(t.workUnits[0].launchBlocked,true);
  assert.equal(patch.loginRouteChanges!.length,1);
});

test("route selection requires a stopped manual-SSH task and current explicit confirmation, but not a connection or artifact transfer",()=>{
  const t=task(),confirmation={updatedAt:t.updatedAt,confirmed:true};
  for(const value of [undefined,null,{...confirmation,confirmed:false},{...confirmation,updatedAt:"stale"}])assert.throws(()=>loginRoutePatch(t,next,value),/最新状態/);
  assert.throws(()=>loginRoutePatch({...t,state:"running"},next,confirmation),/一時停止/);
  assert.throws(()=>loginRoutePatch({...t,runs:[{...t.runs[0],state:"running"}]},next,confirmation),/一時停止/);
  assert.throws(()=>loginRoutePatch(t,{...next,connectionMode:"direct"},confirmation),/手動/);
  const run={...t.runs[0],state:"completed" as const,terminationUnconfirmed:false,primary:true,model:"model",goalRevision:3,codexPermissions:"sandbox" as const,sessionId:"01234567-1234-1234-1234-0123456789ab"};
  const ready={...t,runs:[run]};
  assert.ok(continuation({...ready,...loginRoutePatch(ready,next,confirmation)},t.workUnits[0],"codex","model").run,"same final machine keeps usable native conversations");
});

test("prepared transport identity is the first SSH destination; final identity is pinned separately while direct mode keeps its full setup checks",()=>{
  assert.equal(sameRemoteConnection(old,{...old,cwd:"different",nodeCommand:"another-alias",pythonCommand:"other-python",startup:"other-default"}),true);
  for(const changed of [{...old,host:"different"},{...old,username:"other"},{...old,port:2222},{...old,connectionMode:"direct" as const}])assert.equal(sameRemoteConnection(old,changed),false);
  const direct={...old,connectionMode:"direct" as const};
  assert.equal(sameRemoteConnection(direct,{...direct,codexPermissions:"full-access"}),true);
  for(const changed of [{cwd:"different"},{nodeCommand:"other"},{pythonCommand:"other"},{startup:"other"}])assert.equal(sameRemoteConnection(direct,{...direct,...changed}),false);
});
