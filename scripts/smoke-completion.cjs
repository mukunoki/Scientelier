// Explicit, opt-in smoke test: one short real model turn per installed CLI.
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { detectAgents } = require('../dist/core/cli-detect');
const { buildInvocation } = require('../dist/core/adapters');
const { completionMarker } = require('../dist/core/completion-hook');
const { TerminalRunner } = require('../dist/core/terminal-runner');
const { initialGoal, goalPreparationUnit, parseGoalProposal } = require('../dist/core/goals');

(async () => {
  const writeTest = process.argv.includes('--write');
  const goalTest = process.argv.includes('--goal');
  const statusTest = process.argv.includes('--status');
  const agents = await detectAgents();
  for (const id of statusTest ? ['claude'] : goalTest ? ['codex'] : ['codex', 'claude']) {
    const status = agents.find(agent => agent.id === id && agent.installed);
    if (!status) { console.log(`${id}: not installed, skipped`); continue; }
    const directory = await mkdtemp(join(tmpdir(), 'harness-native-hook-test-'));
    const control = { path: join(directory, 'handoff.json'), token: randomUUID() };
    const runner = new TerminalRunner();
    const proof = join(directory, 'write-check.txt');
    const statusPath = join(directory, 'status.json');
    const invocation = buildInvocation(status, {
      cwd: process.cwd(), mode: writeTest ? 'write' : 'read',
      additionalDirectories: writeTest ? [directory] : [],
      statusCommand: statusTest ? ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, join(__dirname, '..', 'dist/core/claude-status-hook.js'), statusPath, control.token] : undefined,
      prompt: goalTest
        ? `${goalPreparationUnit(initialGoal('CSVの月別売上を集計し、図とIPSJ形式のPDFで説明したい'), '').instructions}\nThis is a small harness smoke test. Do not use tools, inspect files, use network services, modify files, or enter/exit plan mode. Propose at most 3 concise criteria. Leave missing CSV details as questions. After your goal-draft block, end with this exact line: ${completionMarker(control.token)}`
        : writeTest
        ? `This is a scoped harness permission smoke test, not a project task. Create exactly one file at ${proof} containing only the word ok, then read it to verify. This temporary directory is explicitly allowed for this test. Do not read or modify any other files, use network services, ask for confirmation, or change any settings. After successful verification, reply with a short acknowledgement and then this exact final line: ${completionMarker(control.token)}`
        : `This is a harness connection smoke test, not a project task. Do not use tools, read files, modify files, or enter/exit plan mode. Reply with a short acknowledgement and then this exact final line: ${completionMarker(control.token)}`,
      completionCommand: ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath,
        join(__dirname, '..', 'dist', 'core', 'completion-hook.js'), id, control.path, control.token]
    });
    let timeout;
    try {
      const result = await Promise.race([
        runner.run(id, invocation, event => {
          // Minimal terminal queries normally answered by xterm in the GUI.
          if (event.text.includes('\x1b[6n')) runner.write(id, '\x1b[1;1R');
          if (event.text.includes('\x1b[c')) runner.write(id, '\x1b[?1;2c');
        }, control),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${id}: no native completion within 60s`)), 60000); })
      ]);
      if (result.handoff?.status !== 'completed') throw new Error(`${id}: ${result.stderr || 'No completed handoff'}`);
      if (statusTest) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const status = JSON.parse(await readFile(statusPath, 'utf8'));
        if (status.token !== control.token || !status.observation.windows.length) throw new Error('No native quota notification');
        console.log('Native Claude quota:', JSON.stringify(status.observation.windows));
      }
      if (goalTest) {
        const goal = parseGoalProposal(result.handoff.summary);
        if (!goal.criteria.length || !goal.questions.length) throw new Error('Goal proposal must include criteria and missing-information questions');
        console.log(`${id}: real goal proposal parsed, ${goal.criteria.length} criteria, ${goal.questions.length} clarification questions; approval remains user-owned.`);
      }
      if (writeTest && (await readFile(proof, 'utf8')).trim() !== 'ok') throw new Error(`${id}: write verification failed`);
      if (!goalTest) console.log(`${id}: ${writeTest ? 'autonomous write + read verified; ' : ''}native completion received; terminal still alive=${runner.snapshot(id).alive}; ${result.handoff.summary}`);
    } finally {
      clearTimeout(timeout); runner.cancelAll();
      await new Promise(resolve => setTimeout(resolve, 2200));
      await rm(directory, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
