// Optional: one short real interactive CLI turn; uses a small amount of quota.
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { TerminalRunner } = require('../dist/core/terminal-runner');
const { buildInvocation } = require('../dist/core/adapters');
const { detectAgents } = require('../dist/core/cli-detect');
const { completionMarker } = require('../dist/core/completion-hook');
const { readStructuredResult } = require('../dist/core/result-channel');
(async () => {
  const id = process.argv[2]; if (!['codex','claude'].includes(id)) throw new Error('Choose codex or claude');
  const agent = (await detectAgents()).find(a=>a.id===id && a.installed); if (!agent) throw new Error('CLI not installed');
  const directory = await mkdtemp(join(tmpdir(),'harness-result-smoke-')), token=randomUUID();
  const runner = new TerminalRunner(); let timer;
  const writeTest = process.argv.includes('--write'), proof=join(directory,'proof.txt');
  try {
    const control={path:join(directory,'handoff.json'), token};
    const node=[process.execPath];
    const work=writeTest ? `Create only ${proof} containing ok, then read it to verify. This temporary file is explicitly authorized. Do not read or modify other files, change settings, use network services, or spawn agents.` : 'Do NOT inspect files, use shell tools, do project work, or spawn agents.';
    const prompt=`This is a minimal Agent Harness connection test. ${work} Call the agent_harness submit_result tool exactly once with result='<work-check>{"status":"ready"}</work-check>'. If deferred, discover the tool by name. After success, answer only 接続テスト完了 followed by a newline and ${completionMarker(token)}. Do not print the JSON in your answer. If unavailable/denied, state the blocker; do not work around permissions.`;
    await writeFile(join(directory,'instructions.txt'),prompt,{mode:0o600});
    const invocation=buildInvocation(agent,{ cwd:process.cwd(), mode:writeTest?'write':'read', additionalDirectories:writeTest?[directory]:[],
      resultCommand:[...node,join(__dirname,'../dist/core/result-channel.js'),directory,token],
      completionCommand:[...node,join(__dirname,'../dist/core/completion-hook.js'),id,control.path,token],
      prompt, launchPrompt:`Connection test. ${work} First call agent_harness get_instructions for the full instructions, then follow them and submit_result. If denied, report the blocker.` });
    const result=await Promise.race([runner.run('smoke',invocation,()=>{},control),new Promise((_,reject)=>{timer=setTimeout(async()=>reject(new Error('Smoke test timed out: '+JSON.stringify(runner.snapshot('smoke')?.data.slice(-3000)))),150000);})]);
    assert.equal(result.handoff?.status,'completed'); assert.match(result.handoff.summary,/接続テスト完了/);
    assert.doesNotMatch(result.handoff.summary,/<work-check>|"status"/);
    assert.equal(await readStructuredResult(directory,token),'<work-check>{"status":"ready"}</work-check>');
    if (writeTest) assert.equal((await readFile(proof,'utf8')).trim(),'ok');
    console.log(`${id}: native interactive tool -> side-channel result -> prose completion verified`);
  } finally { clearTimeout(timer); runner.cancelAll(); await new Promise(r=>setTimeout(r,2200)); await rm(directory,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
