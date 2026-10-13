// Real OpenCode integration, isolated settings + local fake model by default.
// --ollama-app --live explicitly uses the existing Ollama login and consumes cloud quota.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { buildInvocation } = require('../dist/core/adapters');
const { completionMarker } = require('../dist/core/completion-hook');

(async () => {
  const ollama = process.argv.includes('--ollama');
  const ollamaApp = process.argv.includes('--ollama-app');
  const live = process.argv.includes('--live');
  const repairNotification = process.argv.includes('--repair-notification');
  assert.ok(!repairNotification || !live, 'Notification repair fixture must not use a paid model');
  assert.ok(!live || ollamaApp, '--live requires --ollama-app');
  const provider = ollamaApp ? 'ollama' : ollama ? 'ollama-cloud' : 'harness-fixture';
  const modelId = ollamaApp ? 'deepseek-v4.1-flash:cloud' : ollama ? 'gpt-oss:120b' : 'fixture';
  const selectedModel = `${provider}/${modelId}`;
  const directory = await mkdtemp(join(tmpdir(), 'harness-opencode-smoke-'));
  const token = 'fixture-opencode-token'; let requests = 0, instructionCalls = 0, submissionCalls = 0, output = '', child;
  let repairPrompts = 0;
  const review = '<goal-evaluation>'+JSON.stringify({goalRevision:1,criteria:[{criterionId:'a',status:'fail',detail:'Real issue remains',evidence:[]}],concerns:['Keep this defect'],nextAction:'repair',repairInstructions:'Fix defect',summary:'Review requires repair'})+'</goal-evaluation>';
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests++;
    const tool = input.tools?.find(t => t.function.name.includes('get_instructions'));
    const submit = input.tools?.find(t => t.function.name.includes('submit_result'));
    const read = input.messages?.some(m => m.role === 'tool');
    const submitted = input.messages?.some(m => m.role === 'assistant' && m.tool_calls?.some(t => t.function.name.includes('submit_result')));
    const repairing = input.messages?.some(m => m.role === 'user' && JSON.stringify(m.content).includes('通知修正'));
    if (repairing) repairPrompts++;
    const call = tool && !read ? tool : submit && !submitted ? submit : undefined;
    if (call === tool && call) instructionCalls++;
    if (call === submit && call) submissionCalls++;
    const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: call === tool ? 'call_instructions' : 'call_submit', type: 'function', function: { name: call.function.name, arguments: call === tool ? '{}' : JSON.stringify({result:repairNotification ? review : '<work-check>{"status":"complete","summary":"Fixture verified","remainingWork":"","estimatedRemainingMinutes":0,"evidence":[]}</work-check>'}) } }] }
      : { role: 'assistant', content: tool ? `Fixture review requires repair.${repairNotification && !repairing ? '' : '\n'+completionMarker(token)}` : 'Fixture title' };
    const choice = { index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' };
    if (input.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = { ...message }; if (delta.tool_calls) delta.tool_calls[0].index = 0;
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [choice], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    for (const name of ['config', 'data', 'state', 'cache', 'workspace', 'control']) await mkdir(join(directory, name));
    const control = join(directory, 'control'), handoff = join(control, 'handoff.json');
    const plugin = await readFile(resolve('assets/opencode/agent-harness.mjs'), 'utf8');
    await writeFile(join(control, 'agent-harness.mjs'), plugin);
    await writeFile(join(control, 'completion-command.json'), JSON.stringify({ token, startedAt: Date.now(), command: [process.execPath, resolve('dist/core/completion-hook.js'), 'opencode', handoff, token] }));
    await writeFile(join(control, 'channel-required.json'), JSON.stringify({ token }));
    if (repairNotification) await writeFile(join(control,'review-contract.json'),JSON.stringify({token,goalRevision:1,criterionIds:['a'],requireConcerns:true}));
    await writeFile(join(control, 'instructions.txt'), `This is only a transport test, not a coding task. Do not inspect files, run commands or browse. Call agent_harness submit_result with parameter result exactly: <work-check>{"status":"complete","summary":"Transport verified","remainingWork":"","estimatedRemainingMinutes":0,"evidence":[]}</work-check>. After the tool accepts it, reply with exactly these two separate lines (the marker MUST be alone on the last line):\nTransport verified.\n${completionMarker(token)}`);
    const invocation = buildInvocation({ id: 'opencode', label: 'OpenCode', command: 'opencode', installed: true, executable: 'opencode' }, {
      prompt: `Call agent_harness get_instructions then finish. ${token}`, cwd: join(directory, 'workspace'), mode: 'write', model: selectedModel, codingPlan: ollamaApp ? 'ollama-app' : ollama ? 'ollama' : undefined,
      resultCommand: [process.execPath, resolve('dist/core/result-channel.js'), control, token], openCodePluginPath: join(control, 'agent-harness.mjs')
    });
    const config = JSON.parse(invocation.args[0].slice('OPENCODE_CONFIG_CONTENT='.length));
    if (ollama) {
      assert.deepEqual(config.enabled_providers, ['ollama-cloud']);
      assert.equal(config.provider['ollama-cloud'].options.baseURL, 'https://ollama.com/v1');
    }
    if (ollamaApp) {
      assert.deepEqual(config.enabled_providers, ['ollama']);
      assert.equal(config.provider.ollama.options.baseURL, 'http://127.0.0.1:11434/v1');
      assert.equal(config.provider.ollama.models[modelId].reasoning, true);
    }
    config.enabled_providers = [provider]; config.model = config.small_model = selectedModel;
    // Mock tests replace only the endpoint/key, retaining production model metadata.
    if (!live) config.provider = { [provider]: { name: 'Local fixture', npm: '@ai-sdk/openai-compatible', options: { apiKey: 'fixture-not-a-secret', baseURL: `http://127.0.0.1:${server.address().port}/v1` }, models: config.provider?.[provider]?.models ?? { [modelId]: { name: 'Fixture', limit: { context: 32000, output: 4096 } } } } };
    if (live) {
      config.agent.agent_harness.permission = { '*': 'deny', 'agent_harness_*': 'allow' };
      config.agent.agent_harness.steps = 4;
    }
    const env = { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'state'), XDG_CACHE_HOME: join(directory, 'cache'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_TEST_HOME: directory };
    // Suppress inherited provider keys/config in the fixture child, never read auth files.
    for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|^OPENCODE_CONFIG$|^OPENCODE_CONFIG_DIR$/.test(key)) delete env[key];
    const pty = require('node-pty');
    if (ollama) {
      // Check the installed CLI's real login entry without entering or saving any key.
      let loginOutput = '';
      const loginEnv = { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false }) };
      for (const [variable, folder] of [['XDG_CONFIG_HOME','auth-config'], ['XDG_DATA_HOME','auth-data'], ['XDG_STATE_HOME','auth-state'], ['XDG_CACHE_HOME','auth-cache']]) {
        loginEnv[variable] = join(directory, folder); await mkdir(loginEnv[variable]);
      }
      const login = pty.spawn('opencode', ['auth', 'login', '--provider', 'ollama-cloud'], {
        cwd: invocation.cwd, env: loginEnv, cols: 100, rows: 24, name: 'xterm-256color'
      });
      let loginExited = false; login.onExit(() => { loginExited = true; });
      login.onData(b => { loginOutput += b; });
      try {
        const deadline = Date.now() + 15000;
        while (!/API key/i.test(loginOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
        assert.match(loginOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), /API key/i, 'Ollama Cloud login must reach the API key prompt');
      } finally {
        login.write('\x03');
        const deadline = Date.now() + 3000;
        while (!loginExited && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
        if (!loginExited) login.kill();
      }
    }
    child = pty.spawn('opencode', invocation.args.slice(2), { cwd: invocation.cwd, env, cols: 120, rows: 36, name: 'xterm-256color' });
    child.onData(b => { output += b; }); let exited = false;
    child.onExit(() => { exited = true; });
    const deadline = Date.now() + (live ? 120000 : 45000);
    let result;
    while (Date.now() < deadline) {
      try { result = JSON.parse(await readFile(handoff, 'utf8')); break; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (exited) throw new Error('Fixture OpenCode exited before handoff');
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(result, 'Native TUI did not notify the harness within the fixture deadline');
    assert.equal(exited, false, 'Completed CLI must remain interactive');
    if (!live) assert.ok(requests > 0 && instructionCalls > 0 && submissionCalls > 0, output.slice(-8000));
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.token, token);
    const structured = JSON.parse(await readFile(join(control, repairNotification ? 'structured-result-goal-evaluation.json' : 'structured-result-work-check.json'), 'utf8'));
    assert.equal(structured.token, token);
    if (repairNotification) { assert.ok(repairPrompts > 0); assert.equal(submissionCalls,1); assert.equal(instructionCalls,1); assert.equal(structured.structured,review); }
    console.log(`OpenCode ${provider} native integration passed: ${live ? 'real Ollama cloud model (quota consumed)' : `${requests} local model requests (no paid requests)`}, MCP instructions + result submission, final event handoff, live terminal retained.`);
  } catch (e) { console.error(output.slice(-8000)); throw e; }
  finally { if (child) child.kill(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
