// Explicit opt-in integration smoke: uses two short real provider turns.
// It never runs a user task or asks the agent to edit files/use tools.
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { detectAgents } = require('../dist/core/cli-detect');
const { buildInvocation } = require('../dist/core/adapters');
const { TerminalRunner } = require('../dist/core/terminal-runner');
const { completionMarker } = require('../dist/core/completion-hook');

(async () => {
  const provider = process.argv[2];
  if (!['codex', 'claude'].includes(provider)) throw new Error('Specify codex or claude. This smoke uses real provider tokens.');
  const agent = (await detectAgents()).find(a => a.id === provider);
  assert.ok(agent?.installed);
  const controlDir = await mkdtemp(join(tmpdir(), 'harness-continuity-'));
  const runner = new TerminalRunner();
  const memory = `orchid-${randomUUID()}`;
  const turn = async (prompt, session) => {
    const id = randomUUID(), token = randomUUID(), path = join(controlDir, `${id}.json`);
    const command = buildInvocation(agent, { mode: 'write', cwd: process.cwd(), continueSession: session,
      prompt: `${prompt}\nDo not use tools, read files, start agents, or change anything. This is a tiny conversation-memory test. End your final answer with this EXACT last line: ${completionMarker(token)}. Then stay idle.`,
      completionCommand: [process.execPath, join(__dirname, '../dist/core/completion-hook.js'), provider, path, token] });
    let tail = '';
    const deadline = setTimeout(() => { console.error('Smoke-only timeout. Recent terminal:', tail.slice(-1600)); runner.cancel(id); }, 120000);
    try {
      const result = await runner.run(id, command, e => { tail = (tail + e.text).slice(-4000); }, { path, token });
      assert.equal(result.handoff?.status, 'completed', `No native completion. ${tail.slice(-1000)}`);
      assert.ok(result.handoff.sessionId, 'Native hook must return an exact session UUID.');
      return result.handoff;
    } finally { clearTimeout(deadline); }
  };
  try {
    console.log(`${provider}: starting first memory turn`);
    const first = await turn(`Remember the label ${memory}. Reply only ACK and the completion marker.`);
    console.log(`${provider}: first native hook delivered a session ID; forking the conversation`);
    const second = await turn('What exact label did I ask you to remember in the previous conversation? Reply with the label and the completion marker.', first.sessionId);
    assert.ok(second.summary.includes(memory), 'The second prompt did not contain the label; it must be recovered from native conversation memory.');
    assert.notEqual(second.sessionId, first.sessionId, 'Fork must preserve the original session separately.');
    console.log(`${provider}: native context inheritance, fresh handoff hook and original-session isolation verified`);
  } finally {
    runner.cancelAll();
    await rm(controlDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
