// Offline CLI stand-in for the remote transport smoke test. No LLM calls.
const { spawn, execFileSync } = require('node:child_process');
const { readFileSync, existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  if (existsSync('.fixture-diagnostic-fail')) { console.error('fixture: CLI environment unavailable'); process.exit(1); }
  console.log('codex-fixture 1.0'); process.exit(0);
}
if (args[0] === 'sandbox') { console.log('sandbox-fixture'); process.exit(0); }
const configs = args.filter((_, i) => args[i - 1] === '-c');
const option = key => JSON.parse(configs.find(v => v.startsWith(key + '=')).slice(key.length + 1));
const notify = option('notify');
const command = option('mcp_servers.agent_harness.command');
const commandArgs = option('mcp_servers.agent_harness.args');
if (existsSync('.fixture-mcp-failure')) {
  // Reproduce a native final response that could not even fetch instructions.
  execFileSync(notify[0], [...notify.slice(1), JSON.stringify({type:'agent-turn-complete','last-assistant-message':'MCP disconnected; no work performed.'})]);
  process.stdout.write('MCP unavailable; idle for diagnosis\r\n');
  process.stdin.on('data', data=>process.stdout.write(data));
  return;
}
const channel = spawn(command, commandArgs);
const pending = new Map(); let serial = 0, buffer = '';
channel.stdout.on('data', data => {
  buffer += data;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    pending.get(message.id)?.(message.result); pending.delete(message.id);
  }
});
const rpc = (method, params) => new Promise(resolve => { const id = ++serial; pending.set(id, resolve); channel.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
(async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name:'fixture',version:'1'} });
  const response = await rpc('tools/call', { name: 'get_instructions', arguments: {} });
  if (existsSync('.fixture-retain')) {
    require('node:fs').appendFileSync('.fixture-retained-starts', String(process.pid)+'\n');
    while (!existsSync('.fixture-release')) await new Promise(r=>setTimeout(r,25));
  }
  const instructions = response.content[0].text;
  if (instructions.includes('- script-reuse:')) {
    const skill = await rpc('tools/call', {name:'get_skill', arguments:{id:'script-reuse'}});
    if (skill.isError || !skill.content[0].text.includes('Script-first')) throw new Error('Skill retrieval failed');
  }
  const localReport = instructions.includes('# Local report stage for remote work');
  const remoteReport = !localReport && instructions.includes('# TeX build instructions');
  if ((!localReport && !instructions.includes('Remote execution environment')) || !instructions.includes(process.cwd())) throw new Error('Wrong execution environment');
  const draft = { objective: '遠隔ファイルを確認する', deliverables: ['TeXとPDF'], criteria: [{ id: 'result', description: '実ファイルを確認する', verification: '遠隔で読み取る', required: true }], constraints: [], outOfScope: [], questions: [] };
  let receipt = '<goal-draft>' + JSON.stringify(draft) + '</goal-draft>';
  if (localReport || remoteReport) {
    if (localReport && instructions.includes('# Remote execution environment')) throw new Error('Remote instructions leaked into local report');
    if (instructions.includes('# Report stage boundary')) throw new Error('Worker handoff instructions leaked into local reporter');
    if (localReport && args[args.indexOf('--sandbox')+1] !== 'workspace-write') throw new Error('Local report permissions were broadened');
    const source = instructions.match(/Report source: (.+)/)[1];
    if (!readFileSync(source,'utf8').includes('Keep partial report')) throw new Error('Partial report overwritten');
    writeFileSync(source, remoteReport ? 'Remotely completed report' : 'Locally completed report');
    writeFileSync(source.replace(/\.tex$/,'.pdf'), '%PDF-1.7\nReport fixture');
    const requirements = JSON.parse(instructions.match(/Editorial check requirements: ([^\n]+)/)[1]);
    receipt = '<editorial-check>'+JSON.stringify({revision:requirements.revision,status:'completed',summary:'Local fixture checked',sources:requirements.requiredSources,concerns:[]})+'</editorial-check>';
    // Exercise the same MCP quality path as a real reporter; the fixture
    // validates transport/permissions, not the semantic truth of a real paper.
    if(instructions.includes('# Common quality checks')){
      const call=async request=>{
        const r=await rpc('tools/call',{name:'quality_manage',arguments:{request}});
        if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);
      };
      const ledger=await call({action:'snapshot'});
      const basename=require('node:path').basename(source);
      for(const check of ledger.checks){
        await call({action:'plan',id:check.id,plan:{method:'manual',procedure:'Inspect isolated report transport fixture',targets:[basename]}});
        await call({action:'record',id:check.id,status:'pass',detail:'Fixture report inspected',evidence:[basename]});
      }
    }
  }
  const result = await rpc('tools/call', { name: 'submit_result', arguments: { result: receipt } });
  if (result.isError) throw new Error('Result was not accepted');
  // Reproduce the real reporter: a second result must not erase its editorial
  // receipt. Also exercise multiple typed receipts over the remote transport.
  const progress = await rpc('tools/call', { name: 'submit_result', arguments: { result: '<work-check>{"status":"ready","summary":"Additional progress receipt"}</work-check>' } });
  if (progress.isError) throw new Error('Additional result was not accepted');
  const summary = '遠隔CLIでゴール案を作成しました。';
  const marker = instructions.match(/\[\[HARNESS_HANDOFF:[0-9a-f-]+:completed\]\]/)[0];
  execFileSync(notify[0], [...notify.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'last-assistant-message': summary + '\n' + marker })]);
  // Prove the native hook used the remote runtime and remote control files.
  JSON.parse(readFileSync(notify.at(-2), 'utf8'));
  process.stdout.write('\x1b[32m' + summary + '\x1b[0m\r\n');
  channel.stdin.end(); process.stdin.on('data', data => process.stdout.write(data));
})().catch(error => { console.error(error); process.exit(1); });
