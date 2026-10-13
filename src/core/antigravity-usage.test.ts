import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installAntigravityUsage, readAntigravityUsage, antigravityQuota, readAntigravityUsageLink } from "./antigravity-usage";
import { summarizeResources } from "./usage-tracker";
import { installRemoteAntigravityUsage, readRemoteAntigravityUsage } from "./antigravity-remote";
import { execFile } from "node:child_process";
const { sanitize } = require(join(process.cwd(),"scripts","antigravity-status.cjs"));

test("official Antigravity quota is allowlisted, never confuses remaining with used or context tokens", () => {
  const value=sanitize({product:"antigravity",email:"PRIVATE",accessToken:"SECRET",cwd:"/private",agent_state:"idle",context_window:{used_percentage:80},
    plan_tier:"Pro",quota:{"gemini-weekly":{remaining_fraction:0.75,reset_time:"2026-09-20T00:00:00Z",secret:"SECRET"},"model-1":{remaining_fraction:0},bad:{remaining_fraction:2},text:{remaining_fraction:"0.5"}}},"2026-09-17T10:00:00Z");
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE|SECRET|private|context_window/);
  const parsed=antigravityQuota(value,Date.parse("2026-09-17T11:00:00Z"))!;
  assert.equal(parsed.observation.windows?.length,2);
  assert.equal(parsed.observation.windows?.[0].usedPercent,25);
  assert.equal(parsed.observation.windows?.[0].label,"Gemini · 週の共有枠");
  assert.equal(parsed.observation.windows?.[1].usedPercent,100);
  assert.equal(parsed.observation.usedPercent,undefined,"independent buckets are not an account-wide percent");
  assert.equal(parsed.observation.limited,false,"one model exhausted must not block the whole service");
  assert.equal(sanitize({product:"antigravity",quota:{bad:{remaining_fraction:NaN}}}),undefined);
  assert.equal(sanitize({product:"other",quota:{m:{remaining_fraction:1}}}),undefined);
  assert.equal(antigravityQuota({...value,observedAt:"invalid"}),undefined);
  assert.equal(antigravityQuota({...value,observedAt:"2999-01-01T00:00:00Z"}),undefined);
  const resources=summarizeResources({
    warningPercent:70,drainPercent:90,agentPolicies:[{agentId:"antigravity",enabled:true,providerKey:"google-antigravity",providerLabel:"Google",authMode:"subscription"}]
  } as any, [{id:"antigravity",installed:true}] as any, [], [{providerKey:"google-antigravity",windows:parsed.observation.windows,source:"reported-live",updatedAt:value.observedAt}]);
  assert.equal(resources[0].usedPercent,undefined);
  assert.equal(resources[0].state,"available"); assert.equal(resources[0].windows.length,2);
});

test("Usage hook installation preserves settings, backs up once, rejects custom status lines and reads only quota snapshots", async () => {
  const home=await mkdtemp(join(tmpdir(),"harness-agy-usage-"));
  try {
    const dir=join(home,".gemini","antigravity-cli"), snapshot=join(home,"observed","quota.json");
    await mkdir(dir,{recursive:true}); const settings=join(dir,"settings.json");
    const original=JSON.stringify({colorScheme:"dark",useG1Credits:false}); await writeFile(settings,original);
    await installAntigravityUsage(home,"/test path/status.cjs","/test's/node",snapshot);
    const saved=JSON.parse(await readFile(settings,"utf8"));
    assert.equal(saved.colorScheme,"dark"); assert.equal(saved.useG1Credits,false);
    assert.equal(saved.statusLine.stack_with_default,true);
    assert.match(saved.statusLine.command,/ELECTRON_RUN_AS_NODE=1/);
    assert.equal(await readFile(`${settings}.before-harness-usage`,"utf8"),original);
    await installAntigravityUsage(home,"/test path/status.cjs","/test's/node",snapshot);
    assert.equal(await readFile(`${settings}.before-harness-usage`,"utf8"),original);
    assert.equal(await readAntigravityUsage(snapshot),undefined);
    await writeFile(snapshot,JSON.stringify(sanitize({product:"antigravity",quota:{"model-a":{remaining_fraction:.1}}})));
    assert.equal((await readAntigravityUsage(snapshot))?.observation.windows?.[0].usedPercent,90);
    await writeFile(snapshot,"invalid PRIVATE"); await assert.rejects(()=>readAntigravityUsage(snapshot),/観測データ/);
    await writeFile(settings,JSON.stringify({statusLine:{command:"my custom status"}}));
    await assert.rejects(()=>installAntigravityUsage(home,"/test","/node",snapshot),/上書きしません/);
    assert.equal(JSON.parse(await readFile(settings,"utf8")).statusLine.command,"my custom status");
  } finally { await rm(home,{recursive:true,force:true}); }
});

