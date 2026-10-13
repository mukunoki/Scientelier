import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexCapacityPayload, readCodexCapacity } from "./capacity-probes";
import { spawn } from "node:child_process";

const probeFixture = (mode: string) => (command: string, args: string[], cwd: string) => {
  assert.equal(command, "fixture-codex"); assert.deepEqual(args, ["app-server", "--stdio"]);
  return spawn(process.execPath, ["-e", `
    let initialized = false;
    const mode = ${JSON.stringify(mode)};
    const send = (id,result,error) => process.stdout.write(JSON.stringify({id,result,error})+'\\n');
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line);
      if(m.method==='initialize') { if(mode!=='init-timeout') send(m.id,{}); }
      if(m.method==='initialized') initialized=true;
      if(m.method==='account/rateLimits/read') {
        if(!initialized) return send(m.id,null,{message:'Not initialized'});
        if(mode==='usage-timeout') return;
        if(mode==='auth-error') return send(m.id,null,{message:'HTTP 401 Unauthorized'});
        send(m.id,mode==='empty' ? {} : {rateLimits:{primary:{usedPercent:14,windowDurationMins:10080}}});
      }
      if(m.method==='model/list') {
        if(mode==='models-timeout') return;
        if(mode==='exit-after-usage') return process.exit(1);
        if(mode==='models-error') return send(m.id,null,{message:'catalog unavailable'});
        send(m.id,{data:[{model:'fixture-model',displayName:'Fixture'}]});
      }
    });
  `], { cwd, stdio: ["pipe", "pipe", "pipe"] });
};

test("Codex probe completes initialization and keeps fresh usage if optional model discovery fails", async () => {
  for (const mode of ["ok", "models-timeout", "models-error", "exit-after-usage"]) {
    const result = await readCodexCapacity("fixture-codex", process.cwd(), 1000, probeFixture(mode));
    assert.equal(result.windows?.[0].usedPercent, 14, mode);
    if (mode === "ok") assert.equal(result.models?.[0].id, "fixture-model");
  }
});

test("Codex probe identifies timeouts and rejects empty usage / authentication failures", async () => {
  for (const [mode, error] of [["init-timeout", /CLIの初期化待ち/], ["usage-timeout", /使用量APIの応答待ち/], ["empty", /上限情報を返しません/], ["auth-error", /401/]] as const) {
    await assert.rejects(readCodexCapacity("fixture-codex", process.cwd(), 1000, probeFixture(mode)), error);
  }
});

test("Codex capacity parser preserves every model and time window", () => {
  const observation = parseCodexCapacityPayload({
    ordinaryUsageAllowed: true,
    rateLimits: {},
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: 1_789_442_101 },
        secondary: null,
        credits: { balance: "0" },
        planType: "pro"
      },
      codex_fast: {
        limitId: "codex_fast",
        limitName: "Fast model",
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_789_123_760 },
        secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 1_789_710_560 },
        credits: null,
        planType: "pro"
      }
    }
  }, {
    data: [
      { model: "gpt-latest", displayName: "GPT Latest", isDefault: true, hidden: false },
      { model: "gpt-fast", displayName: "GPT Fast", isDefault: false, hidden: false }
    ]
  });

  assert.equal(observation.limited, false);
  assert.equal(observation.usedPercent, 12);
  assert.equal(observation.plan, "pro");
  assert.equal(observation.creditBalance, "0");
  assert.equal(observation.models?.find((model) => model.isDefault)?.label, "GPT Latest");
  assert.deepEqual(observation.windows?.map((window) => window.id), [
    "codex:primary",
    "codex_fast:primary",
    "codex_fast:secondary"
  ]);
  assert.equal(observation.windows?.[0].scope, "shared");
  assert.equal(observation.windows?.[1].scope, "model");
});

test("Codex capacity parser treats backend denial as a hard limit", () => {
  const observation = parseCodexCapacityPayload({
    ordinaryUsageAllowed: false,
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_789_123_760 }
    }
  });
  assert.equal(observation.limited, true);
  assert.equal(observation.ordinaryUsageAllowed, false);
});