test("first-use usage setup reflects the real setting without changing it or trusting cached quota", async () => {
  const home=await mkdtemp(join(tmpdir(),"harness-agy-link-"));
  try {
    const script="/test path/status.cjs", executable="/test's/node", snapshot=join(home,"quota.json");
    const inspect=()=>readAntigravityUsageLink(home,script,executable,snapshot);
    assert.equal((await inspect()).state,"not-configured");
    await writeFile(snapshot,JSON.stringify(sanitize({product:"antigravity",quota:{m:{remaining_fraction:0.5}}})));
    assert.equal((await inspect()).state,"not-configured","a quota cache cannot certify current integration");
    await installAntigravityUsage(home,script,executable,snapshot);
    const path=join(home,".gemini","antigravity-cli","settings.json");
    const installed=await readFile(path,"utf8");
    assert.equal((await inspect()).state,"enabled");
    assert.equal(await readFile(path,"utf8"),installed,"inspection is read-only");
    const settings=JSON.parse(installed);
    await writeFile(path,JSON.stringify({...settings,statusLine:{...settings.statusLine,enabled:false}}));
    assert.equal((await inspect()).state,"not-configured");
    const custom=JSON.stringify({privateCredential:"SECRET",statusLine:{type:"command",command:"my custom display",enabled:true}});
    await writeFile(path,custom);
    const conflict=await inspect();assert.equal(conflict.state,"conflict");
    assert.doesNotMatch(JSON.stringify(conflict),/SECRET|my custom display/);
    assert.equal(await readFile(path,"utf8"),custom);
    await writeFile(path,"invalid SECRET");assert.equal((await inspect()).state,"unavailable");
    assert.equal(await readFile(path,"utf8"),"invalid SECRET");
    await writeFile(path,"[]");assert.equal((await inspect()).state,"unavailable");
    await writeFile(path,"x".repeat(262145));assert.equal((await inspect()).state,"unavailable");
    assert.equal((await inspect()).state,"unavailable","inspection never repairs invalid settings");
  } finally { await rm(home,{recursive:true,force:true}); }
});

test("remote usage hook installs on the final host and returns only timestamped quota", async () => {
  const home = await mkdtemp(join(tmpdir(), "harness-remote-agy-"));
  try {
    assert.ok("error" in await readRemoteAntigravityUsage(home));
    const source = await readFile(join(process.cwd(), "scripts", "antigravity-status.cjs"), "utf8");
    await installRemoteAntigravityUsage(source, home);
    const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.match(saved.statusLine.command, /service-usage/);
    const script = join(home, ".agent-harness", "service-usage", "antigravity-status.cjs");
    const snapshot = join(home, ".agent-harness", "service-usage", "antigravity-quota.json");
    const payload = { product: "antigravity", email: "PRIVATE", accessToken: "SECRET", quota: { "gemini-weekly": { remaining_fraction: .6 } } };
    // Execute the shipped hook exactly as the CLI does, using stdin, not credentials.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, [script, snapshot], error => error ? reject(error) : resolve());
      child.stdin!.end(JSON.stringify(payload));
    });
    const result = await readRemoteAntigravityUsage(home);
    assert.ok("observation" in result);
    if ("observation" in result) { assert.equal(result.observation.windows?.[0].usedPercent, 40); assert.ok(Date.parse(result.observedAt)); }
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|email|accessToken/);
    await writeFile(settingsPath, JSON.stringify({ statusLine: { command: "custom" } }));
    await assert.rejects(() => installRemoteAntigravityUsage(source, home), /上書きしません/);
    assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).statusLine.command, "custom");
  } finally { await rm(home, { recursive: true, force: true }); }
});
