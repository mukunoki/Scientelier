const { app, BrowserWindow, ipcMain } = require('electron');
const { TerminalRunner } = require('../dist/core/terminal-runner');
const runner = new TerminalRunner();
const { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { initialGoal, updateGoalContract } = require('../dist/core/goals');
const { createExecutionWorkflow } = require('../dist/core/orchestration');
const { pairUnits } = require('../dist/core/review-pair');
const { orderAutonomousUnits, validateAutonomy } = require('../dist/core/autonomy');
const { defaultExecution, validateExecution } = require('../dist/core/execution-policy');
const { WorkPresetStore } = require('../dist/core/work-presets');
const { RemoteSystemStore } = require('../dist/core/remote-systems');
const { WritingRulesStore } = require('../dist/core/finishing-skill');
const directory = mkdtempSync(join(tmpdir(), 'harness-layout-'));
app.setPath('userData', directory);
app.whenReady().then(async () => {
  let benchmarkState={enabled:false,hasKey:false,models:[]};
  ipcMain.handle('fixture:benchmarks-get',()=>benchmarkState);
  ipcMain.handle('fixture:benchmarks-inspect',(_e,model)=>require('../dist/core/model-benchmarks').inspectBenchmark(model,benchmarkState));
  ipcMain.handle('fixture:benchmarks-configure',async(_e,v)=>{await new Promise(r=>setTimeout(r,100));benchmarkState={...benchmarkState,enabled:v.enabled,hasKey:v.clearKey?false:!!v.apiKey||benchmarkState.hasKey};return benchmarkState;});
  ipcMain.handle('fixture:benchmarks-refresh',()=>{benchmarkState={...benchmarkState,fetchedAt:new Date().toISOString(),indexVersion:4.3,models:[{id:'codex-test',name:'Codex Test',intelligence:70,coding:80,agentic:60,tokensPerSecond:120}]};return benchmarkState;});
  const presets = new WorkPresetStore(join(__dirname, '..', 'assets', 'work-presets'), join(directory, 'presets'));
  const {SkillStore}=require('../dist/core/skill-store');
  const managedSkills=new SkillStore(join(directory,'skills'),join(__dirname,'..','assets','work-skills'));
  ipcMain.handle('fixture:skills-list',async()=>({...await managedSkills.list(),root:managedSkills.root,history:[]}));
  ipcMain.handle('fixture:skills-save',async(_e,_id,value)=>{await new Promise(r=>setTimeout(r,100));return managedSkills.save(value);});
  ipcMain.handle('fixture:skills-history',(_e,_id,key)=>managedSkills.history(key));
  ipcMain.handle('fixture:skills-promote',()=>undefined);
  const remoteSystems = new RemoteSystemStore(join(directory, 'remote-systems'));
  const remoteAddressSaves = [];
  ipcMain.handle('fixture:remote-save', async (_e, value, _confirmed, addressUpdate) => {
    let tasks, updates=[];
    if (addressUpdate) {
      const previous=(await remoteSystems.list()).find(system=>system.id===value.id);
      tasks=await win.webContents.executeJavaScript('structuredClone(state.tasks)');
      updates=require('../dist/core/remote-address').remoteAddressUpdates(previous,value,tasks,addressUpdate);
    }
    const result=await remoteSystems.save(value);
    if (addressUpdate) {
      remoteAddressSaves.push({value,addressUpdate});
      tasks=tasks.map(task=>({...task,...updates.find(update=>update.id===task.id)?.patch}));
      win.webContents.send('fixture:tasks-changed',tasks);
    }
    attachedEnvironments.delete(value.id); return result;
  });
  ipcMain.handle('fixture:remote-list', () => remoteSystems.list());
  const preparedTargets = new Map();
  const attachedEnvironments = new Set();
  let failNextRemoteCheck = false;
  ipcMain.handle('fixture:remote-status', (_event, id) => ({ mode: preparedTargets.has(id) ? 'prepared' : 'direct', stage: attachedEnvironments.has(id) ? 'ready' : 'closed', target: preparedTargets.get(id) }));
  ipcMain.handle('fixture:remote-check', async (_e, id) => {
    if (failNextRemoteCheck) { failNextRemoteCheck = false; throw new Error('Fixture: SSH authentication not finished'); }
    const system = (await remoteSystems.list()).find(s => s.id === id);
    const target = system?.connectionMode === 'prepared' ? {hostname:'final-node',username:'scientist',home:'/home/scientist',cwd:'/home/scientist/final-project',nodeExecutable:'/usr/bin/node'} : undefined;
    if (target) preparedTargets.set(id, target);
    attachedEnvironments.add(id);
    return {agents:[],cwd:target?.cwd ?? '/home/fixture/projects/test',target};
  });
  let loginRouteCalls=0;
  ipcMain.handle('fixture:login-route',async(_e,taskId,systemId,confirmation)=>{
    const tasks=await win.webContents.executeJavaScript('structuredClone(state.tasks)'),task=tasks.find(t=>t.id===taskId);
    const system=(await remoteSystems.list()).find(s=>s.id===systemId);
    const patch=require('../dist/core/login-route').loginRoutePatch(task,system,confirmation);loginRouteCalls++;
    const saved={...task,...patch};win.webContents.send('fixture:tasks-changed',tasks.map(t=>t.id===taskId?saved:t));return saved;
  });
  ipcMain.handle('fixture:remote-bind', async (_e, taskId, systemId) => {
    assert.equal(taskId, goalTask.id);
    const system = (await remoteSystems.list()).find(s=>s.id===systemId);
    assert.ok(preparedTargets.has(systemId));
    goalTask = {...goalTask,remote:{...system,preparedTarget:preparedTargets.get(systemId),resolvedCwd:preparedTargets.get(systemId).cwd}};
    return goalTask;
  });
  let authConnects = 0, authChecks = 0, authCancels = 0;
  ipcMain.handle('fixture:remote-task-connect', () => { authConnects++; return true; });
  ipcMain.handle('fixture:remote-task-ready', () => {
    if (++authChecks === 1) throw new Error('Fixture: authentication incomplete');
    return { agents: [], cwd: '/home/fixture/projects/test' };
  });
  ipcMain.handle('fixture:remote-task-cancel', () => { authCancels++; return true; });
  const finishing = new WritingRulesStore(join(__dirname, '..', 'assets', 'finishing-skills'), join(directory, 'finishing'));
  let legacyWritingResponse = false;
  ipcMain.handle('fixture:finishing-get', async (_e, section) => {
    const settings = await finishing.get(section);
    if (legacyWritingResponse) delete settings.section;
    return settings;
  });
  ipcMain.handle('fixture:finishing-save', (_e, revision, rules, section) => finishing.save(revision, rules, section));
  ipcMain.handle('fixture:presets-list', () => presets.catalog());
  ipcMain.handle('fixture:presets-save', (_e, id, revision, rules, goal) => presets.saveRules(id, revision, rules, goal));
  ipcMain.handle('fixture:presets-common-get', () => presets.getCommon());
  ipcMain.handle('fixture:presets-common-save', (_e, revision, rules) => presets.saveCommon(revision, rules));
  const hpcContext = { root: directory, taskId: 'layout-fixture', actor: 'gui-fixture', write: true, manage: true, user: true };
  ipcMain.handle('fixture:hpc', (_e, _id, request) => require('../dist/core/hpc').hpcOperation(hpcContext, request));
  ipcMain.handle('fixture:research',()=>({version:1,revision:1,protocol:{question:'Fixed comparison',maxExperiments:6,metrics:[]},candidates:[{id:'candidate-a',hypothesis:'<img src=x onerror=alert(1)>',limitation:'Bottleneck',novelty:'Provisional',falsifier:'No gain',sources:['Primary source']}],experiments:[],blockers:['全体評価が未完了です。']}));
  const win = new BrowserWindow({ show: false, width: 1200, height: 780, webPreferences: { preload: join(__dirname, 'layout-preload.cjs'), contextIsolation: true, sandbox: true } });
  const evaluate = win.webContents.executeJavaScript.bind(win.webContents);
  win.webContents.executeJavaScript = async (source, ...args) => {
    try { return await evaluate(source, ...args); }
    catch (error) { console.error('Failed GUI check:', source.slice(0, 1200)); throw error; }
  };
  ipcMain.handle('fixture:quality',()=>({domains:[{domain:'work',snapshot:{checks:[
    {id:'missing',stage:'coding',title:'不足データ <img src=x onerror=alert(1)>',guidance:'不足分を確認',required:true},
    {id:'passed',stage:'coding',title:'回帰検証済み',guidance:'維持する',required:true,result:{status:'pass',detail:'照合済み',at:'2026-09-20',files:{'tests.json':'hash'}}}
  ],blockers:[{id:'missing',reason:'未確認',owner:'worker'}]}},{domain:'report',snapshot:{checks:[],blockers:[]}}],external:[],reviewState:'未レビュー'}));
  let claudeFirstSnapshot = true, terminalNotificationFixture, terminalStartupFixture;
  ipcMain.handle('fixture:snapshot', (_e, id) => {
    if (id === 'run-1' && (terminalNotificationFixture || terminalStartupFixture)) return {...runner.snapshot(id),notificationIssue:terminalNotificationFixture,startupIssue:terminalStartupFixture};
    if (id.startsWith('run-auto-')) return {data:'Automatic follow fixture\r\n',offset:26,cols:100,rows:30,alive:true,awaitingHandoff:false};
    if (id === 'run-2' && claudeFirstSnapshot) {
      claudeFirstSnapshot = false;
      return {data:'',offset:0,cols:100,rows:30,alive:false,awaitingHandoff:false};
    }
    return runner.snapshot(id);
  });
  const pdfRequests = [];
  ipcMain.handle('fixture:pdf', (_e, task, round, document = 'report') => {
    pdfRequests.push({ task, round, document });
    assert.ok(['report', 'paper', 'poster'].includes(document));
    return new Uint8Array(readFileSync(join(__dirname, '..', 'output/pdf', document === 'report' ? 'pdf-smoke-test/report.pdf' : `${document}-template-smoke/main.pdf`)));
  });
  const terminalInputs = [];
  ipcMain.handle('fixture:input', (_e, id, data) => {
    if (id.startsWith('run-trust-')) terminalInputs.push({ id, data });
    return runner.write(id, data);
  });
  ipcMain.handle('fixture:resize', (_e, id, cols, rows) => runner.resize(id, cols, rows));
  ipcMain.handle('fixture:complete', (_e, id, value) => runner.complete(id, value));
  ipcMain.handle('fixture:close', (_e, id) => runner.cancel(id));
  let manualRecoveryReady=false;
  ipcMain.handle('fixture:cli-recovery', (_e, action, value) => {
    const id='manual-recovery-fixture';
    if(action==='start') {void runner.run(id,{command:'/bin/bash',args:['--noprofile','--norc','-i'],cwd:directory},()=>{});return {id,command:'codex',location:'復旧テスト'};}
    if(action==='snapshot')return runner.snapshot(id);
    if(action==='input')return runner.write(id,value);
    if(action==='resize')return runner.resize(id,value.cols,value.rows);
    if(action==='close')return runner.cancel(id);
    if(action==='inspect')return {stopped:true,needsManualConfirmation:false,detail:'旧CLIは終了しています。'};
    if(action==='ready'){assert.equal(value.verified,true);assert.equal(runner.snapshot(id).alive,false);manualRecoveryReady=true;return {ready:true,detail:'Ready · 手動確認済み'};}
    throw new Error('unknown recovery fixture action');
  });
  let goalTask;
  let allowedAgentSaves = 0;
  ipcMain.handle('fixture:allowed-agents', (_event, id, ids) => {
    if (process.argv.includes('--execution-resources')) {
      assert.equal(id, goalTask.id); assert.deepEqual(ids, ['codex', 'claude', 'antigravity']);
      allowedAgentSaves++; goalTask.allowedAgentIds = ids; return goalTask;
    }
    assert.equal(id, goalTask.id); assert.deepEqual(ids, allowedAgentSaves++ === 0 ? ['codex', 'claude', 'antigravity'] : ['codex', 'claude']);
    goalTask.allowedAgentIds = ids; return goalTask;
  });
  const restartedTasks = [];
  let rejectRestartOnce = false;
  ipcMain.handle('fixture:restart', async (_event, id, mode) => {
    assert.equal(id, goalTask.id);
    if (rejectRestartOnce) { rejectRestartOnce = false; throw new Error('Fixture: copy unavailable'); }
    const { restartedTask, copyRestartReport } = require('../dist/core/task-restart');
    const next = restartedTask(goalTask, mode, mode === 'carry' ? goalTask.cwd : join(directory, 'clean-workspace'));
    if (mode === 'carry') next.report = await copyRestartReport(goalTask.report, join(directory, next.id));
    restartedTasks.push(next); return next;
  });
  let resumedTaskId;
  ipcMain.handle('fixture:resume', (_event, id) => { resumedTaskId = id; return goalTask; });
  ipcMain.handle('fixture:execution', (_event, id, value, revision) => {
    assert.equal(id, goalTask.id);
    const {executionSettingsPatch}=require('../dist/core/execution-updates');
    Object.assign(goalTask,executionSettingsPatch(goalTask,value,['running','planning','reviewing','reporting'].includes(goalTask.state),revision));return goalTask;
  });
  let executionDefaultsSaved;
  ipcMain.handle('fixture:execution-defaults', (_event, value) => executionDefaultsSaved = validateExecution(value));
  let dispatchCreates=0;
  ipcMain.handle('fixture:create-goal', async (_e, input) => {
    dispatchCreates++;
    assert.equal(input.goalMode, 'manual');
    assert.equal(input.workflowMode, 'primary');
    const workPreset = input.presetId ? await presets.capture(input.presetId, input.presetRevision) : undefined;
    goalTask = { ...input, workPreset, execution: { ...defaultExecution }, id: 'goal-fixture', goal: initialGoal(input.prompt, workPreset), workUnits: createExecutionWorkflow(input), runs: [], state: 'awaiting-input', awaitingReason: 'goal', output: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    goalTask.reviewPolicy = 'adversarial-pair';
    goalTask.autonomy = {enabled:true,maxCycles:3,...(input.targetMinutes===undefined?{}:{targetMinutes:input.targetMinutes})};
    return goalTask;
  });
  ipcMain.handle('fixture:save-goal', (_e, id, value, revision, approve, autonomy) => {
    assert.equal(id, goalTask.id);
    goalTask = { ...goalTask, ...updateGoalContract(goalTask, value, revision, approve), autonomy: validateAutonomy(autonomy) };
    if (approve) goalTask.workUnits = pairUnits(orderAutonomousUnits(createExecutionWorkflow(goalTask)));
    return goalTask;
  });
  let goalRefinements = 0;
  let failAnswerRefinement = process.argv.includes('--goal-answers-only');
  ipcMain.handle('fixture:refine-goal', (_e, id, notes, revision) => {
    assert.equal(id, goalTask.id); assert.equal(goalTask.goal.status, 'draft');
    if (process.argv.includes('--goal-answers-only')) {
      assert.equal(revision, goalTask.goal.revision);
      assert.deepEqual(goalTask.goal.questionAnswers, [{ question: '評価環境は？', answer: 'Apple M5で予備評価（更新）' }, { question: '比較方法は？', answer: '複数の候補を同じ条件で比較' }]);
      if (failAnswerRefinement) { failAnswerRefinement = false; throw new Error('Fixture: AI connection unavailable'); }
      const { parseGoalProposal } = require('../dist/core/goals');
      const proposal = parseGoalProposal(`<goal-draft>${JSON.stringify({ ...goalTask.goal, questions: [], constraints: goalTask.goal.questionAnswers.map(item => item.answer) })}</goal-draft>`, goalTask.goal);
      goalTask = { ...goalTask, ...updateGoalContract(goalTask, proposal, revision, false) };
      goalRefinements++; return goalTask;
    }
    assert.equal(notes, '承認後もAIで整理'); assert.equal(revision, goalTask.goal.revision);
    goalRefinements++;
    goalTask = { ...goalTask, ...updateGoalContract(goalTask, { ...goalTask.goal, objective: 'AI再整理後のゴール' }, revision, false) };
    return goalTask;
  });
  const runs = ['run-1', 'run-2'].map(id => runner.run(id, { command: '/bin/bash', args: ['--noprofile', '--norc', '-i'], cwd: directory }, event => {
    if (!win.isDestroyed()) win.webContents.send('run:event', { taskId: 'layout-fixture', runId: id, type: event.stream, text: event.text, terminalOffset: event.offset });
  }));
  const errors = [];
  let detectionChecks=0, failDetection=false;
  ipcMain.handle('fixture:agents-detected',()=>{detectionChecks++;if(failDetection)throw new Error('CLIの状態確認に失敗しました');});
  let agyBlocked = true, agyStarts = 0, agyCloses = 0, agyInput = '', agyIssue;
  let agyUsageState='not-configured', agyRefreshes=0;
  let agySize;
  ipcMain.handle('fixture:agy-login-resize', (_e,id,cols,rows) => { assert.equal(id,'agy-login-fixture'); agySize={cols,rows}; });
  ipcMain.handle('fixture:agy-login-status', () => ({ installed: true, state: agyBlocked ? 'api-configured' : 'unverified', launchBlocked: agyBlocked,
    sessionId:agyStarts>agyCloses?'agy-login-fixture':undefined,
    authMethod: 'Googleアカウント', detail: agyBlocked ? 'APIキー方式のため起動しません。' : 'CLI検出済み。ログインはCLI画面で確認してください。',
    usageLink:{state:agyUsageState,detail:agyUsageState==='conflict'?'既存の表示設定は変更しません。':'残量を表示する初回設定です。'} }));
  ipcMain.handle('fixture:agy-login-start', () => { assert.equal(agyBlocked,false); agyStarts++; return 'agy-login-fixture'; });
  let holdAgySnapshot = false, releaseAgySnapshot;
  ipcMain.handle('fixture:agy-login-snapshot', async () => {
    const snapshot = {data:'Antigravity CLI fixture\r\n',offset:25,alive:true,issue:agyIssue};
    if (holdAgySnapshot) await new Promise(resolve => { releaseAgySnapshot = resolve; });
    return snapshot;
  });
  ipcMain.handle('fixture:agy-login-input', (_e,id,data) => { assert.equal(id,'agy-login-fixture'); agyInput += data; });
  ipcMain.handle('fixture:agy-login-close', (_e,id) => { assert.equal(id,'agy-login-fixture'); agyCloses++; });
  let agyInstalls=0;
  ipcMain.handle('fixture:agy-usage-install',()=>{ agyInstalls++; agyUsageState='enabled'; return '使用量表示を設定しました。'; });
  ipcMain.handle('fixture:agy-usage-refresh',()=>{agyRefreshes++;return [];});
  let savedModels, modelRequests = 0;
  let delayModelSave = false, releaseModelSave, modelSaveCalls = 0;
  let delayRoutingSave = false, releaseRoutingSave, routingSaved, routingSaveCalls = 0;
  ipcMain.handle('fixture:routing-save', async (_event, value) => {
    routingSaveCalls++; routingSaved = value;
    if (delayRoutingSave) await new Promise(resolve => { releaseRoutingSave = resolve; });
    return { settings: value, resources: [] };
  });
  ipcMain.handle('fixture:models-list', (_event, id) => {
    modelRequests++;
    if (modelRequests === 2) throw new Error('Fixture: catalog unavailable');
    return { models: [{id:`${id}-test`, label:`${id} Test`}], source:'cli', note:'Fixture CLI catalog' };
  });
  ipcMain.handle('fixture:models-save', async (_event, value, enabled) => {
    modelSaveCalls++;
    savedModels = value;
    const settings = await win.webContents.executeJavaScript('structuredClone(state.orchestrationSettings)');
    if (delayModelSave) await new Promise(resolve => { releaseModelSave = resolve; });
    return {settings:require('../dist/core/model-catalog').withModelDefaults(settings,value,enabled),resources:[]};
  });
  win.webContents.on('console-message', (event) => { if (event.level === 'error') { errors.push(event.message); console.error(event.message); } });
  try {
    await win.loadFile(join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await win.webContents.executeJavaScript(`window.addEventListener('error', event => console.error(event.error?.stack ?? event.message))`);
    // Initialization now loads preset files asynchronously; loadFile alone is
    // not the renderer-ready boundary.
    for (let i=0; i<100 && !await win.webContents.executeJavaScript(`document.querySelectorAll('.task-panel-tab').length > 0 && !!document.querySelector('#task-preset option[value="hpc-refactoring"]')`); i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#task-preset option[value="hpc-refactoring"]')?.textContent`), '大規模コード移行・GPU化モード');
    if (process.argv.includes('--task-delete-only')) {
      // Use isolated fixture records, never delete a user's task or artifacts.
      let deletions = 0;
      ipcMain.handle('fixture:delete-task', (_event, id) => {
        assert.equal(id, 'layout-fixture'); deletions++; return [];
      });
      await evaluate(`{
        const t=state.tasks[0];Object.assign(t,{state:'paused',goalPreparation:true,goal:${JSON.stringify(initialGoal('ゴール作成途中のタスク'))},runs:[],workUnits:[]});
        state.queue={running:false,stopping:false,activeTaskIds:[]};state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'overview');showView('tasks');renderTasks();renderDetail();
      }`);
      assert.equal(await evaluate(`[...document.querySelectorAll('.task-panel-tab')].some(b=>b.textContent==='目的・条件')`),false);
      const button = `document.querySelector('.task-header-top > .delete-task-button')`;
      assert.equal(await evaluate(`document.querySelectorAll('.delete-task-button').length`),1);
      assert.equal(await evaluate(`${button}.disabled`),false);
      for (const [width,height] of [[1200,780],[900,650]]) {
        win.setSize(width,height);
        await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        assert.ok(await evaluate(`(()=>{const b=${button},r=b.getBoundingClientRect(),h=b.parentElement.getBoundingClientRect();return b.checkVisibility()&&r.right<=h.right+1&&r.left>h.left+h.width/2&&Math.abs(r.top-h.top)<3&&r.bottom<window.innerHeight;})()`),'delete is visible at the top right, even without goal tabs');
      }
      for(const tab of ['overview','execution','history']) {
        await evaluate(`state.selectedTaskPanels.set(state.tasks[0].id,${JSON.stringify(tab)});renderDetail()`);
        assert.equal(await evaluate(`${button}.checkVisibility() && !${button}.disabled`),true);
      }
      await evaluate(`state.tasks[0].state='planning';renderDetail()`);
      assert.equal(await evaluate(`${button}.disabled`),true);
      await evaluate(`${button}.click()`);assert.equal(deletions,0);
      // A saved pause can precede actual shutdown: retain queue ownership guard.
      await evaluate(`state.tasks[0].state='paused';state.queue.activeTaskIds=[state.tasks[0].id];renderDetail()`);
      assert.equal(await evaluate(`${button}.disabled`),true);
      await evaluate(`state.queue.activeTaskIds=[];renderDetail();window.confirm=text=>{window.deleteConfirmation=text;return false;};${button}.click()`);
      assert.equal(deletions,0);
      assert.match(await evaluate(`window.deleteConfirmation`),/タスクの履歴は削除.*成果物・レポートのファイルは保持/s);
      assert.equal(await evaluate(`state.tasks.length`),1);
      await evaluate(`window.confirm=()=>true;${button}.click()`);
      for(let i=0;i<100&&!deletions;i++)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(deletions,1);
      for(let i=0;i<100&&await evaluate(`state.tasks.length`);i++)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(await evaluate(`state.tasks.length`),0);
      assert.match(await evaluate(`document.getElementById('toast').textContent`),/成果物ファイルは保持/);
      assert.deepEqual(errors,[]);console.log('Task deletion: top-right across draft/paused tabs and narrow windows, active ownership guard, cancel and confirmed record-only deletion verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--branding-only')) {
      assert.equal(await evaluate('document.title'), 'Scientelier');
      assert.equal(await evaluate("document.querySelector('.brand-name').textContent"), 'Scientelier');
      assert.equal(await evaluate("document.querySelector('.brand-mark').textContent"), 'Sc');
      assert.equal(await evaluate("document.querySelector('.brand-subtitle').textContent"), '複数AIによる研究開発');
      for (const [width,height] of [[1200,780],[980,620]]) {
        win.setSize(width,height);
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        assert.equal(await evaluate("(() => {const e=document.querySelector('.brand-name');return e.checkVisibility() && e.scrollWidth<=e.clientWidth})()"), true);
        mkdirSync(join(__dirname,'..','output','ui'),{recursive:true});
        writeFileSync(join(__dirname,'..','output','ui',`scientelier-brand-${width}.png`),(await win.webContents.capturePage()).toPNG());
      }
      assert.equal(errors.length,0,errors.join('\n'));
      console.log('Scientelier title, brand and compact layout verified with isolated fixture data.');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    if (process.argv.includes('--sidebar-quota-only')) {
      // Real saved observations, not model catalogs or estimated token budgets,
      // remain expanded even when refresh fails or their reset time has passed.
      const now=Date.now(), old=new Date(now-3600000).toISOString(), future=new Date(now+86400000).toISOString();
      const base={enabled:true,connected:true,cliInstalled:true,state:'available',limitSource:'reported-live',capacityUpdatedAt:old,
        totalTokens:0,inputTokens:0,outputTokens:0,runs:0,failures:0,authModes:['subscription'],models:[{id:'no-quota-model',label:'表示不要のモデル'}]};
      const resources=[{...base,providerKey:'openai',providerLabel:'OpenAI',agentIds:['codex'],capacityError:'Usage HTTP 401',windows:[
        {id:'week',label:'Weekly',windowMinutes:10080,scope:'shared',usedPercent:12,resetAt:future},
        {id:'spark',label:'Weekly',windowMinutes:10080,scope:'model',model:'gpt-spark-fixture',usedPercent:65,resetAt:future},
        {id:'short',label:'Short',windowMinutes:300,scope:'shared',usedPercent:0,resetAt:old}]},
        {...base,providerKey:'anthropic',providerLabel:'Anthropic',agentIds:['claude'],windows:[
          {id:'session',label:'Current session',scope:'shared',usedPercent:51,resetAt:future},
          {id:'all',label:'Current week (all)',scope:'shared',usedPercent:21,resetAt:future},
          {id:'fable',label:'Current week (Fable)',scope:'model',model:'Fable',usedPercent:33,resetAt:future},
          {id:'monthly',label:'Monthly',scope:'model',model:'claude-other-fixture',usedPercent:9,resetAt:future}]},
        {...base,providerKey:'google-antigravity',providerLabel:'Antigravity',agentIds:['antigravity'],capacityUpdatedAt:new Date(now).toISOString(),windows:[
          {id:'zero',label:'5 hours',windowMinutes:300,scope:'model',model:'gemini-fixture',usedPercent:0,resetAt:future}]}];
      await evaluate(`state.resources=${JSON.stringify(resources)};showView('tasks');renderResourceSummary()`);
      const before=await evaluate(`JSON.stringify(state.resources)`);
      assert.equal(await evaluate(`document.querySelectorAll('#resource-summary .sidebar-quota-window').length`),8);
      assert.equal(await evaluate(`[...document.querySelectorAll('#resource-summary .sidebar-quota-window')].every(e=>e.checkVisibility())`),true);
      const text=await evaluate(`document.getElementById('resource-summary').textContent`);
      for(const label of ['1週間','5時間','gpt-spark-fixture','Current session','Current week (all)','Current week (Fable)','claude-other-fixture','Monthly','65.0%','0.0%','前回値','前回のリセット予定'])assert.ok(text.includes(label),label);
      assert.ok(!text.includes('表示不要のモデル'),'unmetered catalog entries are not invented quota buckets');
      assert.equal(await evaluate(`document.querySelectorAll('#resource-summary details').length`),0,'quota details need no disclosure click');
      assert.equal(await evaluate(`{
        const probe=document.createElement('span');probe.style.backgroundColor='var(--green)';document.body.append(probe);
        const green=getComputedStyle(probe).backgroundColor;probe.remove();
        [...document.querySelectorAll('#resource-summary .resource-summary-meter span')].every(e=>getComputedStyle(e).backgroundColor===green);
      }`),true,'all quota bars stay green, including old observations and CLI status warnings');
      const sharedFirst=await evaluate(`[...document.querySelectorAll('#resource-summary .resource-summary-item:first-child .sidebar-quota-window')].map(e=>e.textContent)`);
      assert.ok(sharedFirst[0].startsWith('1週間'));assert.ok(sharedFirst[2].startsWith('gpt-spark-fixture'),'shared buckets precede model-specific buckets');
      for(const size of [[1200,780],[900,620]]) {
        win.setSize(...size);await new Promise(r=>setTimeout(r,80));
        assert.ok(await evaluate(`{const p=document.querySelector('.resource-sidebar');p.scrollWidth<=p.clientWidth+2}`),'quota list does not overflow horizontally');
        await evaluate(`document.querySelector('.resource-sidebar').scrollTop=0`);
        writeFileSync(join(__dirname,'..','output/pdf','sidebar-quota-'+size[0]+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      await evaluate(`document.querySelector('#resource-summary .resource-summary-item').click()`);
      assert.equal(await evaluate(`document.querySelector('#resource-usage-dialog').open`),true,'details shortcut is retained');
      assert.equal(await evaluate(`JSON.stringify(state.resources)`),before,'presentation never modifies quota or routing');
      assert.deepEqual(errors,[]);console.log('Expanded sidebar quota: all shared/model buckets, old and failed observations, resets, zero values and compact scrolling verified');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--ux-only')) {
      // Isolated UX fixture: never logs in, starts user work, or reads user data.
      const wait = async expression => {
        for (let i=0;i<100;i++) { if (await evaluate(expression)) return; await new Promise(r=>setTimeout(r,20)); }
        assert.fail(expression);
      };
      await evaluate(`{
        const t=state.tasks[0];Object.assign(t,{title:'作業状況の確認',roundNumber:1,autonomyCycle:1,workflowMode:'primary',runs:[],
          goal:{revision:1,status:'approved',objective:'複数の方法を比較し、根拠のある成果を作る。',deliverables:['成果と検証記録'],constraints:[],outOfScope:[],questions:[],criteria:[
            {id:'a',description:'実装の精度を確認する',verification:'独立検査',required:true},
            {id:'b',description:'最終PDFの内容を確認する',verification:'独立検査',required:true}]},
          workClosure:{round:1,cycle:1,goalRevision:1,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),reason:'探索を区切る',issues:['PDFの独立確認が未完了']},
          autonomy:{enabled:true,maxCycles:3,targetMinutes:30},executionMetrics:{elapsedMs:3600000,measuredAt:Date.now(),ticking:false,measuredRuns:1,totalRuns:1,peakParallel:2,parallelMs:600000,intervals:[],usage:{source:'reported',inputTokens:10000},
            models:[{agentId:'claude',model:'opus',measuredRuns:1,totalRuns:1,usage:{source:'reported',inputTokens:10000,outputTokens:1000}}]}});
        t.workUnits.forEach(u=>u.state='completed');state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'overview');showView('tasks');renderTasks();renderDetail();
      }`);
      for (const selector of ['.task-heading','.task-tab','.progress-summary']) assert.match(await evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`),/作業終了・残課題あり/);
      assert.match(await evaluate(`document.querySelector('.execution-metrics').textContent`),/目安 30分.*opus（版未取得）.*1.1万/);
      assert.match(await evaluate(`document.querySelector('.execution-tokens').title`),/11,000.*キャッシュ入力.*契約使用率や課金額ではありません/);
      for (const name of ['最終目的','できたこと','重要な残課題','次の一手','時間・並列の実績']) assert.ok(await evaluate(`document.querySelector('.task-progress-overview').textContent.includes(${JSON.stringify(name)})`),name);
      assert.equal(await evaluate(`document.querySelector('.task-settings-actions')`),null,'configuration is not repeated above every tab');
      const prepare=`[...document.querySelectorAll('.progress-next button')].find(b=>b.textContent==='残課題を追加指示へ')`;
      await evaluate(`${prepare}.click()`);
      assert.match(await evaluate(`document.querySelector('[aria-label="追加指示"]').value`),/承認済み.*合格条件.*最終PDF/s);
      assert.equal(resumedTaskId,undefined,'preparation never starts work');
      await evaluate(`{const input=document.querySelector('[aria-label="追加指示"]');input.value='未保存のユーザー指示';input.dispatchEvent(new Event('input'));${prepare}.click();}`);
      assert.equal(await evaluate(`document.querySelector('[aria-label="追加指示"]').value`),'未保存のユーザー指示');
      for (const size of [[1200,780],[1000,640]]) {
        win.setSize(...size);await new Promise(r=>setTimeout(r,80));
        assert.ok(await evaluate(`{const p=document.querySelector('.detail-header');p.scrollWidth<=p.clientWidth+2}`),'compact header does not overflow');
        assert.ok(await evaluate(`{const p=document.querySelector('.task-panel-content');p.scrollWidth<=p.clientWidth+2}`),'overview fits');
        writeFileSync(join(__dirname,'..','output/pdf','ux-overview-'+size[0]+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      await evaluate(`openTaskPanel(state.tasks[0],'goal')`);
      assert.match(await evaluate(`document.querySelector('.task-settings-actions').textContent`),/このタスクだけに適用.*実行戦略/s);
      assert.ok(await evaluate(`document.querySelector('[aria-label="このタスクの設定"]')`));
      await evaluate(`Object.assign(state.tasks[0],{state:'failed',error:'UNAUTHENTICATED (code 401)',resumeFromUnitId:'unit-1'});openTaskPanel(state.tasks[0],'overview');renderTasks()`);
      assert.match(await evaluate(`document.querySelector('.task-heading').textContent`),/対応が必要/);
      assert.equal(await evaluate(`document.querySelector('.task-stop-notice').open`),true,'cause and next action are shown without expanding');
      assert.match(await evaluate(`document.querySelector('.task-stop-notice').textContent`),/担当CLIの認証に失敗.*サービス.*再開/s);
      assert.equal(await evaluate(`document.querySelector('.decision-original').open`),false,'raw long detail remains optional');
      const now=new Date().toISOString();
      const local={providerKey:'openai',providerLabel:'OpenAI',agentIds:['codex'],enabled:true,connected:true,cliInstalled:true,state:'available',limitSource:'reported-live',capacityUpdatedAt:now,capacityError:'Usage HTTP 401',windows:[],models:[],totalTokens:0,inputTokens:0,outputTokens:0,runs:0,failures:0,authModes:['subscription'],login:{loggedIn:true,checkedAt:now,detail:'CLI認証済み'}};
      await evaluate(`state.resources=${JSON.stringify([local,{...local,providerKey:'openai@remote',environmentId:'remote',environmentLabel:'遠隔',connected:false}])};showView('usage');renderResourceSummary()`);
      assert.equal(await evaluate(`document.querySelectorAll('#resource-summary .resource-summary-item').length`),1,'only the selected environment is shown');
      assert.match(await evaluate(`document.querySelector('#resource-summary').textContent`),/利用可能.*取得失敗/s,'a usage API failure is not a CLI login failure');
      await evaluate(`serviceEnvironment='';renderResourceSummary()`);
      assert.equal(await evaluate(`document.querySelectorAll('#resource-summary .resource-summary-item').length`),2,'unknown account identities are not merged');
      await evaluate(`state.tasks[0].remote={id:'missing',name:'未接続の環境',host:'example',cwd:'/work'};showView('tasks')`);
      assert.match(await evaluate(`document.querySelector('#resource-summary').textContent`),/未接続の環境.*この環境の状態は未取得/s);
      await evaluate(`showView('usage');document.querySelector('.model-default-row[data-agent-id="codex"]').open=true`);
      assert.equal(await evaluate(`document.querySelectorAll('#save-model-defaults:not([hidden])').length`),0,'one visible save, not competing model and usage saves');
      delayRoutingSave=true;
      await evaluate(`{
        const input=document.querySelector('.model-default-row[data-agent-id="codex"] input[type=text]');input.value='codex-test';input.dispatchEvent(new Event('input',{bubbles:true}));
        const toggle=document.querySelector('[data-service-enabled="claude"]');toggle.checked=false;toggle.dispatchEvent(new Event('change'));
        const slider=document.querySelector('[data-service-usage="codex"] input[type=range]');slider.value='77';slider.dispatchEvent(new Event('input',{bubbles:true}));
        document.getElementById('orchestration-settings-form').requestSubmit();document.getElementById('model-default-form').requestSubmit();
      }`);
      for (let i=0;i<100&&!releaseRoutingSave;i++) await new Promise(r=>setTimeout(r,20));
      assert.equal(routingSaveCalls,1);assert.equal(modelSaveCalls,0);
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='codex').defaultModel,'codex-test');
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='codex').usageLimitPercent,77);
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='claude').enabled,false);
      await evaluate(`{
        const input=document.querySelector('.model-default-row[data-agent-id="codex"] input[type=text]');input.value='later-model';input.dispatchEvent(new Event('input',{bubbles:true}));
        const slider=document.querySelector('[data-service-usage="codex"] input[type=range]');slider.value='78';slider.dispatchEvent(new Event('input',{bubbles:true}));
      }`);
      assert.equal(typeof releaseRoutingSave,'function');releaseRoutingSave();delayRoutingSave=false;
      await wait(`!routingSettingsSaving`);
      assert.equal(await evaluate(`document.querySelector('.model-default-row[data-agent-id="codex"] input[type=text]').value`),'later-model','late model draft survives');
      assert.equal(await evaluate(`document.querySelector('[data-service-usage="codex"] .policy-limit').value`),'78','late usage draft survives');
      await evaluate(`document.getElementById('orchestration-settings-form').requestSubmit()`);await wait(`!routingSettingsSaving`);
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='codex').defaultModel,'later-model');
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='codex').usageLimitPercent,78);
      assert.deepEqual(errors,[]);console.log('Task UX: consistent status, safe recovery, summary, compact header, environment-scoped availability and atomic service save passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--parallel-review-only')) {
      const {createCrossReviews}=require('../dist/core/cross-review');
      const task=await evaluate('structuredClone(state.tasks[0])');
      Object.assign(task,{workflowMode:'primary',state:'paused',runs:[],execution:{...defaultExecution,reviewMode:'parallel',maxParallel:3},goal:{...initialGoal(task.prompt),status:'approved',questions:[]}});
      task.workUnits=createExecutionWorkflow(task).map(u=>({...u,state:u.role==='reviewer'?'pending':'completed'}));
      task.workUnits=createCrossReviews(task,['OpenAI','Anthropic','Ollama'],'parallel');
      await evaluate(`{const t=state.tasks[0];Object.assign(t,${JSON.stringify(task)});state.selectedTaskId=t.id;showView('tasks');renderTasks();openTaskPanel(t,'plan');}`);
      const view=await evaluate(`document.querySelector('.execution-plan-view').textContent`);
      for(const label of ['独立レビュー · OpenAI','独立レビュー · Anthropic','独立レビュー · Ollama','レビュー統合・根拠確認'])assert.ok(view.includes(label),label);
      const aggregate=task.workUnits.at(-1);
      await evaluate(`document.querySelector('[data-unit-id="${aggregate.id}"]').open=true`);
      assert.match(await evaluate(`document.querySelector('[data-unit-id="${aggregate.id}"]').textContent`),/全AIの独立判定.*少数意見/s);
      assert.match(await evaluate(`document.querySelector('[data-unit-id="${aggregate.id}"]').textContent`),/OpenAI.*Anthropic.*Ollama/s);
      win.setContentSize(1400,1100); win.show();
      await evaluate(`document.querySelector('[data-unit-id="${aggregate.id}"]').scrollIntoView({block:'end'})`);
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      writeFileSync(join(__dirname,'..','output/pdf/parallel-review-smoke.png'),(await win.webContents.capturePage()).toPNG());
      await evaluate(`document.getElementById('nav-settings').click();renderExecutionSettings();`);
      await evaluate(`{const select=document.querySelector('.execution-settings [aria-label="割り当て方針"]');select.value='throughput';select.dispatchEvent(new Event('change'));}`);
      assert.equal(await evaluate(`document.querySelector('.execution-settings [aria-label="レビュー方式"]').value`),'parallel');
      await evaluate(`document.querySelector('.execution-settings fieldset > button').click()`);
      for(let i=0;i<100&&!executionDefaultsSaved;i++)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(executionDefaultsSaved.reviewMode,'parallel');
      assert.deepEqual(errors,[]);console.log('Parallel independent review graph, one consolidator, source labels and saved policy verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--content-refinement-only')) {
      const { applyExecutionPlan, parseExecutionPlan } = require('../dist/core/execution-plan');
      const planned = await evaluate('structuredClone(state.tasks[0])');
      planned.goal = { ...initialGoal(planned.prompt), status:'approved', questions:[] };
      planned.workflowMode = 'primary'; planned.execution = { ...defaultExecution };
      planned.runs = []; planned.state = 'paused';
      planned.workUnits = createExecutionWorkflow({workflowMode:'primary'});
      const owner = planned.workUnits[0]; owner.state = 'completed';
      const packageFor = (key, title, dependsOn=[], kind) => ({key,title,dependsOn,...kind?{kind}:{},instructions:'承認範囲の改善',deliverable:'提案と根拠',acceptance:'既存条件で評価',criterionIds:planned.goal.criteria.map(c=>c.id),estimatedTokens:1000,estimatedMinutes:2});
      const plan = {summary:'別AIの改善提案を実作業へ戻す',reason:'現状の弱点を改善する',primaryWork:'比較結果を統合する',acceptance:'承認条件で評価',criterionIds:planned.goal.criteria.map(c=>c.id),estimatedTokens:8000,estimatedMinutes:20,escalation:'権限変更のみ確認',
        tasks:[packageFor('initial','初版の作成',[],'primary-work'),packageFor('alternative','代案を検討',['initial']),packageFor('challenge','弱点を検討',['initial']),packageFor('apply','改善を試して比較',['alternative','challenge'],'primary-work')],
        refinement:{objective:'同じ課題の解法を改善する <img src=x onerror=alert(1)>',proposalKeys:['alternative','challenge'],applicationKey:'apply',stopWhen:'有用な追加変更がない'},
        coordination:{criticalPath:'初版→代案・弱点→反映',parallelBenefit:'別の観点を同時検討',contextPlan:'固定初版と直接依存の根拠',resourcePlan:'利用可能なサービスへ分散'}};
      Object.assign(planned, applyExecutionPlan(planned, owner, parseExecutionPlan(`<execution-plan>${JSON.stringify(plan)}</execution-plan>`,planned,owner)));
      await evaluate(`{const t=state.tasks[0];Object.assign(t,${JSON.stringify(planned)});state.selectedTaskId=t.id;showView('tasks');renderTasks();openTaskPanel(t,'plan');}`);
      await evaluate(`document.querySelector('.execution-plan-strategy summary').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('.execution-plan-strategy ul li').length`),3);
      assert.match(await evaluate(`document.querySelector('.execution-plan-strategy').textContent`),/代案を検討.*弱点を検討.*改善を試して比較/);
      assert.equal(await evaluate(`document.querySelectorAll('.execution-plan-strategy img').length`),0);
      assert.ok(await evaluate(`document.querySelector('.execution-plan-view').textContent.includes('初版の作成')`));
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      writeFileSync(join(__dirname,'..','output/pdf/content-refinement-smoke.png'),(await win.webContents.capturePage()).toPNG());
      assert.equal(errors.length,0,errors.join('\n'));
      console.log('Content refinement strategy, bound graph and safe Japanese list rendering verified.');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    if(process.argv.includes('--login-route-only')) {
      const old={id:'route-source',name:'sx40',host:'192.0.2.1',username:'old-gateway-user',cwd:'base',nodeCommand:'node',pythonCommand:'python3',startup:'',instructions:'Original rules',texCommand:'latexmk',connectionMode:'prepared',codexPermissions:'sandbox'};
      const next={...old,id:'route-destination',name:'5060ti',host:'192.0.2.2',username:'new-gateway-user',cwd:'new-default',nodeCommand:'new-default-node',codexPermissions:'full-access'};
      await remoteSystems.save(old);await remoteSystems.save(next);
      await evaluate(`{const t=state.tasks[0];t.state='paused';t.runs=t.runs.map(r=>({...r,state:'cancelled',terminationUnconfirmed:true,remoteSession:{token:'original',controlDirectory:'/original',detached:true}}));
        t.remote={...${JSON.stringify(old)},resolvedCwd:'/home/user/project',preparedTarget:{hostname:'original-final-node',username:'user',home:'/home/user',cwd:'/home/user/project',nodeExecutable:'/opt/node'}};t.updatedAt='2026-10-01T00:00:00Z';
        window.routeBefore=JSON.stringify(t);remoteSystemsList=${JSON.stringify([old,next])};renderRemoteChoices();state.selectedTaskId=t.id;showView('tasks');renderTasks();renderDetail();}`);
      await evaluate(`[...document.querySelectorAll('.task-environment-details button')].find(b=>b.textContent==='最初のログイン先を変更…').click()`);
      assert.equal(await evaluate(`document.querySelector('.login-route-dialog').open`),true);
      assert.match(await evaluate(`document.querySelector('.login-route-dialog').textContent`),/original-final-node.*project/);
      await evaluate(`document.querySelector('.login-route-dialog select').value='route-destination';document.querySelector('.login-route-dialog select').dispatchEvent(new Event('change'));[...document.querySelectorAll('.login-route-dialog button')].find(b=>b.textContent==='閉じる').click()`);
      assert.equal(loginRouteCalls,0,'closing a selection does not apply it');
      await evaluate(`[...document.querySelectorAll('.task-environment-details button')].find(b=>b.textContent==='最初のログイン先を変更…').click();document.querySelector('.login-route-dialog select').value='route-destination';document.querySelector('.login-route-dialog select').dispatchEvent(new Event('change'));[...document.querySelectorAll('.login-route-dialog button')].find(b=>b.textContent==='ログイン先だけを変更').click()`);
      for(let i=0;i<100&&loginRouteCalls===0;i++)await new Promise(resolve=>setTimeout(resolve,30));
      for(let i=0;i<100&&!await evaluate('state.tasks[0].remote.id==="route-destination"');i++)await new Promise(resolve=>setTimeout(resolve,30));
      assert.equal(loginRouteCalls,1);
      assert.equal(await evaluate(`(()=>{const before=JSON.parse(window.routeBefore),after=state.tasks[0];return ['cwd','runs','workUnits','goal','report','state'].every(k=>JSON.stringify(before[k])===JSON.stringify(after[k]))&&JSON.stringify(before.remote.preparedTarget)===JSON.stringify(after.remote.preparedTarget)&&before.remote.codexPermissions===after.remote.codexPermissions&&before.remote.nodeCommand===after.remote.nodeCommand;})()`),true);
      assert.match(await evaluate(`document.querySelector('.task-environment-details').textContent`),/5060ti/);
      assert.match(await evaluate(`document.querySelector('#resource-summary').textContent`),/5060ti/,'quota context follows the selected task gateway');
      assert.deepEqual(errors,[]);console.log('First-hop selection GUI preserves the final host/folder, permissions, unfinished-process fences and history without connecting or starting work.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--remote-address-only')) {
      const profile={id:'address-fixture',name:'IP変更テスト',host:'192.0.2.1',username:'login-user',cwd:'base',nodeCommand:'node',pythonCommand:'python3',
        startup:'',instructions:'Original batch rules',texCommand:'latexmk',connectionMode:'prepared',codexPermissions:'sandbox'};
      await remoteSystems.save(profile);
      await evaluate(`{const t=state.tasks[0];t.state='paused';t.runs=t.runs.map(run=>({...run,state:'cancelled',terminationUnconfirmed:true,remoteSession:{token:'old-token',controlDirectory:'/original',detached:true}}));
        t.remote={...${JSON.stringify(profile)},resolvedCwd:'/home/user/project',preparedTarget:{hostname:'same-node',username:'user',home:'/home/user',cwd:'/home/user/project',nodeExecutable:'/opt/node'}};
        t.workUnits=t.workUnits.map(unit=>({...unit,state:'blocked',launchBlocked:true}));
        window.addressBefore=JSON.stringify({cwd:t.cwd,runs:t.runs,units:t.workUnits,report:t.report});
        remoteSystemsList=[${JSON.stringify(profile)}];renderRemoteChoices();document.getElementById('remote-select').value=${JSON.stringify(profile.id)};document.getElementById('remote-select').dispatchEvent(new Event('change'));
        showView('settings');selectSettingsPage('settings-remote');window.addressQuestions=[];
        window.confirm=message=>{window.addressQuestions.push(message);return false;};void 0;}`);
      assert.equal(await evaluate(`document.getElementById('remote-update-task-address').checked`),true);
      assert.equal(await evaluate(`document.getElementById('remote-update-address-label').hidden`),false);
      const waitForAddress = async test => {
        for(let i=0;i<100;i++){if(await test())return;await new Promise(resolve=>setTimeout(resolve,30));}
        assert.fail('Address UI did not settle');
      };
      await evaluate(`document.getElementById('remote-host').value='192.0.2.2';document.getElementById('remote-form').requestSubmit()`);
      await waitForAddress(()=>evaluate('window.addressQuestions.length===1'));
      assert.equal(remoteAddressSaves.length,0,'cancel does not save a profile or edit tasks');
      assert.equal((await remoteSystems.list())[0].host,profile.host);
      await evaluate(`window.confirm=message=>{window.addressQuestions.push(message);return true;};document.getElementById('remote-form').requestSubmit()`);
      await waitForAddress(()=>evaluate(`document.getElementById('remote-status').textContent.includes('接続アドレスだけを更新')`));
      assert.equal(remoteAddressSaves.length,1);
      assert.deepEqual(remoteAddressSaves[0].addressUpdate,{expectedHost:profile.host,confirmed:true});
      assert.equal(await evaluate('state.tasks[0].remote.host'),'192.0.2.2');
      assert.equal(await evaluate(`JSON.stringify({cwd:state.tasks[0].cwd,runs:state.tasks[0].runs,units:state.tasks[0].workUnits,report:state.tasks[0].report})===window.addressBefore`),true);
      assert.match(await evaluate('window.addressQuestions[0]'),/既存タスク1件/);
      assert.match(await evaluate(`document.getElementById('remote-status').textContent`),/自動再開しません/);
      assert.equal(await evaluate(`(()=>{const e=document.getElementById('remote-update-task-address');return e.getBoundingClientRect().width<25})()`),true);
      assert.deepEqual(errors,[]);
      console.log('Remote IP UI: cancelled consent is inert; exact address-only reflection, preserved task history and explicit reconnection guidance verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--workspace-trust-only')) {
      // Real browser xterm -> IPC -> owned PTY, with no provider, credentials
      // or user task. Color queries match Antigravity's observed handshake.
      const { isTerminalDeviceReply } = require('../dist/core/terminal-runner');
      const waitForFixture = async test => {
        for (let i = 0; i < 200; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 30)); }
        assert.fail('Workspace trust fixture did not reach the expected state');
      };
      for (const agent of ['antigravity', 'claude']) {
        const id = `run-trust-${agent}`, startFile = join(directory, `${id}-start`);
        const dialog = `\x1b[2J\x1b[HAccessing workspace:\r\n\r\n${directory}\r\n\r\n${agent === 'claude'
          ? "Quick safety check: Is this a project you created or one you trust?\r\nClaude Code'll be able to read, edit, and execute files here.\r\nNo, exit\r\n❯ Yes, I trust this folder\r\nEnter to confirm · Esc to cancel"
          : 'Do you trust the contents of this project?\r\nAntigravity CLI requires permission to read, edit, and execute files here.\r\n> Yes, I trust this folder\r\nNo, exit\r\n↑/↓ Navigate · enter Confirm\r\naccept-edits · Gemini 3.8 Flash · high'}`;
        const fixture = `const fs=require('node:fs');let started=false,working=false;process.stdin.setRawMode(true);process.stdin.resume();
          const render=()=>process.stdout.write(${JSON.stringify(dialog)});
          setInterval(()=>{if(!started&&fs.existsSync(${JSON.stringify(startFile)})){started=true;
            process.stdout.write('\\x1b[c\\x1b[>c\\x1b]10;?\\x1b\\\\\\x1b]11;?\\x1b\\\\');render();}},20);
          process.stdout.on('resize',()=>{if(started&&!working)render();});
          process.stdin.on('data',d=>{if(d.toString()==='\\r'){working=true;process.stdout.write('\\x1b[2J\\x1b[HFIXTURE_WORK_STARTED\\r\\n? for shortcuts');}});`;
        let output = '';
        const result = runner.run(id, {command:'/usr/bin/env',args:['ELECTRON_RUN_AS_NODE=1',process.execPath,'-e',fixture],cwd:directory}, event => {
          output += event.text;
          if (!win.isDestroyed()) win.webContents.send('run:event', {taskId:'layout-fixture',runId:id,agentId:agent,type:event.stream,text:event.text,terminalOffset:event.offset});
        }, {path:join(directory,`${id}-handoff.json`),token:id,agentId:agent,workspaceTrust:{agent,directory}});
        runs.push(result);
        await evaluate(`{const t=state.tasks[0];t.runs=[{id:${JSON.stringify(id)},workUnitId:'unit-0',role:'planner',agentId:${JSON.stringify(agent)},state:'running',terminal:true,output:'',startedAt:new Date().toISOString()}];
          t.state='running';state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'execution');state.selectedTerminalAgents.set(t.id,${JSON.stringify(agent)});showView('tasks');renderTasks();renderDetail();}`);
        await evaluate(`syncTerminal(terminalViews.get(${JSON.stringify(id)}))`);
        writeFileSync(startFile, 'fixture only');
        await waitForFixture(() => output.includes('FIXTURE_WORK_STARTED')).catch(error => {
          console.error('Trust fixture:', JSON.stringify({agent,output,inputs:terminalInputs.filter(input=>input.id===id),snapshot:runner.snapshot(id)}));
          throw error;
        });
        const inputs = terminalInputs.filter(input => input.id === id).map(input => input.data);
        assert.ok(inputs.some(s => /^\x1b\]10;rgb:/.test(s)), 'real xterm foreground response crossed IPC');
        assert.ok(inputs.some(s => /^\x1b\]11;rgb:/.test(s)), 'real xterm background response crossed IPC');
        assert.ok(inputs.every(isTerminalDeviceReply), 'fixture never supplied human consent');
        assert.equal(output.match(/起動フォルダの信頼確認を自動承認/g)?.length, 1);
        assert.equal(runner.snapshot(id).awaitingHandoff, true, 'folder trust is not work completion');
        await waitForFixture(() => evaluate(`(()=>{const b=terminalViews.get(${JSON.stringify(id)}).term.buffer.active;
          return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString()).some(line=>line.includes('FIXTURE_WORK_STARTED'));})()`));
        assert.equal(await evaluate(`terminalViews.get(${JSON.stringify(id)}).notice.hidden`), true);
        runner.cancel(id); await result;
      }
      assert.deepEqual(errors, []);
      console.log('Real xterm color/device replies preserve exact-folder auto-approval for Antigravity and Claude; work and final handoff remain separate.');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    if (process.argv.includes('--notification-repair-only')) {
      terminalNotificationFixture='完了通知は未受理です。作業結果と完了通知が混同されています。提出形式の自動修正を依頼しました（1/2）。';
      await evaluate(`{
        const t=state.tasks[0];t.state='running';
        workflowCollapsed.add(t.id);
        state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'execution');state.selectedTerminalAgents.set(t.id,'codex');
        showView('tasks');renderTasks();renderDetail();
      }`);
      await evaluate(`syncTerminal(terminalViews.get('run-1'))`);
      assert.equal(await evaluate(`document.querySelector('.terminal-notification-issue').hidden`),false);
      assert.equal(await evaluate(`document.querySelector('.terminal-notification-issue').textContent`),terminalNotificationFixture);
      await evaluate(`renderDetail()`);
      assert.equal(await evaluate(`document.querySelectorAll('.terminal-notification-issue').length`),1);
      assert.equal(await evaluate(`document.querySelector('.terminal-notification-issue').hidden`),false);
      const event={taskId:'layout-fixture',runId:'run-1',agentId:'codex',type:'status',text:'Terminal notification: 通知を確認してください。 <img src=x onerror=alert(1)>'};
      await evaluate(`appendRunEvent(${JSON.stringify(event)})`);
      assert.match(await evaluate(`document.querySelector('.terminal-notification-issue').textContent`),/<img/);
      assert.equal(await evaluate(`document.querySelector('.terminal-notification-issue img')`),null);
      await evaluate(`appendRunEvent(${JSON.stringify({...event,text:'Terminal notification: '+terminalNotificationFixture})})`);
      win.setSize(1000,780);
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await evaluate(`(()=>{const e=document.querySelector('.terminal-notification-issue');return e.scrollWidth<=e.clientWidth+1})()`),true);
      assert.equal(await evaluate(`(()=>{const e=document.querySelector('.terminal-notification-issue');return e.getBoundingClientRect().bottom<=e.parentElement.getBoundingClientRect().bottom})()`),true);
      mkdirSync(join(__dirname,'..','output','pdf'),{recursive:true});
      writeFileSync(join(__dirname,'..','output','pdf','notification-repair-ui-smoke.png'),(await win.webContents.capturePage()).toPNG());
      const smallHeight=await evaluate(`document.querySelector('.interactive-terminal').getBoundingClientRect().height`);
      assert.ok(smallHeight>0,`Terminal was collapsed: ${smallHeight}`);
      win.setSize(1000,1080);
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await evaluate(`document.querySelector('.interactive-terminal').getBoundingClientRect().height>${smallHeight}`),true);
      // An initial folder prompt must be actionable in the original CLI, not
      // buried in JSON logs or mistaken for a completed assignment.
      terminalStartupFixture='起動フォルダを確認し、このCLI端末で回答してください。';
      await evaluate(`syncTerminal(terminalViews.get('run-1'))`);
      assert.equal(await evaluate(`document.querySelector('.terminal-notification-issue').textContent`),terminalStartupFixture);
      assert.equal(await evaluate(`document.querySelector('.terminal-notification-issue').dataset.kind`),'startup');
      await evaluate(`appendRunEvent(${JSON.stringify({...event,text:'Terminal startup: フォルダを確認してください。 <img src=x onerror=alert(1)>'})})`);
      assert.equal(await evaluate(`document.querySelector('.terminal-notification-issue').hidden`),false);
      assert.equal(await evaluate(`document.querySelector('.terminal-notification-issue img')`),null);
      assert.equal(await evaluate(`terminalViews.get('run-1').inputAllowed`),true);
      await evaluate(`appendRunEvent(${JSON.stringify({...event,text:'Terminal retiring: 担当の終了を確認しています。'})})`);
      assert.equal(await evaluate(`document.querySelector('.terminal-notification-issue').hidden`),true);
      assert.equal(errors.length,0,errors.join('\n'));
      console.log('Completion/startup notices, snapshot/event updates, redraw persistence, manual input availability, safe text and retirement clearing verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--execution-metrics-only')) {
      const sample = {elapsedMs:61000,measuredAt:0,ticking:false,measuredRuns:1,totalRuns:2,usage:{source:'reported',inputTokens:100,outputTokens:20},models:[
        {agentId:'codex',model:'model-a',measuredRuns:1,totalRuns:1,usage:{source:'reported',inputTokens:100,outputTokens:20}},
        {agentId:'claude',model:'model-b',measuredRuns:0,totalRuns:1,usage:{source:'unknown'}}]};
      await win.webContents.executeJavaScript(`state.tasks[0].executionMetrics=${JSON.stringify(sample)};state.selectedTaskId=state.tasks[0].id;state.selectedTaskPanels.set(state.tasks[0].id,'overview');renderDetail();showView('tasks')`);
      assert.equal(await evaluate(`document.querySelectorAll('.detail-header .execution-metrics').length`),1);
      assert.match(await evaluate(`document.querySelector('.execution-metrics').textContent`),/経過時間 0:01:01/);
      assert.match(await evaluate(`document.querySelector('.execution-metrics').textContent`),/model-a120 tokens/);
      assert.match(await evaluate(`document.querySelector('.execution-metrics').textContent`),/model-bトークン未取得/);
      assert.equal(await evaluate(`document.querySelector('.task-title-line > h2') !== null && document.querySelector('.task-title-line > .execution-metrics') !== null`),true);
      assert.match(await evaluate(`document.querySelector('.task-environment-details').textContent`),/作業場所/);
      assert.equal(await evaluate(`document.querySelector('.task-environment-details h3')`),null);
      await evaluate(`state.tasks[0].executionMetrics.models[0].usage.inputTokens=200;state.selectedTaskPanels.set(state.tasks[0].id,'execution');renderDetail()`);
      assert.equal(await evaluate(`document.querySelectorAll('.execution-metrics').length`),1);
      assert.match(await evaluate(`document.querySelector('.detail-header .execution-metrics').textContent`),/220 tokens/);
      win.setSize(900,800);
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await evaluate(`(()=>{const e=document.querySelector('.execution-metrics');return e.scrollWidth<=e.clientWidth+1})()`),true);
      assert.equal(errors.length,0,errors.join('\n'));
      console.log('Header metrics, per-model usage, receipt refresh, tab persistence and compact layout verified.');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    if (process.argv.includes('--environment-blocker-only')) {
      await evaluate(`{
        const t=state.tasks[0];
        t.state='blocked';t.remote=undefined;t.report=undefined;t.localCodexPermissions='sandbox';
        t.goal={...t.goal,status:'approved',revision:1};t.roundNumber=1;t.autonomyCycle=1;t.workClosure=undefined;
        t.error='必須のMetalデバイスを取得できません。';t.resumeFromUnitId='gpu';
        t.workUnits=[{id:'gpu',title:'GPU実測',role:'worker',mode:'write',state:'blocked',dependsOn:[],attemptedAgentIds:[],instructions:'確認'}];
        t.executionBlocker={kind:'hardware',summary:t.error,recovery:'上の作業場所・実行設定で権限を確認し、「中断した工程から再開」を押してください。',
          check:'MTLCreateSystemDefaultDevice() == nil',unitId:'gpu',round:1,cycle:1,goalRevision:1,at:new Date().toISOString()};
        state.queue={running:false,stopping:false,activeTaskIds:[]};state.selectedTaskId=t.id;
        showView('tasks');renderTasks();renderDetail();
      }`);
      assert.equal(await evaluate(`document.querySelector('.task-stop-notice').open`),true);
      assert.match(await evaluate(`document.querySelector('.task-stop-notice').textContent`),/必須のMetalデバイス/);
      assert.match(await evaluate(`document.querySelector('.task-stop-notice').textContent`),/作業場所・実行設定/);
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('.task-actions button')).some(b=>b.textContent==='中断した工程から再開'&&!b.disabled)`),true);
      assert.doesNotMatch(await evaluate(`document.querySelector('.task-stop-notice').textContent`),/追加指示で復旧内容/);
      win.setSize(1000,700);
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await evaluate(`(()=>{const e=document.querySelector('.task-stop-notice');return e.scrollWidth<=e.clientWidth+1})()`),true);
      const shot=await win.webContents.capturePage();writeFileSync(join(__dirname,'../output/pdf/environment-blocker-ui-smoke.png'),shot.toPNG());
      assert.equal(errors.length,0,errors.join('\n'));
      console.log('Environment stop reason, recovery instructions and same-step resume are visible.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--interrupted-continue-only')) {
      const {interruptedFollowupPatch,interruptedFollowupUnit,captureRound}=require('../dist/core/iterations');
      const {executionMetrics}=require('../dist/core/execution-metrics');
      goalTask=await evaluate(`structuredClone(state.tasks[0])`);
      const now=Date.now();
      Object.assign(goalTask,{state:'awaiting-input',awaitingReason:'result',autonomyState:'needs-input',roundNumber:1,instruction:'既存成果を完成させる',
        goal:{...initialGoal('完成させる'),status:'approved',questions:[]},error:'ユーザ確認が必要です。Git作者を指定してください。',report:undefined,remote:undefined});
      goalTask.workUnits=['plan','work','report'].map((id,i)=>({id,role:i===0?'planner':i===1?'worker':'reporter',title:['保存済み計画','実装の続き','仕上げ'][i],
        mode:'write',instructions:'現在の成果を使う',state:i<2?'completed':'pending',dependsOn:i?[['plan','work'][i-1]]:[],attemptedAgentIds:[],
        completedAt:i<2?new Date(now-60000).toISOString():undefined,
        ...(i===1?{primary:true,delegationHandled:true,checkpointHandled:true,output:'<work-check>{"status":"ask-user","summary":"Git作者を指定してください。","remainingWork":"コミットして仕上げる","estimatedRemainingMinutes":5,"evidence":[]}</work-check>'}:{})}));
      goalTask.runs=[{id:'saved-attempt',workUnitId:'work',role:'worker',agentId:'codex',providerKey:'openai',state:'completed',output:'既存の成果',
        startedAt:new Date(now-120000).toISOString(),completedAt:new Date(now-60000).toISOString()}];
      goalTask.history=[captureRound(goalTask)];goalTask.continuationUnitId=interruptedFollowupUnit(goalTask).id;
      goalTask.executionMetrics=executionMetrics(goalTask);goalTask.workflowMetrics=executionMetrics(goalTask,now,'task');
      const ids=goalTask.workUnits.map(u=>u.id),oldRuns=structuredClone(goalTask.runs);let submissions=0;
      ipcMain.handle('fixture:followup',(_e,id,input,start)=>{
        assert.equal(id,goalTask.id);assert.equal(start,true);submissions++;
        const patch=interruptedFollowupPatch(goalTask,input);assert.ok(patch);
        goalTask={...goalTask,...patch,state:'paused',continuationUnitId:undefined};
        return goalTask;
      });
      await evaluate(`state.tasks=[${JSON.stringify(goalTask)}];state.selectedTaskId=state.tasks[0].id;state.queue={running:false,stopping:false,activeTaskIds:[]};openTaskPanel(state.tasks[0],'overview');renderTasks()`);
      assert.equal(await evaluate(`document.querySelector('.followup-composer option[value=continue]').textContent`),'停止した工程の続きを実行');
      assert.equal(await evaluate(`document.querySelector('.followup-composer button[type=submit]').textContent`),'回答して続行');
      await evaluate(`{const t=document.querySelector('.followup-composer textarea');t.value='指定済みのGit作者を使用してください';t.dispatchEvent(new Event('input'));document.querySelector('.followup-composer button[type=submit]').click();}`);
      for(let i=0;i<100&&!submissions;i++)await new Promise(r=>setTimeout(r,20));
      assert.equal(submissions,1);assert.equal(goalTask.roundNumber,1);assert.equal(goalTask.resumeCount,1);
      assert.deepEqual(goalTask.workUnits.map(u=>u.id),ids);assert.deepEqual(goalTask.runs,oldRuns);
      assert.equal(goalTask.instruction,'既存成果を完成させる');assert.equal(goalTask.resumeInstructions[0].instruction,'指定済みのGit作者を使用してください');
      for(let i=0;i<100&&!await evaluate(`!!document.querySelector('.workflow-node')`);i++)await new Promise(r=>setTimeout(r,20));
      assert.equal(await evaluate(`document.querySelectorAll('.workflow-node').length`),3);
      assert.equal(await evaluate(`document.querySelectorAll('.workflow-graph-canvas path').length`),2);
      await evaluate(`openTaskPanel(state.tasks[0],'history')`);
      assert.match(await evaluate(`document.querySelector('.round-history').textContent`),/途中再開時の回答・指示（1件）/);
      assert.match(await evaluate(`document.querySelector('.round-history').textContent`),/指定済みのGit作者/);
      assert.deepEqual(errors,[]);console.log('Interrupted answer resumes the same plan; graph, attempts, instruction and auditable reply retained.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--continue-ui-only')) {
      const {validateFollowup,captureRound,nextRoundPatch}=require('../dist/core/iterations');
      goalTask = await evaluate(`structuredClone(state.tasks[0])`);
      Object.assign(goalTask,{id:'continue-fixture',state:'paused',remote:undefined,report:undefined,error:undefined,awaitingReason:undefined,
        goal:{...initialGoal('同じ目的で作業を続ける'),status:'approved',questions:[]},runs:[],workUnits:[],history:[],roundNumber:1});
      let submissions=0;
      ipcMain.handle('fixture:followup',(_e,id,input,start)=>{
        assert.equal(id,goalTask.id);assert.equal(start,true);submissions++;
        const checked=validateFollowup(input,goalTask);
        goalTask.history.push(captureRound(goalTask));
        goalTask={...goalTask,...nextRoundPatch(goalTask,checked)};
        return goalTask;
      });
      await evaluate(`state.tasks=[${JSON.stringify(goalTask)}];state.selectedTaskId='continue-fixture';state.queue={running:false,stopping:false,activeTaskIds:[]};showView('tasks');renderTasks();renderDetail()`);
      const choose = value => evaluate(`{const s=document.querySelector('.followup-composer [aria-label="進め方"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change'));}`);
      assert.equal(await evaluate(`document.querySelector('.followup-composer [aria-label="進め方"]').value`),'continue');
      assert.equal(await evaluate(`document.querySelector('.followup-composer button[type=submit]').textContent`),'続ける');
      assert.equal(await evaluate(`[...document.querySelectorAll('.task-actions button')].some(b=>/やり直す|別タスクに分ける/.test(b.textContent))`),false);
      mkdirSync(join(__dirname,'..','output','pdf'),{recursive:true});
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      writeFileSync(join(__dirname,'..','output','pdf','continue-ui-smoke.png'),(await win.webContents.capturePage()).toPNG());
      await evaluate(`{const t=document.querySelector('.followup-composer textarea');t.value='GPU実機検証から続けてください';t.dispatchEvent(new Event('input'));}`);
      for(const mode of ['fresh','carry']) {
        await choose(mode);
        assert.equal(await evaluate(`document.querySelector('.restart-dialog').open`),true);
        assert.match(await evaluate(`document.querySelector('.restart-dialog').textContent`),/作成だけでは実行しません/);
        assert.match(await evaluate(`document.querySelector('.restart-dialog').textContent`),/入力中の追加指示は元のタスクに保持/);
        await evaluate(`document.querySelector('.restart-dialog').close()`);
        assert.equal(restartedTasks.length,0);assert.equal(submissions,0);
        assert.equal(await evaluate(`document.querySelector('.followup-composer textarea').value`),'GPU実機検証から続けてください');
        assert.equal(await evaluate(`document.querySelector('.followup-composer [aria-label="進め方"]').value`),'continue');
      }
      // A failed copy keeps both the confirmation and the same draft.
      rejectRestartOnce=true;await choose('carry');
      await evaluate(`document.querySelector('.restart-dialog .primary-button').click()`);
      for(let i=0;i<100&&!await evaluate(`document.querySelector('.restart-dialog [role=alert]').textContent`);i++)await new Promise(r=>setTimeout(r,20));
      assert.match(await evaluate(`document.querySelector('.restart-dialog [role=alert]').textContent`),/copy unavailable/);
      await evaluate(`document.querySelector('.restart-dialog').close()`);
      await evaluate(`document.querySelector('.followup-composer button[type=submit]').click()`);
      for(let i=0;i<100&&!submissions;i++)await new Promise(r=>setTimeout(r,20));
      assert.equal(submissions,1);assert.equal(goalTask.id,'continue-fixture');assert.equal(goalTask.roundNumber,2);
      assert.equal(goalTask.instruction,'GPU実機検証から続けてください');assert.equal(goalTask.history.length,1);
      // New-task paths still require confirmation, reset run history, and do not run.
      goalTask.state='paused';
      for(const mode of ['fresh','carry']) {
        await evaluate(`state.tasks=[${JSON.stringify(goalTask)}];state.selectedTaskId='continue-fixture';renderTasks();renderDetail()`);
        await choose(mode);
        await evaluate(`{const b=document.querySelector('.restart-dialog .primary-button');b.click();b.click();}`);
        for(let i=0;i<100&&await evaluate(`!!document.querySelector('.restart-dialog')`);i++)await new Promise(r=>setTimeout(r,20));
        assert.equal(restartedTasks.length,mode==='fresh'?1:2);
        const next=restartedTasks.at(-1);assert.notEqual(next.id,goalTask.id);assert.deepEqual(next.goal,goalTask.goal);assert.deepEqual(next.runs,[]);
        assert.equal(next.state,'queued');assert.equal(submissions,1);
        assert.equal(mode==='carry'?next.cwd===goalTask.cwd:next.cwd!==goalTask.cwd,true);
      }
      // The browser disables unsupported remote reset and branching during work.
      await evaluate(`state.tasks=[${JSON.stringify(goalTask)}];state.selectedTaskId='continue-fixture';state.tasks[0].remote={id:'r',name:'R',host:'r',cwd:'/work'};renderDetail()`);
      assert.equal(await evaluate(`document.querySelector('.followup-composer option[value=fresh]').disabled`),true);
      await evaluate(`delete state.tasks[0].remote;state.tasks[0].state='running';renderDetail()`);
      assert.equal(await evaluate(`document.querySelector('.followup-composer option[value=carry]').disabled`),true);
      assert.equal(await evaluate(`document.querySelector('.followup-composer button[type=submit]').disabled`),true);
      assert.deepEqual(errors,[]);console.log('Unified continue UI: preserved draft, confirmed fresh/fork, same-task follow-up, failure and active/remote guards passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--local-permissions-only')) {
      let saves=0, failSave=false, failResume=false, resumes=0;
      goalTask=await evaluate(`structuredClone(state.tasks[0])`);
      ipcMain.handle('fixture:codex-permissions',(_event,id,value,confirmed)=>{
        assert.equal(id,goalTask.id);assert.equal(confirmed,value==='full-access');
        if(failSave)throw new Error('権限の保存に失敗しました');
        saves++;goalTask.localCodexPermissions=value;return structuredClone(goalTask);
      });
      ipcMain.removeHandler('fixture:resume');
      ipcMain.handle('fixture:resume',(_event,id)=>{
        assert.equal(id,goalTask.id);resumes++;
        assert.equal(goalTask.localCodexPermissions,'full-access','resume must observe the persisted permissions');
        if(failResume)throw new Error('復旧端末を終了してください');
        return goalTask;
      });
      Object.assign(goalTask,{remote:undefined,localCodexPermissions:undefined,state:'awaiting-input',goal:{...initialGoal('権限を確認する'),status:'draft'},runs:[]});
      await evaluate(`{
        state.tasks=[${JSON.stringify(goalTask)}];const t=state.tasks[0];t.allowedAgentIds=['codex'];
        state.queue={running:false,stopping:false,activeTaskIds:[]};state.selectedTaskId=t.id;showView('tasks');openTaskPanel(t,'goal');
        [...document.querySelectorAll('#task-detail button')].find(b=>b.textContent==='ローカルCodexの権限…').click();
      }`);
      assert.equal(await evaluate(`document.querySelector('.environment-recovery-dialog h3').textContent`),'ローカルCodexの権限');
      assert.equal(await evaluate(`[...document.querySelectorAll('.environment-recovery-dialog button')].some(b=>/接続・診断|再開/.test(b.textContent))`),false);
      const save=`[...document.querySelectorAll('.environment-recovery-dialog button')].find(b=>b.textContent==='権限をこのタスクに保存')`;
      await evaluate(`window.confirm=()=>false;document.querySelector('.environment-recovery-dialog select').value='full-access';${save}.click()`);
      assert.equal(saves,0);
      await evaluate(`window.confirm=()=>true;${save}.click()`);
      for(let i=0;i<100&&!await evaluate(`document.querySelector('.recovery-diagnostic-output').textContent.includes('保存しました')`);i++)await new Promise(r=>setTimeout(r,10));
      assert.equal(saves,1);
      assert.match(await evaluate(`document.querySelector('.task-environment-details').textContent`),/Codex権限.*Full access/);
      assert.match(await evaluate(`document.querySelector('.environment-recovery-dialog').textContent`),/タスクは開始していません/);
      assert.equal(resumes,0,'draft save never approves or resumes a task');
      await evaluate(`document.querySelector('.environment-recovery-dialog').close()`);
      for(let i=0;i<100&&await evaluate(`!!document.querySelector('.environment-recovery-dialog')`);i++)await new Promise(r=>setTimeout(r,10));
      Object.assign(goalTask,{state:'blocked',localCodexPermissions:undefined,goal:{...goalTask.goal,status:'approved'},resumeFromUnitId:'work',
        workUnits:[{id:'plan',role:'worker',planPhase:true,state:'completed',title:'完了済み計画',dependsOn:[],attemptedAgentIds:[]},
          {id:'work',role:'worker',mode:'write',state:'blocked',title:'不足証拠の補完',dependsOn:['plan'],attemptedAgentIds:[]} ]});
      const retained=structuredClone(goalTask);
      await evaluate(`state.tasks=[${JSON.stringify(goalTask)}];state.queue={running:true,activeTaskIds:['unrelated-task']};renderDetail();
        [...document.querySelectorAll('#task-detail button')].find(b=>b.textContent==='ローカルCodexの権限…').click()`);
      const combined=`[...document.querySelectorAll('.environment-recovery-dialog button')].find(b=>b.textContent==='保存して同じ工程から再開')`;
      assert.equal(await evaluate(`!!${combined} && !${combined}.disabled`),true,'other tasks do not lock stopped task settings');
      const select=`document.querySelector('.environment-recovery-dialog select')`;
      await evaluate(`window.confirm=()=>false;${select}.value='full-access';${combined}.click()`);
      assert.equal(saves,1);assert.equal(resumes,0,'declining risk confirmation must not save or resume');
      failSave=true;
      await evaluate(`window.confirm=()=>true;${combined}.click()`);
      for(let i=0;i<100&&!await evaluate(`document.querySelector('.recovery-diagnostic-output').textContent.includes('保存に失敗')`);i++)await new Promise(r=>setTimeout(r,10));
      assert.equal(resumes,0);assert.equal(await evaluate(`${combined}.disabled`),false);
      failSave=false;failResume=true;
      await evaluate(`${combined}.click()`);
      for(let i=0;i<100&&!await evaluate(`document.querySelector('.recovery-diagnostic-output').textContent.includes('権限は保存済み')`);i++)await new Promise(r=>setTimeout(r,10));
      assert.equal(goalTask.localCodexPermissions,'full-access');assert.equal(resumes,1);
      assert.match(await evaluate(`document.querySelector('.recovery-diagnostic-output').textContent`),/復旧端末を終了/);
      assert.equal(await evaluate(`${combined}.disabled`),false,'failed resume remains actionable with saved permissions');
      failResume=false;
      await evaluate(`{const b=${combined};b.click();b.click()}`);
      for(let i=0;i<100&&await evaluate(`!!document.querySelector('.environment-recovery-dialog')`);i++)await new Promise(r=>setTimeout(r,10));
      assert.equal(resumes,2,'double clicks must not duplicate saves or resumes');
      assert.equal(await evaluate(`!!document.querySelector('.environment-recovery-dialog')`),false);
      assert.deepEqual(goalTask.goal,retained.goal);assert.deepEqual(goalTask.workUnits,retained.workUnits);
      assert.deepEqual(goalTask.runs,retained.runs);assert.equal(goalTask.resumeFromUnitId,retained.resumeFromUnitId);
      assert.equal(errors.length,0,errors.join('\n'));
      console.log('Local permissions: legacy save, confirmation, independent task lock, save-before-resume, failures and duplicate guard verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--workflow-graph-only')) {
      await evaluate(`{
        const t=state.tasks[0];state.selectedTaskId=t.id;
        t.workUnits=['a','b','c','d'].map((id,i)=>({id,title:'工程'+id,role:'worker',mode:'read',instructions:'確認する内容',state:i===3?'pending':'completed',dependsOn:i===0?[]:i===3?['b','c']:['a'],attemptedAgentIds:[],assignedAgentId:'codex'}));
        t.workUnits[1].subtask={key:'b',requirements:{independenceGroup:'solve'},comparison:{input:'固定資料 v1',evaluation:'共通テストと説明の明瞭さ',approach:'解析的な案'}};
        t.runs=['a','b','c'].map((id,i)=>({id:'run-'+id,workUnitId:id,agentId:i===2?'claude':'codex',role:'worker',state:'completed',startedAt:new Date(i*60000).toISOString(),completedAt:new Date((i+3)*60000).toISOString(),output:''}));
        t.executionMetrics={elapsedMs:240000,measuredAt:0,ticking:false,measuredRuns:0,totalRuns:3,usage:{source:'unknown'},models:[],startupMs:60000,unknownMs:0,currentParallel:0,waitingRuns:0,peakParallel:2,parallelMs:120000,intervals:t.runs.map((r,i)=>({runId:r.id,unitId:r.workUnitId,agentId:r.agentId,start:i*60000,workStart:(i+1)*60000,end:(i+3)*60000,uncertain:false,live:false,waiting:false}))};
        state.selectedTaskPanels.set(t.id,'execution');renderDetail();showView('tasks');
      }`);
      assert.equal(await evaluate(`document.querySelectorAll('.workflow-node').length`),4);
      assert.equal(await evaluate(`document.querySelectorAll('.workflow-graph-canvas path').length`),4);
      assert.equal(await evaluate(`(()=>{const n=document.querySelectorAll('.workflow-node');return n[1].style.left===n[2].style.left&&n[1].style.top!==n[2].style.top})()`),true);
      assert.match(await evaluate(`document.querySelector('.workflow-statistics').textContent`),/最大実績 2/);
      assert.match(await evaluate(`document.querySelectorAll('.workflow-node')[1].textContent`),/比較案 b/);
      await evaluate(`document.querySelectorAll('.workflow-node')[1].click()`);
      assert.ok(await evaluate(`!!document.querySelector('.workflow-unit-dialog[open]')`));
      assert.match(await evaluate(`document.querySelector('.workflow-unit-dialog').textContent`),/共通テストと説明の明瞭さ/);
      await evaluate(`document.querySelector('.workflow-unit-dialog').close();[...document.querySelectorAll('.workflow-view-switch button')].find(b=>b.textContent==='実績タイムライン').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('.timeline-row').length`),3);
      assert.equal(await evaluate(`document.querySelectorAll('.timeline-segment.waiting').length`),3);
      assert.equal(await evaluate(`document.querySelectorAll('.timeline-segment.work').length`),3);
      // Older versions opened a new round for answers. Their stored graphs and
      // attempts remain visible without rewriting any task or guessing edges.
      await evaluate(`{
        const t=state.tasks[0];t.roundNumber=2;
        const old={...t.workUnits[0],id:'old-plan',title:'以前の計画',dependsOn:[]};
        t.history=[{number:1,kind:'initial',instruction:'最初の指示',state:'awaiting-input',finishedAt:new Date(0).toISOString(),workUnits:[old,{...old,id:'old-wait',title:'以前の未着手工程',state:'pending',dependsOn:['old-plan']}]}];
        t.interruptedHistory=[{...t.history[0],workUnits:[{...old,title:'古い保存時点'}],finishedAt:new Date(-10000).toISOString()}];
        t.runs.unshift({id:'old-run',workUnitId:'old-plan',agentId:'claude',role:'planner',state:'completed',output:'古い成果',startedAt:new Date(-180000).toISOString(),completedAt:new Date(-120000).toISOString()});
        t.workflowMetrics={...t.executionMetrics,intervals:[{runId:'old-run',unitId:'old-plan',agentId:'claude',start:-180000,workStart:-180000,end:-120000,live:false,waiting:false,uncertain:false},...t.executionMetrics.intervals]};
        renderDetail();
      }`);
      assert.equal(await evaluate(`document.querySelector('[aria-label="表示する作業範囲"]').value`),'task');
      assert.equal(await evaluate(`document.querySelectorAll('.timeline-row').length`),4);
      assert.match(await evaluate(`document.querySelector('.timeline-row').textContent`),/最初の指示.*以前の計画/);
      await evaluate(`{const s=document.querySelector('[aria-label="表示する作業範囲"]');s.value='round';s.dispatchEvent(new Event('change'));}`);
      assert.equal(await evaluate(`document.querySelectorAll('.timeline-row').length`),3);
      await evaluate(`{const s=document.querySelector('[aria-label="表示する作業範囲"]');s.value='task';s.dispatchEvent(new Event('change'));}[...document.querySelectorAll('.workflow-view-switch button')].find(b=>b.textContent==='依存グラフ').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('.workflow-round').length`),2);
      assert.equal(await evaluate(`document.querySelectorAll('.workflow-node').length`),6);
      assert.equal(await evaluate(`document.querySelectorAll('.workflow-graph-canvas path').length`),5);
      assert.match(await evaluate(`document.querySelector('.workflow-round').textContent`),/当時未着手/);
      assert.doesNotMatch(await evaluate(`document.querySelector('.workflow-round').textContent`),/古い保存時点/);
      assert.equal(await evaluate(`state.tasks[0].history.length`),1);
      win.setSize(900,800);await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await evaluate(`(()=>{const p=document.querySelector('.workflow-section');return p.scrollWidth<=p.clientWidth+2})()`),true);
      assert.equal(errors.length,0,errors.join('\n'));console.log('Dependency branches, arrows, concurrency, detail dialog and observed timeline verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--settings-tabs-only')) {
      await require('./check-settings-ui.cjs')(win, presets);
      assert.equal(errors.length, 0, errors.join('\n'));
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    await win.webContents.executeJavaScript(`state.tasks[0].researchCycle=1;state.selectedTaskPanels.set(state.tasks[0].id,'research');renderTasks();renderDetail();showView('tasks')`);
    for(let i=0;i<100 && !await win.webContents.executeJavaScript(`document.querySelector('.task-panel-content.research')?.textContent.includes('candidate-a')`);i++)await new Promise(r=>setTimeout(r,30));
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-panel-content.research').textContent`),/全体評価が未完了/);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.task-panel-content.research img').length`),0);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.task-panel-content.research')).overflowY`),'auto');
    await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(join(__dirname,'..','output/pdf/research-cycle-smoke.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`delete state.tasks[0].researchCycle;state.selectedTaskPanels.set(state.tasks[0].id,'overview');renderDetail()`);
    await win.webContents.executeJavaScript(`state.tasks[0].qualityCycle=1;state.selectedTaskPanels.set(state.tasks[0].id,'quality');renderTasks();renderDetail()`);
    for(let i=0;i<100 && !await win.webContents.executeJavaScript(`document.querySelector('.task-panel-content.quality')?.textContent.includes('不足データ')`);i++)await new Promise(r=>setTimeout(r,30));
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-panel-content.quality').textContent`),/未確認・不合格 1件/);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.task-panel-content.quality img').length`),0);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.quality-check').length`),1);
    await win.webContents.executeJavaScript(`document.querySelector('.task-panel-content.quality input[type=checkbox]').click()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.quality-check').length`),2);
    await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(join(__dirname,'..','output/pdf/quality-smoke.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`delete state.tasks[0].qualityCycle;state.selectedTaskPanels.set(state.tasks[0].id,'overview');renderDetail()`);
    // New modes must be usable both at dispatch and in the existing rule editor.
    const dispatchMode = await win.webContents.executeJavaScript(`document.getElementById('task-preset').value`);
    await win.webContents.executeJavaScript(`document.getElementById('task-preset').value='hpc-refactoring'; renderDispatchPresetNote()`);
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('task-preset-description').textContent`), /Fortran\/C\+\+/);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#preset-manager-select option[value="hpc-refactoring"]')?.textContent`), '大規模コード移行・GPU化モード');
    await win.webContents.executeJavaScript(`document.getElementById('task-preset').value=${JSON.stringify(dispatchMode)}; renderDispatchPresetNote()`);
    if (process.argv.includes('--dispatch-time')) {
      await win.webContents.executeJavaScript(`showView('dispatch');document.getElementById('task-title').value='先にゴールを入力';document.getElementById('task-prompt').value='証拠を確認してレポートを作る';document.getElementById('task-target-minutes').value='90'`);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-title').matches(':disabled')`),false);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-cwd').value`),'');
      await win.webContents.executeJavaScript(`document.getElementById('task-form').dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:document.querySelector('#task-form button[value="manual"]')}))`);
      await new Promise(r=>setTimeout(r,80));assert.equal(dispatchCreates,0);
      assert.match(await win.webContents.executeJavaScript(`document.getElementById('form-error').textContent`),/入力内容は保持/);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('confirm-workspace')`),null);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-workspace-mode').value`),'existing');
      await win.webContents.executeJavaScript(`document.getElementById('choose-workspace').click()`);
      await new Promise(r=>setTimeout(r,100));
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-title').value`),'先にゴールを入力');
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-target-minutes').value`),'90');
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-details').disabled`),false);
      await win.webContents.executeJavaScript(`document.getElementById('task-target-minutes').value='-1'`);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-target-minutes').checkValidity()`),false);
      await win.webContents.executeJavaScript(`document.getElementById('task-target-minutes').value='90';document.querySelector('#task-form button[value="manual"]').click()`);
      await new Promise(r=>setTimeout(r,150));
      assert.equal(dispatchCreates,1);assert.equal(goalTask.autonomy.targetMinutes,90);
      assert.equal(goalTask.workspaceMode,'existing');assert.equal(goalTask.cwd,'/tmp');
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-target-minutes').value`),'');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('input[aria-label="作業目安時間（分）"]').value`),'90');
      assert.deepEqual(errors,[]);console.log('Dispatch: early goal editing, workspace guard, duration validation, persistence and goal editor passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--writing-sections-only')) {
      const sections=['common','style','verification','paper','poster','slides'];
      const waitEditors=async()=>{
        for(let i=0;i<100&&!await win.webContents.executeJavaScript(`Object.keys(finishingEditors).length===6&&Object.values(finishingEditors).every(e=>e.settings&&!e.busy)`);i++) await new Promise(r=>setTimeout(r,30));
        assert.equal(await win.webContents.executeJavaScript(`Object.keys(finishingEditors).length===6&&Object.values(finishingEditors).every(e=>e.settings&&!e.busy)`),true);
      };
      await waitEditors();
      await win.webContents.executeJavaScript(`document.getElementById('nav-settings').click();selectSettingsPage('settings-writing')`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.writing-rule-section').length`),6);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules').value.length<2500`),true);
      const pinned=await finishing.capture();
      await win.webContents.executeJavaScript(`{const e=document.getElementById('finishing-rules');e.value+=${JSON.stringify('\n未保存の共通指示')};e.dispatchEvent(new Event('input'));}`);
      for(const section of ['style','verification']) {
        await win.webContents.executeJavaScript(`{const p=document.getElementById('writing-editor-${section}');p.parentElement.open=true;const e=p.querySelector('textarea');e.value+=${JSON.stringify('\n保存テスト:'+section)};e.dispatchEvent(new Event('input'));document.getElementById('finishing-save-${section}').click();}`);
        await waitEditors();
        const saved=(await finishing.get(section)).current;
        assert.match(saved.rules,new RegExp(`保存テスト:${section}`));
        await win.webContents.executeJavaScript(`document.getElementById('finishing-reload-${section}').click()`);
        await waitEditors();
        assert.equal(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules-${section}').value`),saved.rules);
        assert.match(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules').value`),/未保存の共通指示/);
        assert.doesNotMatch((await finishing.get()).current.rules,/未保存の共通指示/);
        await win.webContents.executeJavaScript(`document.getElementById('writing-editor-${section}').parentElement.open=false`);
      }
      const snapshot=await finishing.capture();
      assert.notEqual(snapshot.revision,pinned.revision);
      assert.doesNotMatch(pinned.rules,/保存テスト:/);
      for(const section of sections) assert.ok(snapshot.rules.includes((await finishing.get(section)).current.rules));
      // Missing mandatory sections are visible as errors, not empty editable rules.
      legacyWritingResponse=true;
      await win.webContents.executeJavaScript(`document.getElementById('finishing-reload-style').click()`);
      for(let i=0;i<100&&await win.webContents.executeJavaScript(`finishingEditors.style.busy`);i++) await new Promise(r=>setTimeout(r,30));
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('finishing-save-style').disabled`),true);
      assert.match(await win.webContents.executeJavaScript(`document.getElementById('finishing-error-style').textContent`),/再起動/);
      legacyWritingResponse=false;
      await win.webContents.executeJavaScript(`document.getElementById('finishing-reload-style').click()`);await waitEditors();
      for(const width of [1200,900]) {
        win.setSize(width,850);await new Promise(r=>setTimeout(r,100));
        assert.equal(await win.webContents.executeJavaScript(`{const e=document.getElementById('writing-rule-sections');e.scrollWidth<=e.clientWidth+2}`),true);
      }
      await win.webContents.executeJavaScript(`document.getElementById('writing-rule-sections').scrollIntoView({block:'start'})`);
      writeFileSync(join(__dirname,'..','output/pdf/writing-rule-sections-smoke.png'),(await win.webContents.capturePage()).toPNG());
      assert.deepEqual(errors,[]);
      console.log('Writing rules: six sections, style/verification saves, unchanged drafts, immutable snapshots, reload guards and responsive layout passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--goal-approval-only')) {
      const goal = {...initialGoal('長い目的を省略せず確認する。'.repeat(100)), questions:[]};
      await win.webContents.executeJavaScript(`(() => {
        const t=state.tasks[0]; Object.assign(t,{goal:${JSON.stringify(goal)},state:'awaiting-input',awaitingReason:'goal',goalPreparation:false,runs:[],report:undefined,workflowMode:'primary',workUnits:[],goalHistory:[]});
        state.selectedTaskId=t.id; state.selectedTaskPanels.set(t.id,'overview'); showView('tasks'); renderTasks(); renderDetail();
      })()`);
      goalTask = await win.webContents.executeJavaScript(`structuredClone(state.tasks[0])`);
      const settle = async () => { for(let i=0;i<100 && await win.webContents.executeJavaScript(`goalBusy.size>0`);i++) await new Promise(r=>setTimeout(r,30)); assert.equal(await win.webContents.executeJavaScript(`goalBusy.size`),0); };
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.progress-objective').length`),0,'no duplicate objective summary');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.goal-editor .execution-settings').length`),1);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('#task-detail button')].some(b=>/実行戦略を設定|実行戦略…|全文を表示/.test(b.textContent))`),false);
      for (const width of [1280, 900]) {
        win.setSize(width,1000);
        await new Promise(r=>setTimeout(r,150));
        assert.equal(await win.webContents.executeJavaScript(`(() => {const e=document.querySelector('.goal-objective-field textarea');return e.scrollHeight<=e.clientHeight+2;})()`),true,'full objective at every width');
        assert.equal(await win.webContents.executeJavaScript(`(() => {const e=document.querySelector('.goal-editor');return e.scrollWidth<=e.clientWidth+2;})()`),true,'no horizontal overflow');
      }
      win.setSize(1280,1000);
      await win.webContents.executeJavaScript(`(() => {
        const objective=document.querySelector('.goal-objective-field textarea');objective.value='既存の実装を検証し、改善案と検証結果を技術レポートにまとめる。';objective.dispatchEvent(new Event('input'));
        const p=document.querySelector('.goal-editor [aria-label="割り当て方針"]');p.value='throughput';p.dispatchEvent(new Event('change'));
        const n=document.querySelector('.goal-editor [aria-label="最大同時実行数"]');n.value='3';n.dispatchEvent(new Event('change'));
        const time=document.querySelector('[aria-label="作業目安時間（分）"]');time.value='45';time.dispatchEvent(new Event('input'));renderDetail();
      })()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor [aria-label="最大同時実行数"]').value`),'3','draft survives redraw');
      const beforeSaveRevision=goalTask.goal.revision;
      await win.webContents.executeJavaScript(`(() => {const n=document.querySelector('.goal-editor [aria-label="最大同時実行数"]');n.value='';n.dispatchEvent(new Event('change'));[...document.querySelectorAll('.goal-editor button')].find(b=>b.textContent==='下書きを保存').click();})()`);
      await settle();assert.equal(goalTask.goal.revision,beforeSaveRevision,'strategy failure must not save or approve goal');
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor > .form-error').textContent`));
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[aria-label="作業目安時間（分）"]').value`),'45','edits survive failed save');
      await win.webContents.executeJavaScript(`(() => {const n=document.querySelector('.goal-editor [aria-label="最大同時実行数"]');n.value='3';n.dispatchEvent(new Event('change'));})()`);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.goal-editor button')].find(b=>b.textContent==='下書きを保存').click()`);
      await settle();
      assert.equal(goalTask.execution.maxParallel,3);assert.equal(goalTask.execution.scheduling,'throughput');assert.equal(goalTask.autonomy.targetMinutes,45);
      assert.equal(goalTask.goal.status,'draft');
      await win.webContents.executeJavaScript(`document.querySelector('.goal-editor').scrollIntoView({block:'start'})`);
      await new Promise(r=>setTimeout(r,150));
      writeFileSync(join(__dirname,'..','output/pdf/goal-approval-smoke.png'),(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.querySelector('.goal-execution-section').scrollIntoView({block:'start'})`);
      await new Promise(r=>setTimeout(r,150));
      writeFileSync(join(__dirname,'..','output/pdf/goal-approval-strategy-smoke.png'),(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.goal-editor button')].find(b=>b.textContent==='ゴールを承認してキューへ').click()`);
      await settle();assert.equal(goalTask.goal.status,'approved');
      assert.deepEqual(errors,[]);console.log('Goal approval: full objective, inline strategy, responsive layout, shared save and approval passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--initial-cli-only')) {
      const { initialAssignmentPatch } = require('../dist/core/initial-assignment');
      goalTask = await win.webContents.executeJavaScript(`structuredClone(state.tasks[0])`);
      Object.assign(goalTask, { state:'awaiting-input',awaitingReason:'goal',workflowMode:'primary',roundNumber:1,runs:[],allowedAgentIds:['codex','claude'],modelOverrides:{},goal:initialGoal('Editable objective'),report:undefined });
      goalTask.workUnits=createExecutionWorkflow(goalTask);
      let saves=0;
      ipcMain.handle('fixture:initial-cli', (_e,id,value,updatedAt)=>{
        assert.equal(id,goalTask.id);saves++;
        goalTask={...goalTask,...initialAssignmentPatch(goalTask,value,updatedAt),updatedAt:new Date().toISOString()};return goalTask;
      });
      await win.webContents.executeJavaScript(`state.tasks=[${JSON.stringify(goalTask)}];state.selectedTaskId=state.tasks[0].id;state.queue.activeTaskIds=[];showView('tasks');renderTasks();renderDetail()`);
      // Start-CLI settings live with the goal; the everyday toolbar is execution-only.
      await evaluate(`openTaskPanel(state.tasks[0],'goal')`);
      const opener=`[...document.querySelectorAll('[aria-label="このタスクの設定"] button')].find(b=>b.textContent.startsWith('開始時のCLI'))`;
      assert.equal(await win.webContents.executeJavaScript(`${opener}.disabled`),false);
      await win.webContents.executeJavaScript(`document.querySelector('.goal-objective-field textarea').value='Unsaved objective';document.querySelector('.goal-objective-field textarea').dispatchEvent(new Event('input'))`);
      await win.webContents.executeJavaScript(`${opener}.click()`);
      const dialogClick=label=>win.webContents.executeJavaScript(`[...document.querySelectorAll('.initial-cli-dialog button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
      await win.webContents.executeJavaScript(`const cli=document.querySelector('.initial-cli-dialog [aria-label="開始時のCLI"]');cli.value='claude';cli.dispatchEvent(new Event('change'));`);
      await dialogClick('キャンセル');assert.equal(saves,0);
      await win.webContents.executeJavaScript(`${opener}.click()`);
      await win.webContents.executeJavaScript(`{const cli=document.querySelector('.initial-cli-dialog [aria-label="開始時のCLI"]');cli.value='claude';cli.dispatchEvent(new Event('change'));}`);
      await dialogClick('候補を取得');await new Promise(r=>setTimeout(r,120));
      await win.webContents.executeJavaScript(`{const model=document.querySelector('.initial-cli-dialog .model-picker select');model.value='claude-test';model.dispatchEvent(new Event('change'));document.querySelector('.initial-cli-dialog [type="checkbox"]').checked=false;}`);
      for (const size of [[1200,780],[800,600]]) {
        win.setSize(...size);await new Promise(r=>setTimeout(r,80));
        assert.ok(await win.webContents.executeJavaScript(`{const d=document.querySelector('.initial-cli-dialog');d.scrollWidth<=d.clientWidth+2}`));
      }
      writeFileSync(join(__dirname,'..','output/pdf/initial-cli-smoke.png'),(await win.webContents.capturePage()).toPNG());
      await dialogClick('保存');await new Promise(r=>setTimeout(r,120));
      assert.deepEqual(goalTask.initialAssignment,{agentId:'claude',model:'claude-test',allowFallback:false,round:1});
      assert.equal(goalTask.goal.status,'draft');assert.equal(goalTask.runs.length,0);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-objective-field textarea').value`),'Unsaved objective','goal edits survive saving only the start CLI');
      assert.match(await win.webContents.executeJavaScript(`${opener}.textContent`),/claude/i);
      await win.webContents.executeJavaScript(`state.tasks[0].state='planning';state.tasks[0].goalPreparation=true;state.tasks[0].runs=[{id:'proposal',workUnitId:state.tasks[0].workUnits[0].id,role:'planner',agentId:'codex',providerKey:'openai',state:'running',output:'',displayOutput:'',startedAt:new Date().toISOString(),goalPreparation:true}];renderDetail()`);
      assert.equal(await win.webContents.executeJavaScript(`${opener}.disabled`),true,'a started goal proposal is not replaced');
      await win.webContents.executeJavaScript(`state.tasks[0].state='running';state.tasks[0].goalPreparation=false;state.tasks[0].runs[0].goalPreparation=false;renderDetail()`);
      assert.equal(await win.webContents.executeJavaScript(`Boolean(${opener})`),false,'start settings are not offered after substantive work has begun');
      assert.deepEqual(errors,[]);console.log('Initial CLI: draft goal, cancellation, model selection, save without start, draft retention, active guards and narrow layout passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--services-only')) {
      const now = new Date().toISOString();
      const base = {providerKey:'openai',serviceKey:'openai',serviceLabel:'OpenAI',providerLabel:'OpenAI',environmentLabel:'このMac',agentIds:['codex'],authModes:['subscription'],state:'available',enabled:true,connected:true,cliInstalled:true,totalTokens:12,inputTokens:8,outputTokens:4,runs:1,failures:0,models:[],limitSource:'reported-live',capacityUpdatedAt:now,windows:[{id:'week',label:'Current week',scope:'shared',usedPercent:20,resetAt:'2099-01-01T00:00:00Z'}],usedPercent:20};
      let resources = [base,{...base,providerKey:'openai@remote',environmentId:'remote',environmentLabel:'スパコン',connected:false,usedPercent:35,windows:[{...base.windows[0],usedPercent:35}],capacityUpdatedAt:new Date(Date.now()+1000).toISOString()}];
      ipcMain.handle('fixture:capacity-refresh',()=>resources);
      ipcMain.handle('fixture:service-check',(_e,key)=>{resources=resources.map(r=>r.providerKey===key?{...r,connected:true,login:{loggedIn:true,detail:'CLI報告',checkedAt:now}}:r);return resources;});
      ipcMain.handle('fixture:service-account',(_e,key,label)=>{resources=resources.map(r=>r.providerKey===key?{...r,accountLabel:label}:r);return resources;});
      await win.webContents.executeJavaScript(`state.resources=${JSON.stringify(resources)};showView('usage');serviceEnvironment='';renderResourceSummary();document.querySelector('.model-default-row[data-agent-id="codex"]').open=true`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-view #settings-models, #settings-view [data-service-status], #settings-view #glm-form').length`),0,'system settings must contain no duplicate service editor');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#usage-view #model-default-form, #usage-view #glm-form').length`),2,'both authoritative CLI forms live only in Resources');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-service-status="codex"]').length`),1);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.unified-service-card, #open-routing-settings').length`),0,'old duplicate list and navigation are removed');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#resource-summary .resource-summary-item').length`),2,'unidentified accounts are separate');
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('#resource-grid').textContent`),/状態未確認/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('#resource-grid').textContent`),/SSH未接続/);
      await win.webContents.executeJavaScript(`document.querySelector('#resource-grid .service-connection button').click()`);
      for(let i=0;i<50&&!await win.webContents.executeJavaScript(`document.querySelector('#resource-grid .service-connection').classList.contains('ready')`);i++) await new Promise(r=>setTimeout(r,30));
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#resource-grid .service-connection.ready').length`),1);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('#resource-grid button')].some(b=>/アカウントを区分|使用枠の詳細|モデル別・取得詳細/.test(b.textContent))`),false);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-service-accounts] .service-account-card').length`),0,'quota is not duplicated');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-service-status="codex"] .service-quota-line').length`),2,'quota is inline per connection');
      await win.webContents.executeJavaScript(`state.resources.forEach(r=>r.accountLabel='old-label');renderResourceSummary()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#resource-summary .resource-summary-item').length`),2,'legacy labels do not merge observations');
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('resource-summary').textContent.includes('old-label')`),false);
      await win.webContents.executeJavaScript(`state.resources[0].models=[{id:'unmetered-model',label:'Unmetered model'}];openResourceUsageDialog('openai')`);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('resource-usage-dialog-body').textContent.includes('Unmetered model')`),false,'catalog-only models have no quota rows');
      await win.webContents.executeJavaScript(`state.resources[0].windows.push({id:'model-limit',label:'Weekly',model:'metered-model',scope:'model',usedPercent:65,resetAt:'2099-01-01T00:00:00Z'});renderResourceSummary()`);
      assert.match(await win.webContents.executeJavaScript(`document.getElementById('resource-usage-dialog-body').textContent`),/metered-model.*65.0%/);
      await win.webContents.executeJavaScript(`closeResourceUsageDialog();state.resources[0].windows.pop();renderResources()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('#resource-summary').textContent`),/35.0%/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#resource-grid .service-connection.ready').length`),1,'quota does not reconnect remote');
      await win.webContents.executeJavaScript(`{
        const model=document.querySelector('.model-default-row[data-agent-id="codex"] .model-picker input');model.value='draft-model';model.dispatchEvent(new Event('input',{bubbles:true}));
        const slider=document.querySelector('[data-service-usage="codex"] input[type="range"]');slider.value='77';slider.dispatchEvent(new Event('input',{bubbles:true}));
        document.getElementById('glm-model').value='draft-opencode';showView('settings');renderResources();renderResourceSummary();showView('usage');
      }`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-service-status="codex"] .service-connection').length`),2);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.model-default-row[data-agent-id="codex"] .model-picker input').value`),'draft-model');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-service-usage="codex"] .policy-limit').value`),'77');
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('glm-model').value`),'draft-opencode');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.model-default-row[data-agent-id="codex"]').open`),true);
      // Resources owns the SSH/CLI workflow; hiding a terminal must not stop it.
      let serviceStarts = 0, serviceStops = 0, serviceInput = '', serviceAlive = true;
      ipcMain.handle('fixture:service-terminal-start',()=>{serviceStarts++;return 'remote-cli';});
      ipcMain.handle('fixture:service-terminal-snapshot',()=>({data:'Remote CLI ready\\r\\n',offset:20,alive:serviceAlive,cols:100,rows:28,inputAllowed:serviceAlive}));
      ipcMain.handle('fixture:service-terminal-input',(_e,_id,data)=>{serviceInput+=data;});
      ipcMain.handle('fixture:service-terminal-stop',()=>{serviceStops++;serviceAlive=false;return true;});
      await win.webContents.executeJavaScript(`showRemoteServiceTerminal(state.resources.find(r=>r.environmentId==='remote'))`);
      const serviceClick = async label => win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-dialog button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
      await new Promise(r=>setTimeout(r,50));
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-dialog > .detail-actions button')].filter(b=>b.checkVisibility()).map(b=>b.textContent)`),['接続する','画面を閉じる']);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.remote-service-recovery').hidden`),true);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#remote-bind-task, .remote-service-management')`),null);
      await serviceClick('接続する'); await new Promise(r=>setTimeout(r,50));
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-dialog > .detail-actions button')].filter(b=>b.checkVisibility()).map(b=>b.textContent)`),['接続を確認してCLIを開く','SSHを切断','画面を閉じる']);
      failNextRemoteCheck = true;
      await serviceClick('接続を確認してCLIを開く'); await new Promise(r=>setTimeout(r,100));
      assert.equal(serviceStarts,0,'failed SSH confirmation never launches a CLI');
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.remote-service-dialog .form-error').textContent`),/authentication not finished/);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-dialog button')].find(b=>b.textContent==='接続を確認してCLIを開く').disabled`),false,'can retry without recreating dialog');
      await serviceClick('接続を確認してCLIを開く'); await new Promise(r=>setTimeout(r,100));
      assert.equal(serviceStarts,1);
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-dialog > .detail-actions button')].filter(b=>b.checkVisibility()).map(b=>b.textContent)`),['状態・使用枠を更新','CLI端末を終了','画面を閉じる']);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.remote-service-recovery').hidden`),true,'healthy connection needs no recovery controls');
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-recovery button')].find(b=>b.textContent==='ログインをやり直す…').disabled`),true,'no duplicate CLI while running');
      await win.webContents.executeJavaScript(`document.querySelector('.remote-service-dialog .xterm-helper-textarea').focus()`);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'x'});win.webContents.sendInputEvent({type:'char',keyCode:'x'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'x'});
      await new Promise(r=>setTimeout(r,100));assert.ok(serviceInput.includes('x'));
      await serviceClick('画面を閉じる');assert.equal(serviceStops,0);
      await win.webContents.executeJavaScript(`showRemoteServiceTerminal({...state.resources.find(r=>r.environmentId==='remote'),serviceTerminalId:'remote-cli'})`);
      await new Promise(r=>setTimeout(r,800));assert.equal(serviceStarts,1);
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.remote-service-dialog .login-terminal').clientHeight > 100`));
      for (const size of [[900,620],[1200,780]]) {
        win.setSize(...size); await new Promise(r=>setTimeout(r,100));
        assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.remote-service-dialog .login-terminal').clientHeight > 100`),'controls must leave room for terminal input');
        assert.ok(await win.webContents.executeJavaScript(`(()=>{const d=document.querySelector('.remote-service-dialog'),b=[...d.querySelectorAll('button')].find(b=>b.textContent==='画面を閉じる');return b.getBoundingClientRect().bottom<=d.getBoundingClientRect().bottom&&d.scrollWidth<=d.clientWidth+2})()`),'close button remains reachable');
      }
      writeFileSync(join(__dirname,'..','output/pdf','remote-service-terminal.png'),(await win.webContents.capturePage()).toPNG());
      await serviceClick('画面を閉じる');assert.equal(serviceStops,0);
      // Usage setup is integrated into opening the CLI. It must not run while
      // the existing terminal is alive, nor silently reset account cooldowns.
      let accountChanges = 0, usageInstalls = 0;
      ipcMain.removeHandler('fixture:agy-usage-install');
      resources.push({...base,providerKey:'google-antigravity@remote',serviceKey:'google-antigravity',agentIds:['antigravity'],environmentId:'remote',environmentLabel:'スパコン',state:'cooldown',usedPercent:undefined,windows:[]});
      ipcMain.handle('fixture:service-account-changed',(_e,key)=>{assert.equal(key,'google-antigravity@remote');accountChanges++;resources=resources.map(r=>r.providerKey===key?{...r,state:'unknown',limitSource:'unknown',capacityUpdatedAt:undefined}:r);return resources;});
      ipcMain.handle('fixture:agy-usage-install',(_e,id)=>{assert.equal(id,'remote');usageInstalls++;return 'Usage連携を保存しました';});
      await win.webContents.executeJavaScript(`state.resources=${JSON.stringify(resources)};showRemoteServiceTerminal({...state.resources.find(r=>r.agentIds.includes('antigravity')),serviceTerminalId:'remote-cli'})`);
      await new Promise(r=>setTimeout(r,800));
      assert.equal(usageInstalls,0);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-dialog button')].some(b=>['接続の管理…','Usage連携を有効化','別アカウントへの切替を反映…'].includes(b.textContent))`),false);
      serviceAlive=false;
      await new Promise(r=>setTimeout(r,800));
      await win.webContents.executeJavaScript(`window.confirm=()=>true;void 0`);
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-dialog > .detail-actions button')].filter(b=>b.checkVisibility()).map(b=>b.textContent)`),['CLIを開く','SSHを切断','画面を閉じる']);
      serviceAlive=true;
      await serviceClick('CLIを開く');await new Promise(r=>setTimeout(r,80));assert.equal(usageInstalls,1);
      assert.equal(accountChanges,0,'opening a CLI cannot acknowledge an account change');
      await serviceClick('画面を閉じる');
      // Authentication recovery appears only for a known failure. Keep the
      // terminal and close button usable even on a short window.
      serviceAlive=false;
      await win.webContents.executeJavaScript(`showRemoteServiceTerminal({...state.resources.find(r=>r.environmentId==='remote'),login:{loggedIn:true,detail:'CLI logged in'},capacityError:'遠隔CLIの使用量認証が拒否されました。'})`);
      await new Promise(r=>setTimeout(r,100));
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.remote-service-recovery').hidden`),false);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-recovery button')].find(b=>b.textContent==='ログインをやり直す…').checkVisibility()`),false,'a quota-only failure must not ask to restart CLI login');
      assert.equal(serviceStarts,2,'quota-only failure does not launch login');
      await serviceClick('画面を閉じる');
      await win.webContents.executeJavaScript(`showRemoteServiceTerminal({...state.resources.find(r=>r.environmentId==='remote'),login:{loggedIn:false,detail:'CLI authentication failed'},capacityError:'遠隔CLIの使用量認証が拒否されました。'})`);
      await new Promise(r=>setTimeout(r,100));
      assert.ok(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-recovery button')].find(b=>b.textContent==='ログインをやり直す…').checkVisibility()`));
      win.setSize(900,620);await new Promise(r=>setTimeout(r,100));
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.remote-service-dialog .login-terminal').clientHeight > 100`));
      await serviceClick('ログインをやり直す…');await new Promise(r=>setTimeout(r,80));
      assert.equal(serviceStarts,3);
      await serviceClick('画面を閉じる');
      // A quota 401 must not turn an authenticated CLI into login recovery.
      // An explicit, optional official login still refreshes usage on success.
      let claudeStarts=0, claudeRefreshes=0, claudeExit=0;
      const oldAuthError='Claude使用量APIの認証が拒否されました（HTTP 401）。Resourcesの「Claudeログイン管理」で確認・再ログインしてください。';
      resources.push({...base,providerKey:'anthropic',serviceKey:'anthropic',agentIds:['claude'],login:{loggedIn:true,detail:'CLI報告',checkedAt:now},capacityError:oldAuthError});
      ipcMain.handle('fixture:login-status',()=>({loggedIn:true,detail:'CLIはログイン済みと報告しています。'}));
      ipcMain.handle('fixture:login-start',()=>{claudeStarts++;return 'claude-fixture';});
      ipcMain.handle('fixture:login-snapshot',()=>({data:'Login finished',offset:14,alive:false,exitCode:claudeExit}));
      ipcMain.handle('fixture:login-close',()=>true);
      ipcMain.handle('fixture:login-refresh',()=>{claudeRefreshes++;resources=resources.map(r=>r.providerKey==='anthropic'?{...r,capacityError:undefined}:r);return resources;});
      await win.webContents.executeJavaScript(`state.resources=${JSON.stringify(resources)};state.orchestrationSettings.agentPolicies.find(p=>p.agentId==='claude').providerKey='anthropic';showView('usage');renderResources();document.querySelector('.model-default-row[data-agent-id="claude"]').open=true`);
      assert.doesNotMatch(await win.webContents.executeJavaScript(`document.querySelector('[data-service-status="claude"]').textContent`),/Resourcesの「Claudeログイン管理」/);
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('[data-service-status="claude"] .service-connection').classList.contains('ready')`));
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('[data-service-status="claude"]').textContent`),/再ログイン不要/);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-service-status="claude"] button')].some(b=>/認証を確認|ログインして復旧/.test(b.textContent))`),false);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-service-status="claude"] button')].find(b=>b.textContent==='CLIを開く…').click()`);
      const claudeClick = label => win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
      await new Promise(r=>setTimeout(r,100));
      assert.equal(claudeStarts,0,'viewing recovery does not start authentication');
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.claude-login-dialog .login-help').open`));
      await claudeClick('CLIを開く');await new Promise(r=>setTimeout(r,200));
      assert.equal(claudeRefreshes,1,'successful login automatically retries usage');
      assert.equal(await win.webContents.executeJavaScript(`state.resources.find(r=>r.providerKey==='anthropic').capacityError`),undefined);
      await claudeClick('閉じる');
      claudeExit=1;
      await win.webContents.executeJavaScript(`showCliLogin('claude')`);await new Promise(r=>setTimeout(r,50));
      await claudeClick('CLIを開く');await new Promise(r=>setTimeout(r,150));
      assert.equal(claudeRefreshes,1,'failed login must not auto retry the API');
      await claudeClick('閉じる');
      await win.webContents.executeJavaScript(`showView('usage')`);
      for(const size of [[1450,950],[900,700]]) {
        win.setSize(...size);await new Promise(r=>setTimeout(r,100));
        assert.ok(await win.webContents.executeJavaScript(`document.getElementById('resource-grid').scrollWidth<=document.getElementById('resource-grid').clientWidth+2`));
        writeFileSync(join(__dirname,'..','output/pdf','services-'+size[0]+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      assert.deepEqual(errors,[]); console.log('Single Resources editor: no duplicated forms, auth state, SSH isolation, account grouping, draft retention, narrow layout passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--metrics-only')) {
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0];t.executionMetrics={elapsedMs:65000,measuredAt:Date.now(),ticking:true,measuredRuns:1,totalRuns:2,usage:{source:'reported',inputTokens:1200,outputTokens:300},models:[{agentId:'codex',model:'codex-test',measuredRuns:1,totalRuns:2,usage:{source:'reported',inputTokens:1200,outputTokens:300}}]};
        state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'execution');showView('tasks');renderDetail();
      }`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-elapsed').textContent`),/0:01:05/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-tokens').textContent`),/codex-test.*1,500.*一部/);
      assert.match(await evaluate(`document.querySelector('.execution-tokens').title`),/1\/2実行取得/);
      await new Promise(r=>setTimeout(r,16000));
      assert.doesNotMatch(await win.webContents.executeJavaScript(`document.querySelector('.execution-elapsed').textContent`),/0:01:05/);
      await win.webContents.executeJavaScript(`state.tasks[0].executionMetrics.ticking=false;renderDetail()`);
      await new Promise(r=>setTimeout(r,1200));
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-elapsed').textContent`),/0:01:05/);
      await win.webContents.executeJavaScript(`state.tasks[0].executionMetrics.models[0].usage={source:'unknown'};renderDetail()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-tokens').textContent`),/未取得/);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-workflow-mode')`),null);
      win.setSize(900,700);await new Promise(r=>setTimeout(r,100));
      assert.ok(await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.execution-metrics');return p.scrollWidth<=p.clientWidth+2})()`));
      assert.deepEqual(errors,[]);console.log('Execution metrics: live clock, frozen pause, partial/unknown tokens, narrow layout and primary-only Dispatch passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--closure-only')) {
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0];Object.assign(t,{state:'awaiting-input',awaitingReason:'result',resumeFromUnitId:undefined,
          goal:{...t.goal,status:'approved',revision:1,questions:[]},roundNumber:1,autonomyCycle:1,
          error:'残作業の差戻し回数上限です。'+('同じ品質検証の長い説明。'.repeat(500)),
          workUnits:[{id:'worker',role:'worker',state:'completed',title:'実作業',dependsOn:[],attemptedAgentIds:[]},
            {id:'report',role:'reporter',state:'pending',title:'Report',dependsOn:['worker'],attemptedAgentIds:[]}]});
        state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'overview');showView('tasks');renderTasks();renderDetail();
      }`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-stop-notice > summary').textContent.length<160`),true);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-actions button')].some(b=>b.textContent==='残課題を記録して仕上げへ')`),true);
      await win.webContents.executeJavaScript(`document.querySelector('.task-stop-notice').open=true`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-stop-notice > p').textContent.length<160`),true);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-stop-notice .decision-original').open`),false);
      // A retry cap inside an existing closure is a saved handoff, not a new
      // worker budget. Show the direct recovery action without claiming pass.
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0];t.resumeFromUnitId='report';t.workClosure={round:1,cycle:1,goalRevision:1,startedAt:new Date().toISOString(),reason:'再作業を終了',issues:['根拠が未確認']};renderDetail();
        document.querySelector('.task-stop-notice').open=true;
      }`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-stop-notice').textContent`),/引き継ぎが同じ担当への再試行/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-stop-notice').textContent`),/再作業を繰り返さずレポートと独立レビュー/);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-actions button')].some(b=>b.textContent==='残課題を記録して仕上げへ')`),true);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-stop-notice button')].some(b=>b.textContent==='レポーターから再開')`),false,'pending reporter must not replace the actual worker-cap recovery');
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0];t.resumeFromUnitId=undefined;t.workUnits.forEach(u=>u.state='completed');t.error='作業を終了しました。未達・未確認事項は残っています（全体合格ではありません）。';
        t.workClosure={round:1,cycle:1,goalRevision:1,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),reason:'再作業を終了',issues:['根拠が未確認']};renderTasks();renderDetail();
      }`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-stop-notice').hidden`),true);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.progress-summary').textContent`),/作業終了・残課題あり/);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-actions button')].some(b=>/合格.*完了|仕上げへ|再開/.test(b.textContent))`),false);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-panel-tab')].find(b=>b.textContent==='作業報告').click()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-work-report').textContent`),/作業終了.*未達/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.work-report-remaining li').textContent`),/根拠が未確認/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-work-report').textContent`),/全体合格ではありません/);
      // Subject findings lead; display metadata neither grants acceptance nor
      // hides scientific uncertainty. User/agent text is never interpreted HTML.
      await win.webContents.executeJavaScript(`{
        const u=state.tasks[0].workUnits[0];u.primary=true;
        u.output='<work-check>'+JSON.stringify({status:'needs-work',summary:'境界条件を修正する',remainingWork:'大規模条件を測る',workReport:{proposals:['転送削減を検討'],activities:['固定条件で測定'],results:['小規模で1.5倍'],interpretation:['大規模では転送が支配的'],nextSteps:['転送をまとめる'],issues:['大規模は未確認 <script>fixture</script>']}})+'</work-check>';renderDetail();
      }`);
      const subjectText=await win.webContents.executeJavaScript(`document.querySelector('.task-work-report').textContent`);
      assert.match(subjectText,/提案・検討した方法.*転送削減.*得られた結果.*1.5倍.*結果の解釈/);
      assert.ok(subjectText.indexOf('小規模で1.5倍')<subjectText.indexOf('作業終了 —'));
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.work-report-issues').open`),false);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.work-report-remaining').open`),false);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-work-report script')`),null);
      // Finished reports must not suppress a subsequent real failure or pause.
      await win.webContents.executeJavaScript(`Object.assign(state.tasks[0],{state:'failed',error:'接続エラー',resumeFromUnitId:'report'});renderDetail()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-stop-notice').hidden`),false);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-work-report').textContent`),/作業は継続・停止中/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-work-report').textContent`),/小規模で1.5倍/);
      assert.deepEqual(errors,[]);console.log('Partial closure GUI: concise cause, hidden full details, direct legacy recovery, honest finished status verified');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--review-time-only')) {
      const {pairUnits}=require('../dist/core/review-pair');
      const {reviewTimingPatch}=require('../dist/core/review-timing');
      const t=await win.webContents.executeJavaScript(`structuredClone(state.tasks[0])`);
      Object.assign(t,{goal:{...initialGoal('時間目安に応じた確認'),status:'approved',questions:[]},roundNumber:1,autonomyCycle:1,reviewPolicy:'adversarial-pair',
        autonomy:{enabled:true,maxCycles:3,targetMinutes:1},workflowMode:'primary',execution:{reuseContext:true,decompose:true,maxSubtasks:4,maxParallel:2,reviewMode:'cross-service'},state:'paused',runs:[],history:[],interruptedHistory:[],
        workUnits:pairUnits([{id:'ready-work',role:'worker',mode:'write',state:'completed',title:'実装',instructions:'',dependsOn:[],attemptedAgentIds:[]}])});
      Object.assign(t,reviewTimingPatch(t));
      await win.webContents.executeJavaScript(`state.tasks=[${JSON.stringify(t)}];state.selectedTaskId=state.tasks[0].id;state.selectedTaskPanels.set(state.tasks[0].id,'overview');showView('tasks');renderTasks();renderDetail()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.progress-summary').textContent`),/独立1回.*クロス検証は未実施/);
      await win.webContents.executeJavaScript(`openTaskPanel(state.tasks[0],'history')`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.history-snapshot-note').textContent`),/未実施として省略/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-card').length`),2,'omitted review is not a live pending seat');
      await win.webContents.executeJavaScript(`state.tasks[0].autonomyState='satisfied';openTaskPanel(state.tasks[0],'goal')`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-ledger h4').textContent`),/独立レビュー1回で合格/);
      assert.doesNotMatch(await win.webContents.executeJavaScript(`document.querySelector('.goal-ledger h4').textContent`),/全サービス.*合格/);
      assert.deepEqual(errors,[]);console.log('Time-adaptive review GUI: reduced count, omitted work history, honest completion label verified');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--progress-only')) {
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0]; Object.assign(t,{state:'paused',workflowMode:'primary',error:undefined,roundNumber:1,autonomyCycle:1,
          goal:{revision:1,status:'approved',objective:'GPU版の精度と性能を検証し、技術レポートにまとめる。',deliverables:['ライブラリ','PDF'],constraints:[],outOfScope:[],questions:[],criteria:[
            {id:'precision',description:'数値演算の精度を検証する',verification:'基準値との比較',required:true},
            {id:'speed',description:'性能表の値を実験データと照合する',verification:'再集計',required:true}]},
          workUnits:[{id:'review-a',title:'精度と性能の独立レビュー',role:'reviewer',state:'completed',mode:'read',dependsOn:[],instructions:'',attemptedAgentIds:[],completedAt:'2026-09-21T01:00:00Z'},
            {id:'writer',title:'数値の不一致を修正する',role:'worker',state:'pending',mode:'write',dependsOn:['review-a'],instructions:'',attemptedAgentIds:[]}],
          evaluations:[{reviewUnitId:'review-a',reviewerAgentId:'codex',goalRevision:1,round:1,cycle:1,reviewedAt:'2026-09-21T01:00:00Z',summary:'性能表に修正が必要',concerns:['性能値の不一致'],criteria:[
            {criterionId:'precision',status:'pass',detail:'<img src=x onerror=bad> 全条件一致',evidence:[{path:'precision.json',detail:'比較記録'}]},
            {criterionId:'speed',status:'fail',detail:'測定値と表に不一致',evidence:[]}]}],qualityCycle:1});
        state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'overview');showView('tasks');renderTasks();renderDetail();
      }`);
      assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.task-panel-tab')).map(e=>e.textContent)`),['概要','目的・条件','計画・担当','実行','作業報告','成果・検証','レポート','履歴']);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-other-actions')`),null);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-environment-details').tagName`),'SECTION');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-environment-details summary')`),null);
      assert.ok(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-environment-details p')].every(p=>p.checkVisibility())`));
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-actions > button')].filter(b=>b.checkVisibility()).map(b=>b.textContent)`),['再開']);
      await evaluate(`openTaskPanel(state.tasks[0],'goal')`);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('.task-settings-actions button')].map(b=>b.textContent)`),['実行戦略…','担当・確認設定…','ローカルCodexの権限…']);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-settings-actions button')].find(b=>b.textContent==='実行戦略…').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-execution-dialog').open`),true);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-execution-dialog > button')].find(b=>b.textContent==='閉じる').click()`);
      await evaluate(`openTaskPanel(state.tasks[0],'overview')`);
      // Replace this synthetic goal, not a user's existing edit draft.
      await evaluate(`goalEdits.delete(state.tasks[0].id)`);
      // Goals now live in a direct top-level tab; long text remains fully readable.
      await win.webContents.executeJavaScript(`state.tasks[0].goal.objective=('長い最終目的の説明。\\n').repeat(12)+'末尾の条件 <img src=x>';renderDetail()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.progress-objective, .progress-changes, .progress-direction')`),null);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.progress-summary').textContent`),/担当の工程終了1件.*実行中0件.*未着手・再開待ち1件/);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-panel-tab')].find(b=>b.textContent==='目的・条件').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-panel-tab.selected').textContent`),'目的・条件');
      assert.ok(await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.goal-objective-field textarea');return p.scrollHeight<=p.clientHeight+1 && p.value.endsWith('末尾の条件 <img src=x>') && !p.querySelector('img')})()`));
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-panel-tab')].find(b=>b.textContent==='概要').click()`);
      assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('.progress-criteria, .followup-options, .assignment-row')`),false,'overview has no duplicate evidence or advanced assignment controls');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-panel-tab')].find(b=>b.textContent==='履歴').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-panel-tab.selected').textContent`),'履歴');
      assert.ok(await win.webContents.executeJavaScript(`!!document.querySelector('.task-panel-content.history')`));
      await win.webContents.executeJavaScript(`openTaskPanel(state.tasks[0],'evidence')`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.progress-criteria').textContent`),/合格記録 1件/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.progress-criteria').textContent`),/修正が必要/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.progress-criteria img').length`),0);
      await win.webContents.executeJavaScript(`document.querySelector('.progress-criterion summary').click()`);
      await new Promise(r=>setTimeout(r,30));await win.webContents.executeJavaScript(`renderDetail()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.progress-criterion').open`),true);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.progress-criterion').textContent.split('数値演算の精度を検証する').length`),2,'condition appears only once when expanded');
      for(const [width,height] of [[1450,950],[1050,760],[880,620]]) {
        win.setSize(width,height);await new Promise(r=>setTimeout(r,80));
        assert.ok(await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.task-panel-content');return p.scrollWidth<=p.clientWidth+2})()`));
        assert.ok(await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.task-panel-tabs');return p.scrollWidth<=p.clientWidth+2})()`),'all eight tabs wrap within narrow windows');
      }
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-panel-tab.selected').textContent`),'成果・検証');
      assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[aria-label="成果・検証の表示内容"] option[value="report"]')`),false);
      await win.webContents.executeJavaScript(`{const s=document.querySelector('[aria-label="成果・検証の表示内容"]');s.value='quality';s.dispatchEvent(new Event('change'));}`);
      for(let i=0;i<50 && !await win.webContents.executeJavaScript(`!!document.querySelector('.quality-check')`);i++) await new Promise(r=>setTimeout(r,30));
      assert.ok(await win.webContents.executeJavaScript(`!!document.querySelector('.quality-check')`));
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-panel-tab')].find(b=>b.textContent==='レポート').click()`);
      assert.ok(await win.webContents.executeJavaScript(`!!document.querySelector('.task-report-section')`));
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-panel-tab[aria-selected="true"]').textContent`),'レポート');
      assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[aria-label="成果・検証の表示内容"]')`),false);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-panel-tab')].find(b=>b.textContent==='計画・担当').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-panel-tab.selected').textContent`),'計画・担当');
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.task-detail-navigation').hidden`));
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-panel-tab')].find(b=>b.textContent==='概要').click()`);
      assert.ok(await win.webContents.executeJavaScript(`!!document.querySelector('.task-progress-overview')`));
      await win.webContents.executeJavaScript(`openTaskPanel(state.tasks[0],'goal')`);
      assert.ok(await win.webContents.executeJavaScript(`!!document.querySelector('.goal-editor')`));
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-settings-actions button')].find(b=>b.textContent==='担当・確認設定…').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.followup-composer').length`),1);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.followup-settings .assignment-row').length`),4);
      await win.webContents.executeJavaScript(`{const t=document.querySelector('[aria-label="追加指示"]');t.value='保存前の追加指示';t.dispatchEvent(new Event('input'));document.querySelector('.followup-settings-fields input[type="checkbox"]').click();}`);
      for(const size of [[1450,950],[880,620]]) {
        win.setSize(...size);await new Promise(r=>setTimeout(r,80));
        assert.ok(await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.task-panel-content');return p.scrollWidth<=p.clientWidth+2})()`));
        assert.ok(await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.detail-header');return p.scrollWidth<=p.clientWidth+2})()`),'toolbar wraps without overflowing');
        writeFileSync(join(__dirname,'..','output/pdf','task-followup-'+size[0]+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      await win.webContents.executeJavaScript(`document.querySelector('.task-detail-navigation button').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[aria-label="追加指示"]').value`),'保存前の追加指示');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.assignment-row').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`state.tasks[0].goal.revision`),1,'opening and leaving settings does not alter the goal');
      await win.webContents.executeJavaScript(`openTaskPanel(state.tasks[0],'history')`);
      assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('.progress-changes')`),false,'history must not repeat the recent-changes timeline');
      assert.ok(await win.webContents.executeJavaScript(`!!document.querySelector('.round-history')`));
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0];t.workUnits[0]={...t.workUnits[0],role:'worker',output:'<work-check>{"status":"needs-work","summary":"比較完了・修正が必要","remainingWork":"表の値を再計算 <img src=x>"}</work-check>'};
        renderDetail();const preview=buildWorkflow(t);preview.id='outcome-preview';document.body.append(preview);
      }`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('#outcome-preview .workflow-node.needs-work').textContent`),/担当終了・未完了報告/);
      assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#outcome-preview .workflow-node.needs-work')).borderLeftColor`),'rgb(246, 200, 95)');
      await win.webContents.executeJavaScript(`document.querySelector('#outcome-preview .workflow-node.needs-work').click()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.workflow-unit-dialog').textContent`),/数値の不一致を修正する（待機・担当未割当）/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.workflow-unit-dialog img').length`),0);
      await win.webContents.executeJavaScript(`document.querySelector('.workflow-unit-dialog').close()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#outcome-preview img').length`),0);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.history-status-needs-work .history-badge').textContent`),/担当終了・未完了報告/);
      assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.history-status-needs-work .history-badge')).color`),'rgb(246, 200, 95)');
      await win.webContents.executeJavaScript(`document.getElementById('outcome-preview').remove()`);
      await win.webContents.executeJavaScript(`progressDisclosures.clear();openTaskPanel(state.tasks[0],'overview')`);
      win.setSize(1450,950); await new Promise(r=>setTimeout(r,80));
      writeFileSync(join(__dirname,'..','output/pdf/progress-overview-smoke.png'),(await win.webContents.capturePage()).toPNG());
      // Availability is contextual, without a second hidden menu. No action here
      // dispatches work, changes permissions, or deletes a real task.
      await win.webContents.executeJavaScript(`state.tasks[0].state='running';renderDetail()`);
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-actions > button')].map(b=>b.textContent)`),['一時停止']);
      await win.webContents.executeJavaScript(`state.tasks[0].state='paused';state.tasks[0].remote={id:'fixture-remote',name:'Fixture remote',host:'localhost',cwd:'/tmp/fixture'};renderDetail()`);
      assert.ok(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-actions > button')].some(b=>b.textContent==='実行環境を復旧…'&&b.checkVisibility())`));
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-actions > button')].some(b=>/権限|スキル/.test(b.textContent))`),false);
      await evaluate(`openTaskPanel(state.tasks[0],'goal')`);
      assert.ok(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-settings-actions button')].some(b=>b.textContent==='遠隔Codexの権限…'&&b.checkVisibility())`));
      await win.webContents.executeJavaScript(`state.tasks[0].workflowMode='stages';state.tasks[0].goal.status='draft';renderDetail()`);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-actions button')].some(b=>/実行戦略|次回の担当|実行環境を復旧/.test(b.textContent))`),false);
      assert.deepEqual(errors,[]);console.log('Progress overview: eight tabs, compact overview, saved evidence, escaping, disclosure persistence, narrow layout, goal/plan/quality/report/history navigation verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--history-only')) {
      const report = '## 検証結果\n数値検証を完了しました。**全条件で一致**しています。\n\n- 基本演算：6,642件を再検証\n- 追加128条件を確認\n\n| 検査 | 結果 |\n| --- | --- |\n| 数値検証 | 1,230 / 1,230 |\n| メモリ検査 | 4 / 4 |\n\n## 残る作業\n異なるモデルによる文献照合と最終PDFの確認を引き継ぎます。\n<img src=x onerror=alert(1)>\n[危険なリンク](javascript:alert(1))\n\n```cpp\nif (error) return false;\n```';
      const units = [
        {id:'history-plan',title:'主担当 · 実行計画と体制設計',role:'planner',state:'completed',assignedAgentId:'codex',output:'調査・実装・独立レビューの工程を計画しました。'},
        {id:'history-work',title:'全対象の最適化・公平比較と報告用証拠の確定',role:'worker',state:'completed',assignedAgentId:'claude',output:report},
        {id:'history-review',title:'起動条件を拘束した異系統モデルの全文献照合B',role:'reviewer',state:'pending',assignedAgentId:'opencode',output:'文献照合の結果は未提出です。',error:'APIに接続できず、中断しました。完了済みの成果は保持しています。'},
        {id:'history-report',title:'レポート · 推敲とPDFの確認',role:'reporter',state:'pending',output:''}
      ].map(u=>({...u,instructions:'',mode:'read',dependsOn:[],attemptedAgentIds:[],startedAt:u.state==='completed'?'2026-09-21T01:00:00Z':undefined,completedAt:u.state==='completed'?'2026-09-21T01:10:00Z':undefined}));
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0]; Object.assign(t,{state:'paused',roundNumber:2,roundKind:'continue',resumeCount:2,workUnits:${JSON.stringify(units)},history:[],interruptedHistory:[]});
        state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'history');showView('tasks');renderTasks();renderDetail();
      }`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-card').length`),4);
      await win.webContents.executeJavaScript(`state.tasks[0].agentMessages=[{id:'message-fixture',threadId:'thread-fixture',round:1,at:'2026-10-05T00:00:00Z',fromUnitId:'history-plan',fromAgentId:'codex',toUnitId:'history-work',kind:'finding',text:'根拠を確認してください。<script>unsafe</script>',state:'queued'}];renderDetail()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.history-consultation summary').textContent`),/担当間の相談/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.history-consultation').open`),false);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.history-message').textContent`),/根拠を確認してください/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-message script').length`),0,'peer text must never execute');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.progress-changes').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-stage').length`),0);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.history-counts').textContent`),/作業終了 2再開待ち 1未着手 1/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.round-history button').length`),0,'reports use their own disclosures, without bulk buttons');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-report-body img,.history-report-body a,.history-report-body script').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.history-table tbody tr td:last-child').textContent`),'1,230 / 1,230');
      const formatting = await win.webContents.executeJavaScript(`(() => {
        const p=historyReportBody(${JSON.stringify('5. fifth\n8. eighth\n\n| x | y |\n| -- | nope |\n\n## 見出し\n**強調** と `code`')});
        return {start:p.querySelector('ol').start,values:[...p.querySelectorAll('ol > li')].map(e=>e.value),tables:p.querySelectorAll('table').length,strong:p.querySelector('strong').textContent,code:p.querySelector('code').textContent};
      })()`);
      assert.deepEqual(formatting,{start:5,values:[5,8],tables:0,strong:'強調',code:'code'});
      assert.deepEqual(await win.webContents.executeJavaScript(`(() => {const p=historyReportBody('実装した。検証した。\\n・残課題なし');return [...p.querySelectorAll('li')].map(e=>e.textContent)})()`),['実装した。','検証した。','残課題なし']);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.history-excerpt').tagName`),'UL');
      assert.equal(await win.webContents.executeJavaScript(`buildTaskEvidence(state.tasks[0]).querySelector('.progress-deliverables')`),null);
      assert.doesNotMatch(await win.webContents.executeJavaScript(`buildTaskEvidence(state.tasks[0]).textContent`),/PDFあり/);
      assert.equal(await win.webContents.executeJavaScript(`unitStatusLabel(state.tasks[0],{state:'completed'})`),'完了');
      assert.equal(await win.webContents.executeJavaScript(`workUnitTitle({title:'Report'})`),'レポート作成');
      // The injection fixture was checked above; screenshots show ordinary reports.
      await win.webContents.executeJavaScript(`state.tasks[0].workUnits[1].output=${JSON.stringify(report.replace('<img src=x onerror=alert(1)>\n[危険なリンク](javascript:alert(1))\n',''))};renderDetail()`);
      await win.webContents.executeJavaScript(`document.querySelectorAll('.history-card > summary')[1].click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-card')[1].open`),true);
      await win.webContents.executeJavaScript(`renderDetail()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-card')[1].open`),true,'expanded reports survive status refreshes');
      assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelectorAll('.history-card')[1].querySelector('.history-excerpt')).display`),'none');
      await win.webContents.executeJavaScript(`document.querySelectorAll('.history-card > summary')[1].click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-card[open]').length`),0);
      // Reproduce a user answer starting another instruction round while the
      // old snapshot still contains awaiting-input and unstarted review units.
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0];
        t.history=[{number:1,kind:'initial',state:'awaiting-input',instruction:'最初の依頼',finishedAt:'2026-09-21T01:15:00Z',workUnits:[
          {...t.workUnits[0],id:'old-plan',role:'planner',output:'<work-check>{"status":"ask-user","summary":"実行範囲の確認"}</work-check>'},
          {...t.workUnits[3],id:'old-report'}]}];
        t.interruptedHistory=[{number:2,kind:'continue',state:'paused',instruction:'回答を反映',finishedAt:'2026-09-21T02:00:00Z',workUnits:[{...t.workUnits[2],state:'running'}]}];
        renderDetail();
      }`);
      const snapshotBefore=await win.webContents.executeJavaScript(`JSON.stringify([state.tasks[0].history,state.tasks[0].interruptedHistory])`);
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.history-round-title')].map(e=>e.textContent)`),['現在の作業 · 追加指示 1','再開前の記録 · 追加指示 1','過去の指示 · 最初の指示']);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.history-archived .history-snapshot-note').textContent`),/現在の待機列ではなく/);
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.history-archived .history-card .history-badge')].map(e=>e.textContent)`),['当時：実行中','当時：確認を依頼','当時未着手']);
      assert.equal(await win.webContents.executeJavaScript(`JSON.stringify([state.tasks[0].history,state.tasks[0].interruptedHistory])`),snapshotBefore,'rendering must not mark historical work complete');
      for (const size of [[1440,1000],[980,740]]) {
        win.setSize(...size); await new Promise(r=>setTimeout(r,120));
        await win.webContents.executeJavaScript(`document.querySelector('.task-panel-content.history').scrollTop=0`);
        await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        const metrics=await win.webContents.executeJavaScript(`(() => {const p=document.querySelector('.task-panel-content.history');return {overflow:p.scrollWidth-p.clientWidth,small:[...p.querySelectorAll('p,span,button,h4')].filter(e=>e.checkVisibility() && parseFloat(getComputedStyle(e).fontSize)<13).length};})()`);
        assert.ok(metrics.overflow<2,JSON.stringify(metrics)); assert.equal(metrics.small,0);
        writeFileSync(join(__dirname,'..', 'output/pdf', 'history-cards-'+size[0]+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      win.setSize(1440,1000); await new Promise(r=>setTimeout(r,100));
      await win.webContents.executeJavaScript(`document.querySelectorAll('.history-card > summary')[1].click()`);
      await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      writeFileSync(join(__dirname,'..','output/pdf/history-report-expanded.png'),(await win.webContents.capturePage()).toPNG());
      assert.deepEqual(errors,[]); console.log('History cards, states, table values, safe formatting, disclosures and compact/wide layouts verified.');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    if (process.argv.includes('--design')) {
      // Visual changes must not trade legibility for clipped controls or strand
      // the final settings section when the window is resized.
      for (const size of [[1200,780],[980,640],[1440,900]]) {
        win.setSize(...size);
        await new Promise(resolve=>setTimeout(resolve,100));
        for (const view of ['dispatch','settings','tasks','usage']) {
          await win.webContents.executeJavaScript(`showView('${view}')`);
          const metrics = await win.webContents.executeJavaScript(`(() => {
            const v=document.getElementById('${view}-view');
            return {body:getComputedStyle(document.body).fontSize,
              overflow:v.scrollWidth-v.clientWidth,
              small:[...v.querySelectorAll('label,button,p,small,summary')].filter(e=>e.checkVisibility() && e.textContent.trim()).filter(e=>parseFloat(getComputedStyle(e).fontSize)<13).map(e=>e.id||e.className)};
          })()`);
          assert.equal(metrics.body,'14px');
          assert.deepEqual(metrics.small,[],`${view}: no undersized text`);
          assert.ok(metrics.overflow<=2,`${size} ${view} horizontal overflow: ${metrics.overflow}`);
          if(view==='settings') {
            assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-view details details').length`),0);
            await win.webContents.executeJavaScript(`selectSettingsPage('settings-report');document.querySelector('#settings-report button[type=submit]').scrollIntoView({block:'end'})`);
            assert.ok(await win.webContents.executeJavaScript(`(() => {const b=document.querySelector('#settings-report button[type=submit]').getBoundingClientRect(),v=document.getElementById('settings-view').getBoundingClientRect();return b.bottom<=v.bottom+1 && b.top>=v.top;})()`),'final save remains reachable');
            await win.webContents.executeJavaScript(`selectSettingsPage('settings-execution');document.querySelector('#model-default-list details').open=true`);
          }
          if(size[0]===1200) {
            await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
            mkdirSync(join(__dirname,'..','output','ui'),{recursive:true});
            writeFileSync(join(__dirname,'..','output','ui',`design-${view}.png`),(await win.webContents.capturePage()).toPNG());
          }
        }
      }
      assert.deepEqual(errors,[]);
      console.log('Design: readable type scale, four views at three sizes, flat settings and scroll reachability verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--skills')) {
      const wait = async expression => {for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(expression))return;await new Promise(r=>setTimeout(r,30));}assert.fail(expression);};
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('settings-skills').parentElement.className`),'settings-page-content');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.settings-pages').parentElement.id`),'settings-view');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-rules #settings-skills, #settings-view details details').length`),0);
      await win.webContents.executeJavaScript(`showView('settings'); selectSettingsPage('settings-skills')`);
      const bundledSkillCount = (await managedSkills.list()).skills.length;
      await wait(`document.querySelectorAll('#skill-list option').length===${bundledSkillCount}`);
      await win.webContents.executeJavaScript(`document.getElementById('skill-new').click(); document.getElementById('skill-id').value='fixture-ui'; document.getElementById('skill-content').value='---\\nname: fixture-ui\\ndescription: UI check\\n---\\n\\nRun known checks.\\n'; document.getElementById('skill-content').dispatchEvent(new Event('input')); document.getElementById('skill-save').click(); document.getElementById('skill-content').value+='More edits'; document.getElementById('skill-content').dispatchEvent(new Event('input'))`);
      await wait(`document.getElementById('skill-message').textContent.includes('追加した編集')`);
      assert.match(await win.webContents.executeJavaScript(`document.getElementById('skill-content').value`),/More edits/);
      await win.webContents.executeJavaScript(`document.getElementById('skill-save').click()`);
      await wait(`document.getElementById('skill-message').textContent.startsWith('保存版') && !document.getElementById('skill-save').disabled`);
      await win.webContents.executeJavaScript(`document.getElementById('skill-status').value='validated'; document.getElementById('skill-evidence').value='正常・異常・適用外を検証'; document.getElementById('skill-evidence').dispatchEvent(new Event('input')); document.getElementById('skill-save').click()`);
      await wait(`document.getElementById('skill-list').selectedOptions[0]?.textContent.includes('採用済み') && !document.getElementById('skill-save').disabled`);
      await win.webContents.executeJavaScript(`document.getElementById('skill-history').click()`);
      await wait(`document.querySelectorAll('#skill-version option').length>=2`);
      const fixture=await managedSkills.get('fixture-ui');assert.equal(fixture.status,'validated');assert.match(fixture.content,/More edits/);
      for(const size of [[1200,780],[880,600]]){win.setSize(...size);await new Promise(r=>setTimeout(r,80));assert.ok(await win.webContents.executeJavaScript(`document.getElementById('skill-content').getBoundingClientRect().width>150`));assert.ok(await win.webContents.executeJavaScript(`document.getElementById('skill-list').getBoundingClientRect().top-document.querySelector('.skill-manager-grid').getBoundingClientRect().top<60`));}
      console.log('Skill manager registration, adoption, history, responsive editor and save-during-edit verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--hpc')) {
      const wait = async expression => {
        for (let i=0;i<100;i++) { if (await win.webContents.executeJavaScript(expression)) return; await new Promise(r=>setTimeout(r,30)); }
        assert.fail(expression);
      };
      const {hpcOperation}=require('../dist/core/hpc');
      writeFileSync(join(directory,'kernel.f90'),'! fixture\n');
      await hpcOperation(hpcContext,{action:'define',unit:{id:'kernel',title:'配列演算の移行',files:['kernel.f90'],dependsOn:[],policyNote:'approved exact result',cases:['reference','replay','unit','integration'].map(stage=>({id:stage,stage,absolute:0,relative:0}))}});
      await win.webContents.executeJavaScript(`state.tasks[0].workPreset=structuredClone(presetCatalog.presets.find(p=>p.manifest.id==='hpc-refactoring'));state.selectedTaskPanels.set(state.tasks[0].id,'hpc');renderDetail()`);
      await wait(`document.querySelector('.hpc-view')?.textContent.includes('配列演算の移行')`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.hpc-view').textContent`),/未検証/);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('[aria-label="成果・検証の表示内容"] option')].some(b=>b.textContent==='移行・検証・ジョブ')`),true);
      await win.webContents.executeJavaScript(`{ const input=document.querySelector('[aria-label="最大投入ジョブ数"]'); input.value='2';input.dispatchEvent(new Event('input')); [...document.querySelectorAll('.hpc-view button')].find(b=>b.textContent==='資源予算を保存').click(); }`);
      await wait(`document.querySelector('.hpc-view [role="status"]').textContent==='更新しました。'`);
      assert.equal((await hpcOperation(hpcContext,{action:'snapshot'})).budget.jobs,2);
      // Draft text survives task-detail refreshes; tables render untrusted text as textContent.
      await win.webContents.executeJavaScript(`{ const input=document.querySelector('[aria-label="単位名"]');input.value='<img onerror=bad>未保存';input.dispatchEvent(new Event('input'));renderDetail(); }`);
      await wait(`document.querySelector('[aria-label="単位名"]')?.value==='<img onerror=bad>未保存'`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.hpc-view img').length`),0);
      for(const height of [620,900]) {win.setSize(1200,height);await new Promise(r=>setTimeout(r,50));assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.task-panel-content.hpc')).overflowY`),'auto');}
      assert.deepEqual(errors,[]);console.log('HPC task tab, ledger, budget save, draft retention and scroll verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--sliders')) {
      const wait = async expression => {
        for (let i=0;i<100;i++) { if (await win.webContents.executeJavaScript(expression)) return; await new Promise(r=>setTimeout(r,30)); }
        assert.fail(expression);
      };
      await win.webContents.executeJavaScript(`document.getElementById('nav-usage').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-view details details').length`),0,'all settings disclosures have exactly one level');
      await win.webContents.executeJavaScript(`document.getElementById('settings-models').scrollIntoView({block:'start'})`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-models details:not(.model-default-row):not(#settings-benchmarks)').length`),0,'service and benchmark disclosures stay flat');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-models details[open]').length`),0,'services start compact');
      await win.webContents.executeJavaScript(`document.querySelector('#model-default-list > details[data-agent-id="codex"] > summary').click()`);
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('[data-service-usage="codex"] input[type=range]').checkVisibility()`));
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('#model-default-list > [data-agent-id="codex"] .model-picker select').checkVisibility()`));
      await win.webContents.executeJavaScript(`document.querySelector('[data-service-enabled="codex"]').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#model-default-list > [data-agent-id="codex"]').open`),true,'availability toggle must not collapse service');
      await win.webContents.executeJavaScript(`document.querySelector('[data-service-enabled="codex"]').click();document.getElementById('open-service-settings-help').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('service-settings-help').open`),true);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#service-settings-help details').length`),0);
      await win.webContents.executeJavaScript(`document.querySelector('#service-settings-help button').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('settings-models').tagName`),'SECTION');
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('settings-routing').closest('details')`),null);
      assert.ok(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-service-usage] .policy-limit').length>=2`));
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.policy-budget, .threshold-row input[type=range]').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#orchestration-settings-form input[type=number], #execution-settings-editor input[type=number], .policy-priority').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#execution-settings-editor select[aria-label="最大同時実行数"] option').length`),8);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.token-budget-guide')`),null);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('#execution-settings-editor').textContent`),/品質と完了までの速さ/);
      await win.webContents.executeJavaScript(`{for(const [id,value] of [['codex','80'],['claude','90']]){const s=document.querySelector('[data-service-usage="'+id+'"] input[type=range]');s.value=value;s.dispatchEvent(new Event('input',{bubbles:true}));}}`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('[data-service-usage="codex"] .policy-budget-hint').textContent`),/20%/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('[data-service-limit="codex"]').textContent`),/80%/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-service-usage="claude"] output').value`),'90%');
      await win.webContents.executeJavaScript(`document.querySelector('#model-default-list > details[data-agent-id="codex"] > summary').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#model-default-list > [data-agent-id="codex"]').open`),false);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-service-usage="codex"] input[type=range]').checkVisibility()`),false);
      await win.webContents.executeJavaScript(`document.getElementById('nav-usage').click()`);
      assert.equal(await win.webContents.executeJavaScript(`state.currentView`),'usage');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-service-usage="codex"] .policy-limit').value`),'80','collapsing and navigating preserves unsaved usage');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#model-default-list > [data-agent-id="codex"]').open`),false,'navigation preserves closed cards');
      await win.webContents.executeJavaScript(`document.querySelector('#model-default-list > details[data-agent-id="codex"] > summary').click()`);
      await win.webContents.executeJavaScript(`renderOrchestrationSettings();document.getElementById('orchestration-settings-form').requestSubmit()`);
      await wait(`!routingSettingsSaving`);
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='codex').usageLimitPercent,80);
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='claude').usageLimitPercent,90);
      assert.ok(routingSaved.agentPolicies.every(p=>p.softTokenBudget===undefined));
      // Rebuilding model cards must preserve an unsaved usage slider too.
      await win.webContents.executeJavaScript(`{const s=document.querySelector('[data-service-usage="codex"] input[type=range]');s.value='75';s.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('model-default-form').requestSubmit();}`);
      await wait(`!document.getElementById('save-model-defaults').disabled`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-service-usage="codex"] .policy-limit').value`),'75');
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('[data-service-limit="codex"]').textContent`),/75%/);
      await win.webContents.executeJavaScript(`document.getElementById('nav-settings').click();document.getElementById('settings-execution').open=true`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#execution-settings-editor input[aria-label="トークン予算目安"]')`),null);
      await win.webContents.executeJavaScript(`{const c=document.querySelector('#execution-settings-editor input[aria-label^="会話を切り替える文脈量"]');c.closest('.settings-slider').querySelector('button').click();document.querySelector('#execution-settings-editor fieldset > button').click();}`);
      for (let i=0;i<100&&!executionDefaultsSaved;i++) await new Promise(r=>setTimeout(r,30));
      assert.ok(executionDefaultsSaved);
      assert.equal(executionDefaultsSaved.contextTokens,undefined);
      for (const size of [[1100,620],[1400,900]]) {
        win.setContentSize(...size);await new Promise(r=>setTimeout(r,50));
        await win.webContents.executeJavaScript(`showView('settings')`);
        assert.ok(await win.webContents.executeJavaScript(`(() => {const r=document.querySelector('#execution-settings-editor [aria-label="最大同時実行数"]').getBoundingClientRect();return r.height<=40&&r.width<=140;})()`),'parallel selector must stay compact');
        await win.webContents.executeJavaScript(`showView('usage');document.querySelector('#orchestration-settings-form button[type=submit]').scrollIntoView({block:'center'})`);
        assert.ok(await win.webContents.executeJavaScript(`(() => {const b=document.querySelector('#orchestration-settings-form button[type=submit]').getBoundingClientRect(),v=document.getElementById('usage-view').getBoundingClientRect();return b.top>=v.top-2&&b.bottom<=v.bottom+2;})()`));
      }
      await win.webContents.executeJavaScript(`document.getElementById('nav-usage').click();document.querySelector('#settings-models').scrollIntoView({block:'start'})`);
      await new Promise(r=>setTimeout(r,400));
      writeFileSync(join(__dirname,'..','output/pdf/settings-sliders-smoke.png'),(await win.webContents.capturePage()).toPNG());
      assert.deepEqual(errors,[]);console.log('Settings sliders: subscription percentages, telemetry-only tokens, unset context, draft/save and responsive scroll passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--models')) {
      await win.webContents.executeJavaScript(`state.orchestrationSettings.agentPolicies.find(p=>p.agentId==='claude').defaultModel='opus'`);
      const wait = async expression => {
        for (let i=0;i<100;i++) { if (await win.webContents.executeJavaScript(expression)) return; await new Promise(r=>setTimeout(r,30)); }
        assert.fail(expression);
      };
      await win.webContents.executeJavaScript(`state.orchestrationSettings.agentPolicies.push({agentId:'opencode',enabled:true,providerKey:'ollama-cloud',providerLabel:'Ollama',authMode:'subscription',priority:60,codingPlan:'ollama-app',defaultModel:'ollama/deepseek-v4.1-flash:cloud'}); renderOrchestrationSettings(); showView('usage'); document.getElementById('service-opencode').open=true; showView('settings'); selectSettingsPage('settings-benchmarks')`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#settings-benchmarks details')`),null);
      assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#settings-benchmarks .checkbox-label')).display`),'flex');
      await wait(`document.getElementById('benchmark-status').textContent.includes('未登録')`);
      await win.webContents.executeJavaScript(`{const k=document.querySelector('#settings-benchmarks input[type=password]');k.value='fixture-key';k.dispatchEvent(new Event('input'));document.getElementById('benchmark-enabled').checked=true;document.querySelector('#settings-benchmarks form').requestSubmit();}`);
      await wait(`document.getElementById('benchmark-status').textContent.includes('1モデル')`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#settings-benchmarks input[type=password]').value`),'');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.benchmark-table tbody tr td:nth-child(3)').textContent`),'80');
      const originalBenchmarkModels=benchmarkState.models;
      benchmarkState.models=[...originalBenchmarkModels,
        {id:'gpt-6-astra',name:'GPT-6 Astra (max)',intelligence:53},
        {id:'gpt-6-astra-low',name:'GPT-6 Astra (low)',intelligence:46},
        {id:'claude-fable-5-1',name:'Claude Fable 5.1 (Adaptive Reasoning, Max Effort, Default Fallback)',coding:82},
        {id:'claude-fable-5-1-low',name:'Claude Fable 5.1 (Adaptive Reasoning, Low Effort, Default Fallback)',coding:74}];
      const referenceLabels=await win.webContents.executeJavaScript(`(async()=>{
        const labels=[];for(const model of ['gpt-6-astra','fable']){const label=document.createElement('span');await updateBenchmarkLabel(label,model);labels.push({text:label.textContent,title:label.title});}return labels;
      })()`);
      assert.match(referenceLabels[0].text,/評価条件別.*46–53/);
      assert.match(referenceLabels[1].text,/Claude Fable 5.1（別名・最新掲載版）.*74–82/);
      assert.match(referenceLabels[1].title,/一致は未確認/);
      assert.match(referenceLabels[1].title,/claude-fable-5-1-low/);
      benchmarkState.models=originalBenchmarkModels;
      await win.webContents.executeJavaScript(`benchmarkSnapshot.models.push({id:'speed-fixture',name:'Fast fixture',intelligence:50,coding:30,agentic:40,tokensPerSecond:900});{const s=document.querySelector('[aria-label="モデル能力の並べ替え"]');s.value='tokensPerSecond';s.dispatchEvent(new Event('change'));}`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.benchmark-table tbody tr td').textContent`),'Fast fixture');
      await win.webContents.executeJavaScript(`benchmarkSnapshot.models.pop();document.querySelector('[aria-label="モデル能力の並べ替え"]').dispatchEvent(new Event('change'))`);
      assert.ok(await win.webContents.executeJavaScript(`(async()=>{const label=document.createElement('small');await updateBenchmarkLabel(label,'sonnet');return label.textContent.includes('CLI既定・別名');})()`));
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="ベンチマークのモデルを検索"]').value='missing';document.querySelector('[aria-label="ベンチマークのモデルを検索"]').dispatchEvent(new Event('input'))`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.benchmark-table tbody tr').length`),0);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="ベンチマークのモデルを検索"]').value='';document.querySelector('[aria-label="ベンチマークのモデルを検索"]').dispatchEvent(new Event('input'))`);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('#settings-benchmarks button')].find(b=>b.textContent==='キーを削除…').click()`);
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.benchmark-guidance').textContent.includes('削除を確定しますか')`));
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('#settings-benchmarks button')].find(b=>b.textContent==='削除をやめる').click()`);
      assert.ok(await win.webContents.executeJavaScript(`document.getElementById('benchmark-status').textContent.includes('登録済み')`));
      await win.webContents.executeJavaScript(`{const key=document.getElementById('benchmark-key');key.value='replacement';key.dispatchEvent(new Event('input'));document.querySelector('#settings-benchmarks form').requestSubmit();key.value='later-draft';key.dispatchEvent(new Event('input'));}`);
      await wait(`!document.querySelector('#settings-benchmarks button[type=submit]').disabled`);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('benchmark-key').value`),'later-draft','typing during save survives the response');
      assert.ok(await win.webContents.executeJavaScript(`document.getElementById('benchmark-status').textContent.includes('未保存')`));
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('#settings-benchmarks button')].find(b=>b.textContent==='編集を取り消す').click()`);
      win.setSize(980,640);
      await win.webContents.executeJavaScript(`document.getElementById('settings-benchmarks').scrollIntoView({block:'start'})`);
      assert.ok(await win.webContents.executeJavaScript(`(()=>{const panel=document.querySelector('.benchmark-settings');return panel.scrollWidth<=panel.clientWidth+2;})()`),'benchmark form fits the compact window');
      writeFileSync(join(__dirname,'..','output/pdf/benchmark-settings-review.png'),(await win.webContents.capturePage()).toPNG());
      win.setSize(1200,780);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('settings-benchmarks').textContent.includes('fixture-key')`),false);
      await wait(`document.querySelectorAll('#model-default-list .model-picker').length===3`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#model-default-list [data-agent-id="opencode"]').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('glm-model').value`),'ollama/deepseek-v4.1-flash:cloud');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-models #glm-form').length`),1);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-routing #orchestration-settings-form').length`),1);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-view #settings-models, #settings-login input, #settings-login select').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-index').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('settings-view').textContent.includes('変更は各欄で保存')`),false);
      await win.webContents.executeJavaScript(`initializeSettingsLayout();showView('settings')`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-page-nav [role=tab]').length`),8,'reinitializing does not duplicate tabs or controls');
      assert.ok(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.settings-page > h2')].every(e=>getComputedStyle(e).fontSize===getComputedStyle(document.querySelector('.settings-page > h2')).fontSize)`),'page headings share the same typography');
      assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#settings-models > h2 span')).fontSize`),'13px','descriptions retain a readable compact size');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-view > details').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.policy-provider-key,.policy-auth,.policy-provider-label,#execution-target').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#tex-command').closest('details').id`),'settings-report');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[aria-label="最大分担数"]').closest('.settings-page').id`),'settings-execution');
      await win.webContents.executeJavaScript(`showView('usage')`);
      await win.webContents.executeJavaScript(`{const c=document.querySelector('[data-service-enabled="claude"]');c.checked=false;c.dispatchEvent(new Event('change'));}`);
      await win.webContents.executeJavaScript(`document.getElementById('nav-usage').click();document.getElementById('warning-percent').value='67';document.getElementById('warning-percent').dispatchEvent(new Event('input',{bubbles:true}));renderOrchestrationSettings()`);
      assert.equal(await win.webContents.executeJavaScript(`state.currentView`),'usage');
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('settings-routing').closest('details')`),null);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('warning-percent').value`),'67','refresh preserves routing drafts');
      await win.webContents.executeJavaScript(`document.getElementById('settings-models').scrollIntoView({block:'start'})`);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('#settings-models button')].some(b=>b.textContent==='Geminiログイン管理')`),false);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#task-agent-pool [data-agent-id="gemini"]')===null`),true);
      const row = `document.querySelector('#model-default-list [data-agent-id="codex"]')`;
      await win.webContents.executeJavaScript(`${row}.querySelector('.model-picker button').click()`);
      await wait(`${row}.querySelector('select').options.length===2`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-models option[value="__manual__"]').length`),0,'system settings do not offer manual model IDs');
      assert.ok(await win.webContents.executeJavaScript(`[...document.querySelectorAll('#model-default-list input[type=text]')].every(i=>i.hidden)`),'model value holders stay hidden');
      assert.ok(await win.webContents.executeJavaScript(`!!document.querySelector('#task-agent-pool option[value="__manual__"]')`),'task-specific overrides are unaffected');
      await win.webContents.executeJavaScript(`{const s=${row}.querySelector('select');s.value='codex-test';s.dispatchEvent(new Event('change'));}`);
      await win.webContents.executeJavaScript(`${row}.querySelector('.model-picker button').click()`);
      await wait(`${row}.textContent.includes('catalog unavailable')`);
      assert.equal(await win.webContents.executeJavaScript(`${row}.querySelector('input[type=text]').value`),'codex-test');
      await win.webContents.executeJavaScript(`document.getElementById('service-opencode').open=false`);
      await new Promise(r=>setTimeout(r,50));
      await win.webContents.executeJavaScript(`document.getElementById('service-opencode').open=true`);
      await new Promise(r=>setTimeout(r,50));
      assert.equal(await win.webContents.executeJavaScript(`${row}.querySelector('input[type=text]').value`),'codex-test');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#model-default-list [data-agent-id="claude"] select').value`),'opus','saved ID absent from catalog is retained');
      await win.webContents.executeJavaScript(`document.getElementById('model-default-form').requestSubmit()`);
      await wait(`!routingSettingsSaving`);
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='codex').defaultModel,'codex-test');
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='claude').defaultModel,'opus');
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='antigravity').defaultModel,undefined);
      assert.equal(modelSaveCalls,0,'model/toggle/usage are persisted in one settings write');
      assert.equal(await win.webContents.executeJavaScript(`state.orchestrationSettings.agentPolicies.find(p=>p.agentId==='claude').enabled`),false);
      assert.equal(await win.webContents.executeJavaScript(`collectPolicies().find(p=>p.agentId==='claude').enabled`),false,'routing draft must not overwrite service toggle');
      assert.equal(await win.webContents.executeJavaScript(`collectPolicies().find(p=>p.agentId==='opencode').providerKey`),'ollama-cloud');
      assert.equal(await win.webContents.executeJavaScript(`state.orchestrationSettings.agentPolicies.find(p=>p.agentId==='opencode').defaultModel`),'ollama/deepseek-v4.1-flash:cloud','other models cannot overwrite the OpenCode provider model');
      await win.webContents.executeJavaScript(`renderOrchestrationSettings()`);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('warning-percent').value`),'67');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#task-agent-pool [data-agent-id="codex"] select').options[0].textContent`),'既定 · codex-test');
      await new Promise(r=>setTimeout(r,150));
      writeFileSync(join(__dirname,'..','output/pdf/model-settings-smoke.png'),(await win.webContents.capturePage()).toPNG());
      // Clear to CLI default and round-trip again.
      await win.webContents.executeJavaScript(`{const s=${row}.querySelector('select');s.value='';s.dispatchEvent(new Event('change'));}document.getElementById('model-default-form').requestSubmit()`);
      await wait(`!routingSettingsSaving`);
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='codex').defaultModel,undefined);
      // Keep selecting while persistence is pending; late input remains a draft.
      delayRoutingSave = true; releaseRoutingSave=undefined;
      const callsBefore = routingSaveCalls;
      await win.webContents.executeJavaScript(`document.getElementById('model-default-form').requestSubmit();document.getElementById('model-default-form').requestSubmit()`);
      for (let i=0;i<100&&!releaseRoutingSave;i++) await new Promise(r=>setTimeout(r,20));
      assert.equal(routingSaveCalls,callsBefore+1,'duplicate pending saves are ignored');
      await win.webContents.executeJavaScript(`{const select=${row}.querySelector('select');select.value='codex-test';select.dispatchEvent(new Event('change'));}`);
      assert.equal(typeof releaseRoutingSave,'function'); releaseRoutingSave(); delayRoutingSave=false;
      await wait(`!routingSettingsSaving`);
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='codex').defaultModel,undefined);
      assert.equal(await win.webContents.executeJavaScript(`${row}.querySelector('input[type=text]').value`),'codex-test');
      assert.match(await win.webContents.executeJavaScript(`document.getElementById('model-default-status').textContent`),/未保存/);
      await win.webContents.executeJavaScript(`document.getElementById('model-default-form').requestSubmit()`);
      await wait(`!routingSettingsSaving`);
      assert.equal(routingSaved.agentPolicies.find(p=>p.agentId==='codex').defaultModel,'codex-test');

      delayRoutingSave=true;releaseRoutingSave=undefined;
      const beforeRouting=routingSaveCalls;
      await win.webContents.executeJavaScript(`document.getElementById('orchestration-settings-form').requestSubmit();document.getElementById('orchestration-settings-form').requestSubmit()`);
      for (let i=0;i<100&&!releaseRoutingSave;i++) await new Promise(r=>setTimeout(r,20));
      assert.equal(routingSaveCalls,beforeRouting+1);
      await win.webContents.executeJavaScript(`document.getElementById('warning-percent').value='68';document.getElementById('warning-percent').dispatchEvent(new Event('input',{bubbles:true}))`);
      assert.equal(typeof releaseRoutingSave,'function'); releaseRoutingSave(); delayRoutingSave=false;
      await wait(`!routingSettingsSaving`);
      assert.equal(routingSaved.warningPercent,67);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('warning-percent').value`),'68');
      assert.equal(await win.webContents.executeJavaScript(`routingSettingsDirty`),true);
      await win.webContents.executeJavaScript(`document.getElementById('orchestration-settings-form').requestSubmit()`);
      await wait(`!routingSettingsSaving`);
      assert.equal(routingSaved.warningPercent,68);
      assert.equal(await win.webContents.executeJavaScript(`routingSettingsDirty`),false);
      assert.deepEqual(errors,[]);
      console.log('Model selectors: catalog, manual/default, failed refresh, draft retention, persistence, Gemini retirement passed');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    if (process.argv.includes('--execution-resources')) {
      const wait = async expression => {
        for (let i=0;i<100;i++) { if (await win.webContents.executeJavaScript(expression)) return; await new Promise(r=>setTimeout(r,30)); }
        assert.fail(expression);
      };
      await win.webContents.executeJavaScript(`document.getElementById('nav-usage').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#resource-grid details').length`),2);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#resource-grid details[open]').length`),0);
      await win.webContents.executeJavaScript(`document.querySelector('#resource-grid summary').click(); renderResources()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#resource-grid details[open]').length`),1);
      await win.webContents.executeJavaScript(`document.querySelector('#resource-grid summary').click(); renderResources()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#resource-grid details[open]').length`),0);
      goalTask = await win.webContents.executeJavaScript(`(() => {
        Object.assign(state.agents.find(a=>a.id==='antigravity'),{label:'Antigravity CLI',command:'agy'}); renderAgents();
        const t=state.tasks[0]; t.state='paused'; showView('tasks'); state.selectedTaskPanels.set(t.id,'execution'); renderDetail();
        return t;
      })()`);
      assert.doesNotMatch(await win.webContents.executeJavaScript(`document.getElementById('task-agent-pool').textContent`),/Gemini CLI/);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.agent-terminal-tab')].find(b=>b.textContent==='Antigravity CLI').click()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.terminal-empty').textContent`),/利用CLIに含まれていません/);
      await win.webContents.executeJavaScript(`document.querySelector('.terminal-empty button').click()`);
      await wait(`document.querySelector('.terminal-empty').textContent.includes('利用候補')`);
      assert.equal(allowedAgentSaves,1);
      assert.equal(await win.webContents.executeJavaScript(`state.tasks[0].state`),'paused');
      // A run starts later: the same tab must become an actual native PTY, not a log view.
      await win.webContents.executeJavaScript(`state.tasks[0].runs.find(r=>r.id==='run-2').agentId='antigravity'; renderDetail()`);
      await wait(`document.querySelector('.interactive-terminal[data-run-id="run-2"] .xterm') !== null`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.agent-terminal-pane').dataset.inputMode`),'対話端末');
      // Empty workflow and legacy logs must also handle a never-run CLI safely.
      for (const legacy of [true, false]) {
        await win.webContents.executeJavaScript(`state.tasks[0].runs=${legacy ? "[{id:'legacy',agentId:'codex',state:'completed',role:'worker',output:'saved log'}]" : '[]'};renderDetail()`);
        assert.match(await win.webContents.executeJavaScript(`document.querySelector('.terminal-empty').textContent`),/利用候補/);
      }
      await win.webContents.executeJavaScript(`state.tasks[0].allowedAgentIds=['codex','claude'];state.tasks[0].state='running';renderDetail()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.terminal-empty button').disabled`),true);
      assert.deepEqual(errors,[]);
      console.log('Resources collapsed/refresh and unassigned/pending/live/legacy Antigravity terminal tabs passed');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    if (process.argv.includes('--login-controls-only')) {
      const wait = async expression => {
        for(let i=0;i<100;i++) {if(await win.webContents.executeJavaScript(expression))return;await new Promise(r=>setTimeout(r,30));}
        assert.fail(expression);
      };
      const button=label=>`[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent===${JSON.stringify(label)})`;
      const click=label=>win.webContents.executeJavaScript(`${button(label)}.click()`);
      const actions=()=>win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog > .detail-actions button')].filter(b=>!b.hidden).map(b=>b.textContent)`);
      for(const provider of ['claude','codex','opencode']) {
        const prefix=provider==='claude'?'login':`${provider}-login`;
        let starts=0,closes=0,refreshes=0,mode='live';
        ipcMain.handle(`fixture:${prefix}-status`,()=>({loggedIn:true,detail:'CLIのログイン設定を確認しました。'}));
        ipcMain.handle(`fixture:${prefix}-start`,()=>{starts++;return `${provider}-controls-fixture`;});
        ipcMain.handle(`fixture:${prefix}-snapshot`,()=>({data:'Native CLI fixture\r\n',offset:20,alive:mode==='live',exitCode:mode==='success'?0:1}));
        ipcMain.handle(`fixture:${prefix}-input`,()=>{});
        if(provider!=='opencode') {
          ipcMain.handle(`fixture:${prefix}-close`,()=>{closes++;});
          ipcMain.handle(`fixture:${prefix}-refresh`,()=>{refreshes++;return [];});
        }
        const beforeDetect=detectionChecks;
        await win.webContents.executeJavaScript(`showCliLogin(${JSON.stringify(provider)},'zai')`);
        await wait(`!${button('状態を更新')}.disabled`);
        assert.equal(detectionChecks,beforeDetect+1);
        assert.equal(starts,0,'opening a status screen never starts authentication');
        assert.deepEqual(await actions(),['CLIを開く','状態を更新','閉じる']);
        assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.login-usage-setup').hidden`),true);
        await win.webContents.executeJavaScript(`{const b=${button('状態を更新')};b.click();b.click()}`);
        await wait(`!${button('状態を更新')}.disabled`);
        assert.equal(detectionChecks,beforeDetect+2,'update cannot run twice at once');
        assert.equal(refreshes,provider==='opencode'?0:1,'one update combines status and usage');
        await click('CLIを開く');
        await wait(`document.querySelector('.login-terminal .xterm')!==null`);
        assert.equal(starts,1);
        assert.deepEqual(await actions(),['CLIを開く','状態を更新','端末を終了','閉じる']);
        await win.webContents.executeJavaScript(`window.confirm=()=>false;void 0`);
        await click('閉じる');
        assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('.claude-login-dialog')`),true,'active login cannot be closed without confirmation');
        assert.equal(closes,0);
        await win.webContents.executeJavaScript(`window.confirm=()=>true;void 0`);
        await click('端末を終了');
        await wait(`document.querySelector('.claude-login-dialog [role="status"]').textContent.includes('端末を終了しました')`);
        assert.deepEqual(await actions(),['CLIを開く','状態を更新','閉じる']);
        mode='success';
        await click('CLIを開く');
        await wait(`!${button('CLIを開く')}.disabled`);
        assert.equal(starts,2);
        assert.equal(refreshes,provider==='opencode'?0:2,'successful Codex/Claude login automatically refreshes usage');
        mode='failure';
        await click('CLIを開く');
        await wait(`document.querySelector('.claude-login-dialog [role="status"]').textContent.includes('終了コード 1')`);
        assert.equal(refreshes,provider==='opencode'?0:2,'failed login never retries the usage API');
        await click('閉じる');
        await wait(`!document.querySelector('.claude-login-dialog')`);
      }
      await win.webContents.executeJavaScript(`showCliLogin('opencode','ollama-app')`);
      await wait(`!${button('状態を更新')}.disabled`);
      assert.deepEqual(await actions(),['CLIを開く','状態を更新','閉じる'],'Ollama-managed authentication opens the actual CLI, not another API-key login');
      await click('閉じる');
      assert.deepEqual(errors,[]);
      console.log('CLI login controls: automatic detection, combined update, safe stop/close, successful and failed login, Ollama reuse passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--antigravity-login')) {
      const wait = async expression => {
        for (let i=0;i<100;i++) { if (await win.webContents.executeJavaScript(expression)) return; await new Promise(r=>setTimeout(r,30)); }
        assert.fail(expression);
      };
      const button = label => `[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent===${JSON.stringify(label)})`;
      const openAntigravity = `showView('usage'); serviceEnvironment='local'; renderResources(); openServiceSettings('antigravity'); document.querySelector('[data-service-status="antigravity"] .detail-actions button:last-child').click()`;
      await win.webContents.executeJavaScript(openAntigravity);
      await wait(`document.querySelector('.claude-login-dialog [role="status"]').textContent.includes('APIキー方式')`);
      assert.equal(await win.webContents.executeJavaScript(`${button('CLIを開く')}.disabled`),true);
      assert.equal(detectionChecks,1,'opening the screen automatically detects the CLI');
      const visibleActions=()=>win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog > .detail-actions button')].filter(b=>!b.hidden).map(b=>b.textContent)`);
      assert.deepEqual(await visibleActions(),['CLIを開く','状態を更新','閉じる']);
      assert.equal(agyInstalls,0,'viewing first-use guidance never modifies CLI settings');
      assert.equal(await win.webContents.executeJavaScript(`${button('使用量表示を設定')}.hidden`),false);
      assert.equal(agyStarts,0);
      failDetection=true;
      await win.webContents.executeJavaScript(`${button('状態を更新')}.click()`);
      await wait(`document.querySelector('.claude-login-dialog [role="alert"]').textContent.includes('状態確認に失敗')`);
      assert.equal(await win.webContents.executeJavaScript(`${button('状態を更新')}.disabled`),false);
      failDetection=false;
      agyBlocked=false;
      const beforeChecks=detectionChecks;
      await win.webContents.executeJavaScript(`{const b=${button('状態を更新')};b.click();b.click()}`);
      await wait(`!${button('CLIを開く')}.disabled`);
      assert.equal(detectionChecks,beforeChecks+1,'repeated clicks cannot duplicate detection or usage requests');
      assert.equal(agyRefreshes,1,'one update refreshes authentication and recorded usage together');
      assert.equal(agyStarts,0,'status checking cannot start authentication');
      await win.webContents.executeJavaScript(`${button('CLIを開く')}.click()`);
      await wait(`document.querySelector('.login-terminal .xterm') !== null`);
      assert.deepEqual(await visibleActions(),['CLIを開く','状態を更新','端末を終了','閉じる']);
      assert.equal(await win.webContents.executeJavaScript(`${button('使用量表示を設定')}.disabled`),true,'never replace CLI display settings during a live session');
      await win.webContents.executeJavaScript(`document.querySelector('.login-terminal .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'g',code:'KeyG',keyCode:71,bubbles:true}))`);
      await new Promise(r=>setTimeout(r,100)); assert.ok(agyInput.includes('g')); assert.equal(agyStarts,1);
      agyIssue={code:'authentication-failed',message:'認証に失敗しました。CLI画面を確認してください。'};
      await wait(`document.querySelector('.claude-login-dialog [role="status"]').textContent.includes('認証エラー')`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.claude-login-dialog [role="alert"]').textContent`),/認証に失敗/);
      const sizes=[];
      for (const [width,height,zoom] of [[980,620,1],[1180,780,1],[1500,1000,1],[980,620,1.25]]) {
        win.setContentSize(width,height); win.webContents.setZoomFactor(zoom);
        await new Promise(r=>setTimeout(r,250));
        const layout=await win.webContents.executeJavaScript(`(() => {
          const rect=s=>document.querySelector(s).getBoundingClientRect();
          const dialog=rect('.cli-terminal-dialog'), output=rect('.login-terminal'), screen=rect('.login-terminal .xterm-screen'), actions=rect('.cli-terminal-dialog > .detail-actions');
          return {height:innerHeight,dialogTop:dialog.top,dialogBottom:dialog.bottom,outputTop:output.top,outputBottom:output.bottom,screenBottom:screen.bottom,actionsTop:actions.top,actionsBottom:actions.bottom,outputHeight:output.height};
        })()`);
        assert.ok(layout.dialogTop>=0 && layout.dialogBottom<=layout.height,JSON.stringify(layout));
        assert.ok(layout.actionsBottom<=layout.height && layout.actionsTop>=layout.outputBottom-1,JSON.stringify(layout));
        assert.ok(layout.screenBottom<=layout.outputBottom+1 && layout.outputHeight>130,JSON.stringify(layout));
        assert.ok(agySize?.rows>=8); sizes.push({...layout,...agySize});
        await win.webContents.executeJavaScript(`document.querySelector('.login-help').open=true`);
        await new Promise(r=>setTimeout(r,100));
        assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.cli-terminal-dialog > .detail-actions').getBoundingClientRect().bottom <= innerHeight`),true);
        await win.webContents.executeJavaScript(`document.querySelector('.login-help').open=false`);
      }
      assert.ok(sizes[2].rows>sizes[0].rows,'PTY height must grow with the window');
      console.log('Login responsive geometry/PTY rows',sizes);
      win.webContents.setZoomFactor(1);
      await win.webContents.executeJavaScript(`window.confirm=()=>{throw new Error('Close must only detach')}; ${button('閉じる')}.click()`);
      await wait(`!document.querySelector('.claude-login-dialog')`); assert.equal(agyCloses,0);
      await win.webContents.executeJavaScript(openAntigravity);
      await wait(`document.querySelector('.login-terminal .xterm') !== null`);
      assert.equal(agyStarts,1,'reopening attaches the existing terminal without reauth');
      await win.webContents.executeJavaScript(`window.confirm=()=>false; ${button('端末を終了')}.click()`); assert.equal(agyCloses,0);
      // Hold an in-flight response so it arrives only after explicit termination.
      holdAgySnapshot=true;
      for(let i=0;i<100&&!releaseAgySnapshot;i++) await new Promise(r=>setTimeout(r,30));
      assert.ok(releaseAgySnapshot);
      await win.webContents.executeJavaScript(`window.confirm=()=>true; ${button('端末を終了')}.click()`);
      await wait(`document.querySelector('.claude-login-dialog [role="status"]').textContent.includes('端末を終了しました')`);
      assert.equal(agyCloses,1);
      holdAgySnapshot=false; releaseAgySnapshot();
      await new Promise(r=>setTimeout(r,150));
      assert.equal(await win.webContents.executeJavaScript(`${button('端末を終了')}.disabled`),true);
      assert.equal(await win.webContents.executeJavaScript(`${button('端末を終了')}.hidden`),true);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.claude-login-dialog [role="status"]').textContent`),/端末を終了しました/);
      await win.webContents.executeJavaScript(`${button('使用量表示を設定')}.click()`);
      await wait(`document.querySelector('.claude-login-dialog [role="status"]').textContent.includes('使用量表示を設定')`); assert.equal(agyInstalls,1);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.login-usage-setup').hidden`),true,'configured integration has no repeated setup button');
      assert.deepEqual(await visibleActions(),['CLIを開く','状態を更新','閉じる']);
      await win.webContents.executeJavaScript(`${button('閉じる')}.click()`);
      await wait(`!document.querySelector('.claude-login-dialog')`);
      await win.webContents.executeJavaScript(`showCliLogin('antigravity')`);
      await wait(`!${button('状態を更新')}.disabled`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.login-usage-setup').hidden`),true,'reopen reads the persisted integration');
      assert.equal(agyInstalls,1);
      agyUsageState='conflict';
      await win.webContents.executeJavaScript(`${button('状態を更新')}.click()`);
      await wait(`document.querySelector('.login-usage-setup').textContent.includes('既存の表示設定')`);
      assert.equal(await win.webContents.executeJavaScript(`${button('使用量表示を設定')}.hidden`),true,'existing custom settings remain untouched');
      agyUsageState='enabled';
      await win.webContents.executeJavaScript(`${button('状態を更新')}.click()`);
      await wait(`document.querySelector('.login-usage-setup').hidden`);
      win.setContentSize(1100,780);
      writeFileSync(join(__dirname,'..','output/pdf/login-controls-antigravity-smoke.png'),(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`${button('閉じる')}.click()`);
      await win.webContents.executeJavaScript(`state.resources=[{providerKey:'google-antigravity',providerLabel:'Google · Antigravity',agentIds:['antigravity'],authModes:['subscription'],state:'available',totalTokens:0,inputTokens:0,outputTokens:0,runs:0,failures:0,windows:[],models:[],limitSource:'unknown'}];renderResourceSummary()`);
      await wait(`document.querySelector('#resource-summary').textContent.includes('未取得')`);
      await win.webContents.executeJavaScript(`document.querySelector('#resource-summary .resource-summary-item').click()`);
      await wait(`[...document.querySelectorAll('#resource-usage-dialog-body button')].some(b=>b.textContent==='サービスを開く')`);
      await win.webContents.executeJavaScript(`state.resources[0].windows=[{id:'agy:gemini-weekly',label:'Gemini · 週の共有枠',scope:'unknown',usedPercent:25,detail:'残り 75.0% · CLI報告',resetAt:'2026-09-24T11:38:36Z'},{id:'agy:3p-weekly',label:'Claude / GPT · 週の共有枠',scope:'unknown',usedPercent:10,resetAt:'2026-09-24T11:38:36Z'}];state.resources[0].capacityUpdatedAt='2026-09-17T11:38:36Z';state.resources[0].limitSource='reported-live';renderResourceSummary()`);
      await wait(`document.querySelector('#resource-summary').textContent.includes('前回値')`);
      const quotaText=await win.webContents.executeJavaScript(`document.getElementById('resource-usage-dialog-body').textContent`);
      assert.match(quotaText,/Gemini · 週の共有枠/); assert.match(quotaText,/Claude \/ GPT · 週の共有枠/);
      assert.match(quotaText,/残り 75.0%/); assert.match(quotaText,/リセット/); assert.match(quotaText,/取得元：このMac · 2026\/9\/17/);
      assert.deepEqual(errors,[]);
      console.log('Antigravity account preflight, native login input, failure status, safe close and sidebar GUI passed');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-preset').value`), 'research-project');
    assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.getElementById('task-preset').options).map(o=>o.value)`), ['', 'research-project', 'idea', 'research', 'coding', 'hpc-refactoring', 'paper', 'poster', 'paper-explainer']);
    if (process.argv.includes('--ollama-usage-only')) {
      let opened = false, loginStarts = 0;
      const quota = {providerKey:'ollama-cloud',providerLabel:'Ollama Cloud',agentIds:['opencode'],authModes:['subscription'],state:'available',totalTokens:0,inputTokens:0,outputTokens:0,runs:0,failures:0,limitSource:'reported-live',models:[],usedPercent:25,capacityUpdatedAt:'2026-09-16T00:00:00Z',creditBalance:'extra balance: $5.00',windows:[{id:'ollama-monthly',label:'Monthly',usedPercent:25,scope:'shared',resetText:'Resets October 1',detail:'使用 $15.00 / $60.00'}]};
      ipcMain.handle('fixture:ollama-usage-open', () => {opened=true;});
      ipcMain.handle('fixture:ollama-usage-refresh', () => [quota]);
      ipcMain.handle('fixture:opencode-login-start', () => {loginStarts++;return 'not-required';});
      ipcMain.handle('fixture:opencode-login-status', () => ({runtimeReady:true,checkSupported:false,detail:'このMacのOllamaに接続できました。既存ログインを利用します。'}));
      win.show();
      await win.webContents.executeJavaScript(`{
        let policy=state.orchestrationSettings.agentPolicies.find(p=>p.agentId==='opencode');
        if(!policy) {policy={agentId:'opencode',providerLabel:'Ollama Cloud',authMode:'subscription',priority:60};state.orchestrationSettings.agentPolicies.push(policy);}
        Object.assign(policy,{providerKey:'ollama-cloud',codingPlan:'ollama-app',enabled:true});
        state.resources=[${JSON.stringify({...quota,windows:[],usedPercent:undefined,limitSource:'unknown',enabled:true,connected:true,cliInstalled:true,serviceKey:'ollama-cloud',capacityError:'Ollama UsageのWebログインが必要です。',login:{runtimeReady:true,checkSupported:false,checkedAt:new Date().toISOString(),detail:'Ollama接続済み'}})}];
        showView('usage');renderResources();document.getElementById('service-opencode').open=true;
      }`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('[data-service-status="opencode"]').textContent`),/Ollama接続済み.*残量：未確認/s);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-service-status="opencode"] button')].find(b=>b.textContent==='CLIを開く…').click()`);
      await new Promise(r=>setTimeout(r,100));
      assert.equal(loginStarts,0); assert.equal(opened,false,'CLI status does not open a Web login');
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog > .detail-actions button')].find(b=>b.textContent==='CLIを開く').hidden`),false,'Ollama app opens the ordinary OpenCode CLI using existing credentials');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent==='閉じる').click()`);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-service-status="opencode"] button')].find(b=>b.textContent==='残量表示を連携（任意）').click()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.ollama-usage-dialog').textContent`),/CLIの認証・モデル実行には不要/);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.ollama-usage-dialog button')].find(b=>b.textContent==='ログイン・Usage画面を開く').click()`);
      for(let i=0;i<100&&!opened;i++) await new Promise(r=>setTimeout(r,20));
      assert.equal(opened,true);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.ollama-usage-dialog button')].find(b=>b.textContent==='Usageを取得').click()`);
      for(let i=0;i<100&&!await win.webContents.executeJavaScript(`document.querySelector('.ollama-usage-dialog [role="status"]').textContent.includes('25.0%')`);i++) await new Promise(r=>setTimeout(r,20));
      const shown = await win.webContents.executeJavaScript(`document.querySelector('.ollama-usage-dialog [role="status"]').textContent`);
      assert.match(shown,/25.0%/); assert.match(shown,/Resets October 1/); assert.match(shown,/\$5.00/);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.ollama-usage-dialog button')].find(b=>b.textContent==='閉じる').click()`);
      const sidebar = await win.webContents.executeJavaScript(`document.querySelector('[aria-label="利用量ステータス"]').textContent`);
      assert.match(sidebar,/25.0%/); assert.match(sidebar,/Resets October 1/); assert.match(sidebar,/\$5.00/);
      await new Promise(r=>setTimeout(r,200));
      writeFileSync(join(__dirname,'..','output/pdf/ollama-usage-smoke.png'),(await win.webContents.capturePage()).toPNG());
      assert.deepEqual(errors,[]); console.log('Ollama Usage login, refresh and compact sidebar GUI passed');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    if (process.argv.includes('--glm-only') || process.argv.includes('--ollama-only') || process.argv.includes('--ollama-app-only')) {
      let configured, loginPlan;
      ipcMain.handle('fixture:opencode-models', (_e, plan) => plan === 'ollama-app' ? ['ollama/deepseek-v4.1-flash:cloud'] : plan === 'ollama' ? ['ollama-cloud/gpt-oss:120b','ollama-cloud/gemma4:31b'] : ['zai-coding-plan/glm-5.3', 'zai-coding-plan/glm-4.7']);
      ipcMain.handle('fixture:opencode-configure', async (_e, plan, model) => {
        configured = model;
        const settings = await win.webContents.executeJavaScript('structuredClone(state.orchestrationSettings)');
        const { openCodePolicy } = require('../dist/core/opencode');
        const policy = settings.agentPolicies.find(p => p.agentId === 'opencode') ?? { agentId:'opencode',priority:60 };
        settings.agentPolicies = [...settings.agentPolicies.filter(p => p.agentId !== 'opencode'), openCodePolicy(policy, plan, model)];
        return { settings, resources: [] };
      });
      ipcMain.handle('fixture:opencode-login-status', (_e, plan) => { loginPlan = plan; return plan === 'ollama-app' ? {detail:'このMacのOllamaに接続できました。'} : {loggedIn:false,detail:`${plan === 'ollama' ? 'Ollama Cloud' : 'Z.AI Coding Plan'}の認証情報が未登録です。`}; });
      win.show(); win.focus();
      await win.webContents.executeJavaScript(`state.orchestrationSettings.agentPolicies.push({agentId:'opencode',enabled:false,providerKey:'opencode-default',providerLabel:'OpenCode',authMode:'unknown',priority:60})`);
      await win.webContents.executeJavaScript(`document.getElementById('nav-usage').click();document.getElementById('settings-models').scrollIntoView({block:'start'})`);
      await new Promise(r=>setTimeout(r,50));
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-models #glm-form').length`),1);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-login #glm-form').length`),0);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#model-default-list [data-agent-id="opencode"]').length`),0);
      await win.webContents.executeJavaScript(`document.getElementById('glm-load-models').click()`);
      assert.equal(await win.webContents.executeJavaScript(`state.currentView`), 'settings', await win.webContents.executeJavaScript(`document.body.innerText.slice(-2500)`));
      for(let i=0;i<100&&!await win.webContents.executeJavaScript(`document.getElementById('glm-models').options.length===2`);i++)await new Promise(r=>setTimeout(r,20));
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('glm-models').options.length`),2);
      await win.webContents.executeJavaScript(`document.getElementById('glm-model').value='zai-coding-plan/glm-5.3';document.getElementById('glm-form').requestSubmit()`);
      for(let i=0;i<100&&!await win.webContents.executeJavaScript(`document.getElementById('glm-status').textContent.includes('設定しました')`);i++)await new Promise(r=>setTimeout(r,20));
      assert.equal(configured,'zai-coding-plan/glm-5.3');
      assert.equal(await win.webContents.executeJavaScript(`state.orchestrationSettings.agentPolicies.find(p=>p.agentId==='opencode').enabled`),false,'applying a provider must not enable the service');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-service-enabled="opencode"]').checked`),false);
      await win.webContents.executeJavaScript(`document.getElementById('model-default-form').requestSubmit()`);
      for(let i=0;i<100&&await win.webContents.executeJavaScript(`routingSettingsSaving`);i++)await new Promise(r=>setTimeout(r,20));
      assert.equal(routingSaveCalls,1);assert.equal(modelSaveCalls,0);
      assert.equal(await win.webContents.executeJavaScript(`state.orchestrationSettings.agentPolicies.find(p=>p.agentId==='opencode').enabled`),false,'saving service settings after provider application must agree with the checkbox');
      assert.equal(await win.webContents.executeJavaScript(`collectPolicies().find(p=>p.agentId==='opencode').codingPlan`),'zai');
      await win.webContents.executeJavaScript(`document.getElementById('glm-model').value='unsaved';document.getElementById('service-opencode').open=false`);
      await new Promise(r=>setTimeout(r,50));
      await win.webContents.executeJavaScript(`document.getElementById('service-opencode').open=true`);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('glm-model').value`),'unsaved');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('#settings-models button')].find(b=>b.textContent==='OpenCodeログイン管理').click()`);
      for(let i=0;i<100&&!await win.webContents.executeJavaScript(`document.querySelector('.claude-login-dialog [role="status"]').textContent.includes('未登録')`);i++)await new Promise(r=>setTimeout(r,20));
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent==='状態を更新').hidden`),false);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent==='閉じる').click()`);
      if (process.argv.includes('--ollama-only')) {
        const switchPlan = plan => win.webContents.executeJavaScript(`document.getElementById('opencode-provider').value=${JSON.stringify(plan)};document.getElementById('opencode-provider').dispatchEvent(new Event('change'))`);
        await switchPlan('ollama');
        assert.equal(await win.webContents.executeJavaScript(`document.getElementById('glm-model').value`),'');
        assert.equal(await win.webContents.executeJavaScript(`state.orchestrationSettings.agentPolicies.find(p=>p.agentId==='opencode').codingPlan`),'zai','selection is not application');
        // An unsaved provider draft must not silently redirect the general login.
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('#settings-models button')].find(b=>b.textContent==='OpenCodeログイン管理').click()`);
        for(let i=0;i<100&&loginPlan!=='zai';i++)await new Promise(r=>setTimeout(r,20));
        assert.equal(loginPlan,'zai');
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent==='閉じる').click()`);
        for(let i=0;i<100&&await win.webContents.executeJavaScript(`!!document.querySelector('.claude-login-dialog')`);i++)await new Promise(r=>setTimeout(r,20));
        await win.webContents.executeJavaScript(`document.getElementById('opencode-selected-login').click()`);
        for(let i=0;i<100&&loginPlan!=='ollama';i++)await new Promise(r=>setTimeout(r,20));
        assert.equal(loginPlan,'ollama','explicit draft login uses the selected provider');
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent==='閉じる').click()`);
        await win.webContents.executeJavaScript(`document.getElementById('glm-load-models').click()`);
        for(let i=0;i<100&&!await win.webContents.executeJavaScript(`document.getElementById('glm-models').options.length===2`);i++)await new Promise(r=>setTimeout(r,20));
        assert.equal(await win.webContents.executeJavaScript(`document.getElementById('glm-models').options[0].value`),'ollama-cloud/gpt-oss:120b');
        await win.webContents.executeJavaScript(`document.getElementById('glm-model').value='ollama-cloud/gpt-oss:120b'`);
        await switchPlan('zai'); assert.equal(await win.webContents.executeJavaScript(`document.getElementById('glm-model').value`),'unsaved');
        await switchPlan('ollama'); assert.equal(await win.webContents.executeJavaScript(`document.getElementById('glm-model').value`),'ollama-cloud/gpt-oss:120b');
        await win.webContents.executeJavaScript(`document.getElementById('glm-form').requestSubmit()`);
        for(let i=0;i<100&&!await win.webContents.executeJavaScript(`collectPolicies().find(p=>p.agentId==='opencode').codingPlan==='ollama'`);i++)await new Promise(r=>setTimeout(r,20));
        assert.equal(configured,'ollama-cloud/gpt-oss:120b');
        assert.equal(await win.webContents.executeJavaScript(`state.orchestrationSettings.agentPolicies.find(p=>p.agentId==='opencode').enabled`),false);
        assert.equal(await win.webContents.executeJavaScript(`collectPolicies().find(p=>p.agentId==='opencode').openCodeModels.zai`),'zai-coding-plan/glm-5.3');
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('#settings-models button')].find(b=>b.textContent==='OpenCodeログイン管理').click()`);
        for(let i=0;i<100&&loginPlan!=='ollama';i++)await new Promise(r=>setTimeout(r,20));
        assert.equal(loginPlan,'ollama');
        assert.match(await win.webContents.executeJavaScript(`document.querySelector('.claude-login-dialog').textContent`),/Ollama Cloud/);
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent==='閉じる').click()`);
      }
      if (process.argv.includes('--ollama-app-only')) {
        await win.webContents.executeJavaScript(`document.getElementById('opencode-deepseek').click()`);
        assert.equal(await win.webContents.executeJavaScript(`document.getElementById('opencode-provider').value`), 'ollama-app');
        assert.equal(await win.webContents.executeJavaScript(`document.getElementById('glm-model').value`), 'ollama/deepseek-v4.1-flash:cloud');
        await win.webContents.executeJavaScript(`document.getElementById('glm-load-models').click()`);
        for(let i=0;i<100&&!await win.webContents.executeJavaScript(`document.getElementById('glm-models').options.length===1`);i++)await new Promise(r=>setTimeout(r,20));
        assert.equal(await win.webContents.executeJavaScript(`document.getElementById('glm-models').options[0].value`), 'ollama/deepseek-v4.1-flash:cloud');
        await win.webContents.executeJavaScript(`document.getElementById('glm-form').requestSubmit()`);
        for(let i=0;i<100&&!await win.webContents.executeJavaScript(`collectPolicies().find(p=>p.agentId==='opencode').codingPlan==='ollama-app'`);i++)await new Promise(r=>setTimeout(r,20));
        assert.equal(configured, 'ollama/deepseek-v4.1-flash:cloud');
        assert.equal(await win.webContents.executeJavaScript(`state.orchestrationSettings.agentPolicies.find(p=>p.agentId==='opencode').enabled`),false);
        assert.equal(await win.webContents.executeJavaScript(`collectPolicies().find(p=>p.agentId==='opencode').providerKey`), 'ollama-cloud');
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('#settings-models button')].find(b=>b.textContent==='OpenCodeログイン管理').click()`);
        for(let i=0;i<100&&loginPlan!=='ollama-app';i++)await new Promise(r=>setTimeout(r,20));
        assert.equal(loginPlan,'ollama-app');
        assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent==='CLIを開く').hidden`),true);
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent==='閉じる').click()`);
      }
      await win.webContents.executeJavaScript(`document.getElementById('nav-usage').click();document.getElementById('glm-form').scrollIntoView({block:'start'})`);
      await new Promise(r=>setTimeout(r,150));
      assert.equal(await win.webContents.executeJavaScript(`state.currentView`), 'settings');
      writeFileSync(join(__dirname,'..',`output/pdf/${process.argv.includes('--ollama-app-only') ? 'ollama-app' : process.argv.includes('--ollama-only') ? 'ollama' : 'glm'}-settings-smoke.png`),(await win.webContents.capturePage()).toPNG());
      assert.deepEqual(errors,[]); console.log('OpenCode provider settings and login GUI passed');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    if (process.argv.includes('--lesson-only')) {
      await win.webContents.executeJavaScript(`showView('dispatch');document.getElementById('task-details').disabled=false;document.getElementById('task-preset').value='paper-explainer';renderDispatchPresetNote();document.getElementById('lesson-choose-pdfs').click()`);
      for(let i=0;i<60&&!await win.webContents.executeJavaScript(`lessonFiles.length`);i++)await new Promise(r=>setTimeout(r,20));
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('lesson-dispatch').checkVisibility()`),true);
      assert.deepEqual(await win.webContents.executeJavaScript(`lessonDispatchInput().lesson.attachmentIds`),['lesson-file']);
      const preset=await presets.capture('paper-explainer');
      const lesson={audience:'線形代数は既知、GPUは初学者',interests:'数式と実装のつながり',language:'ja',references:['https://example.org/code'],topics:[
        {id:'matrix',title:'行列積と計算量',reason:'提案手法の入出力と効率を読むため',dependsOn:[],recommended:'recap',depth:'recap'},
        {id:'gpu',title:'GPUの並列実行',reason:'原論文のアルゴリズムを図解で追うため',dependsOn:['matrix'],recommended:'foundation',depth:'foundation'},
        {id:'method',title:'提案手法と数式',reason:'背景から着想・途中計算・限界まで理解するため',dependsOn:['gpu'],recommended:'deep',depth:'deep'}]};
      goalTask={...await win.webContents.executeJavaScript(`structuredClone(state.tasks[0])`),workPreset:preset,state:'awaiting-input',awaitingReason:'goal',goalPreparation:false,runs:[],workUnits:[],error:undefined,
        lessonSources:[{name:'sample-paper.pdf',relativePath:'inputs/1.pdf',sha256:'a'.repeat(64),bytes:100}],goal:{...initialGoal('論文を背景から理解する',preset),lesson}};
      await win.webContents.executeJavaScript(`state.tasks=[${JSON.stringify(goalTask)}];state.selectedTaskId=state.tasks[0].id;state.selectedTaskPanels.set(state.tasks[0].id,'overview');showView('tasks');renderTasks();renderDetail()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.lesson-topic').length`),3);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('select[aria-label="GPUの並列実行の説明レベル"]').value`),'foundation');
      await win.webContents.executeJavaScript(`{const s=document.querySelector('select[aria-label="行列積と計算量の説明レベル"]');s.value='known';s.dispatchEvent(new Event('change'));document.querySelector('.lesson-panel').scrollIntoView({block:'start'});}`);
      assert.equal(await win.webContents.executeJavaScript(`goalEdits.get(state.tasks[0].id).value.lesson.topics[0].depth`),'known');
      win.setSize(1450,1000); await new Promise(r=>setTimeout(r,80));
      await win.webContents.executeJavaScript(`document.querySelector('.lesson-topics').scrollIntoView({block:'center'})`);
      writeFileSync(join(__dirname,'..','output/pdf/lesson-goal-smoke.png'),(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.goal-approval-actions button')].find(b=>b.textContent==='ゴールを承認してキューへ').click()`);
      for(let i=0;i<100&&goalTask.goal.status!=='approved';i++)await new Promise(r=>setTimeout(r,20));
      assert.equal(goalTask.goal.status,'approved');assert.equal(goalTask.goal.lesson.topics[0].depth,'known');
      await win.webContents.executeJavaScript(`state.selectedTaskPanels.set(state.tasks[0].id,'report');renderDetail()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-report-heading').textContent`),/Beamer/);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-report-section button')].find(b=>b.textContent==='図解して').click()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('textarea[aria-label="追加指示"]').value`),/図解して/);
      assert.deepEqual(errors,[]);console.log('Lesson GUI: PDF selection, reader levels, preserved user choice, approval, Beamer label and feedback verified.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--report-recovery-only')) {
      const t=await win.webContents.executeJavaScript(`structuredClone(state.tasks[0])`);
      Object.assign(t,{state:'paused',resumeFromUnitId:'report-recovery',runs:[],error:'レポーターの仕上げ・PDF確認が未完了です。',report:{state:'failed'},
        goal:{...initialGoal('一次文献の確認とレポート作成'),status:'approved',questions:[]},
        workUnits:[{id:'report-recovery',title:'Report',role:'reporter',mode:'write',state:'pending',dependsOn:[],attemptedAgentIds:[],instructions:'Finish report'}],
        reportRecovery:{reporterId:'report-recovery',kind:'prerequisite',summary:'資料の取得・独立照合が未完了です。同じレポーターの再実行では解決しません。',concerns:['全6文献の一次資料・異種AI二重照合が未完了。正式版の本文が必要です。'],pdfAvailable:true,canReplan:true}});
      const render=async()=>win.webContents.executeJavaScript(`state.tasks=[${JSON.stringify(t)}];state.selectedTaskId=${JSON.stringify(t.id)};state.queue={running:false,stopping:false};document.getElementById('nav-tasks').click();renderTasks();renderDetail()`);
      await render();
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.report-recovery-artifact').textContent`),/生成・更新を確認済み.*未確定/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.report-recovery-concerns').textContent`),/全6文献/);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].filter(b=>b.textContent==='不足する確認を再計画して続行'&&!b.disabled).length`),2);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent==='追加資料・取得方法を入力').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.activeElement.getAttribute('aria-label')`),'追加指示');
      win.setContentSize(1100,850);win.show();await new Promise(r=>setTimeout(r,150));
      writeFileSync(join(__dirname,'..','output/pdf/report-recovery-smoke.png'),(await win.webContents.capturePage()).toPNG());
      t.reportRecovery.canReplan=false;t.reportRecovery.unavailableReason='不足作業の再計画を2回実施しても解決していません。資料を追加してください。';await render();
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].filter(b=>b.textContent==='不足する確認を再計画して続行'&&!b.disabled).length`),0);
      t.reportRecovery={...t.reportRecovery,kind:'document',resumeStage:'paper',unavailableReason:undefined,
        summary:'論文執筆が省略されていました。同じタスク内で復帰します。'};await render();
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].filter(b=>b.textContent==='論文執筆から再開'&&!b.disabled).length`),2);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-report-recovery').textContent`),/指定形式への修正・PDF生成・独立レビュー/);
      assert.deepEqual(errors,[]);console.log('Report recovery cause, PDF status, bounded recovery actions and answer focus passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--orchestrator-only')) {
      // A focused route avoids unrelated PTY/IME input tests and uses only
      // synthetic plan state; no live task or external agent is involved.
      const {applyExecutionPlan}=require('../dist/core/execution-plan');
      const {newCoordinator,coordinatorStart,applyCoordinatorDecision}=require('../dist/core/orchestrator');
      const t=await win.webContents.executeJavaScript(`structuredClone(state.tasks[0])`);
      Object.assign(t,{workflowMode:'primary',state:'running',runs:[],report:undefined,execution:{...defaultExecution,tokenBudget:undefined},goal:{...initialGoal('完了結果を受けて作業を改善する'),status:'approved',questions:[]}});
      t.workUnits=createExecutionWorkflow(t);
      const owner=t.workUnits.find(u=>u.primary);owner.state='completed';
      const spec={key:'sources',kind:'isolated-work',ownedFiles:['src/parser.ts','tests/parser.test.ts'],title:'独立した検証コードの実装',instructions:'別の作業領域で実装',deliverable:'検証コード',acceptance:'テスト実行',criterionIds:[t.goal.criteria[0].id],dependsOn:[],estimatedTokens:1000,purpose:'verify'};
      Object.assign(t,applyExecutionPlan(t,owner,{summary:'資料を確認して統合',reason:'独立照合',primaryWork:'成果を統合',acceptance:'根拠確認',criterionIds:t.goal.criteria.map(c=>c.id),estimatedTokens:8000,estimatedMinutes:20,escalation:'承認範囲外は確認',tasks:[spec]}));
      const source=t.workUnits.find(u=>u.subtask);source.state='completed';
      const manager=newCoordinator(t,[source.id]);assert.ok(manager);
      Object.assign(t,coordinatorStart(t,manager));
      const render=async()=>win.webContents.executeJavaScript(`(() => {const t=${JSON.stringify(t)};state.tasks=[t];state.selectedTaskId=t.id;document.getElementById('nav-tasks').click();openTaskPanel(t,'plan');})()`);
      await render();
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.orchestrator-status').textContent`),/未着手の作業を確認中/);
      const target=t.workUnits.find(u=>u.primary&&!u.planPhase&&u.state==='pending');
      manager.output='<work-plan>'+JSON.stringify({action:'adjust',reason:'新しい境界条件が判明したため',tasks:[],refinements:[{unitId:target.id,note:'既存条件を維持し、新しく判明した境界条件も検証する。'}]})+'</work-plan>';
      Object.assign(t,applyCoordinatorDecision(t,manager));await render();
      await win.webContents.executeJavaScript(`document.querySelector('.orchestrator-status details').open=true;document.querySelector('[data-unit-id="${target.id}"]').open=true`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent`),/1件へ指示補足・0件追加.*新しい境界条件/s);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent`),/新しく判明した境界条件も検証する/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent`),/独立検証・品質向上/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent`),/実装担当（分離作業）/);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent`),/担当ファイル.*src\/parser.ts/s);
      await win.webContents.executeJavaScript(`document.querySelector('[data-unit-id="${source.id}"]').open=true;document.querySelector('[data-unit-id="${source.id}"]').scrollIntoView({block:'center'})`);
      win.setContentSize(1400,950);win.show();await new Promise(r=>setTimeout(r,150));
      writeFileSync(join(__dirname,'..','output/pdf/orchestrator-smoke.png'),(await win.webContents.capturePage()).toPNG());
      assert.deepEqual(errors,[]);console.log('Orchestrator instruction refinements and purpose display passed');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--cross-review-only')) {
      win.show(); win.focus();
      const overviewPreset = await presets.capture('coding');
      await win.webContents.executeJavaScript(`(() => {
        const t=state.tasks[0]; Object.assign(t,{workflowMode:'primary',state:'awaiting-input',runs:[],report:undefined,workPreset:${JSON.stringify(overviewPreset)},execution:${JSON.stringify(defaultExecution)},goal:${JSON.stringify({...initialGoal('クロスレビューのGUI検証'),status:'approved',questions:[]})}});
        state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'goal');document.getElementById('nav-tasks').click();renderTasks();renderDetail();
      })()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.summary-only').firstElementChild.className`),'task-context-summary');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-context-summary details')`),null);
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.task-rule-references .task-preset-rules').classList.contains('goal-disclosure')`));
      win.setContentSize(1400,950);await new Promise(resolve=>setTimeout(resolve,150));
      writeFileSync(join(__dirname,'..','output/pdf/goal-overview-clean-smoke.png'),(await win.webContents.capturePage()).toPNG());
      goalTask=await win.webContents.executeJavaScript(`structuredClone(state.tasks[0])`);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-settings-actions button')].find(b=>b.textContent==='実行戦略…').click()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.summary-only .execution-settings')`),null);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-execution-dialog').dataset.taskId`),goalTask.id);
      assert.equal(await win.webContents.executeJavaScript(`state.currentView`),'tasks');
      await win.webContents.executeJavaScript(`(() => {
        const dialog=document.querySelector('.task-execution-dialog');
        const strategy=dialog.querySelector('[aria-label="割り当て方針"]');strategy.value='throughput';strategy.dispatchEvent(new Event('change'));
        const parallel=dialog.querySelector('[aria-label="最大同時実行数"]');parallel.value='4';parallel.dispatchEvent(new Event('change'));
        const context=dialog.querySelector('input[aria-label^="会話を切り替える文脈量"]');context.value='';context.dispatchEvent(new Event('input'));
      })()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-execution-dialog [aria-label="レビュー方式"]').value`),'parallel');
      await win.webContents.executeJavaScript(`document.querySelector('.task-execution-dialog .execution-settings fieldset > button').click();`);
      for(let i=0;i<100&&goalTask.execution.reviewMode!=='parallel';i++)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(goalTask.execution.scheduling,'throughput');assert.equal(goalTask.execution.maxParallel,4);
      assert.equal(goalTask.execution.contextTokens,undefined);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-execution-dialog input[aria-label^="会話を切り替える文脈量"]').value`),'');
      // Exercise the actual renderer controls while work is live, using the
      // same policy-patch validator as the application IPC handler.
      goalTask.state='running';
      await win.webContents.executeJavaScript(`state.tasks=state.tasks.map(t=>t.id===${JSON.stringify(goalTask.id)}?${JSON.stringify(goalTask)}:t);refreshTaskExecutionDialog()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-execution-dialog fieldset').disabled`),false);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.task-execution-dialog [aria-label="レビュー方式"]').disabled`),true);
      await win.webContents.executeJavaScript(`(() => {const p=document.querySelector('.task-execution-dialog [aria-label="最大同時実行数"]');p.value='2';p.dispatchEvent(new Event('change'));document.querySelector('.task-execution-dialog fieldset > button').click();})()`);
      for(let i=0;i<100&&!goalTask.pendingExecution;i++)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(goalTask.execution.maxParallel,4);assert.equal(goalTask.pendingExecution.policy.maxParallel,2);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-update-status').textContent`),/変更予約/);
      await win.webContents.executeJavaScript(`document.querySelector('.execution-update-cancel').click()`);
      for(let i=0;i<100&&goalTask.pendingExecution;i++)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(goalTask.pendingExecution,undefined);assert.equal(goalTask.execution.maxParallel,4);
      await win.webContents.executeJavaScript(`(() => {const p=document.querySelector('.task-execution-dialog [aria-label="最大同時実行数"]');p.value='3';p.dispatchEvent(new Event('change'));document.querySelector('.task-execution-dialog fieldset > button').click();})()`);
      for(let i=0;i<100&&!goalTask.pendingExecution;i++)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(goalTask.pendingExecution.policy.maxParallel,3);
      await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      writeFileSync(join(__dirname,'..','output/pdf/live-execution-settings-smoke.png'),(await win.webContents.capturePage()).toPNG());
      Object.assign(goalTask,require('../dist/core/execution-updates').pendingExecutionPatch(goalTask));
      await win.webContents.executeJavaScript(`state.tasks=state.tasks.map(t=>t.id===${JSON.stringify(goalTask.id)}?${JSON.stringify(goalTask)}:t);refreshTaskExecutionDialog()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-update-status').textContent`),/適用中：効率重視・最大3並列/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.execution-update-cancel').hidden`),true);
      goalTask.state='awaiting-input';
      await win.webContents.executeJavaScript(`document.querySelector('.task-execution-dialog').close()`);
      await new Promise(r=>setTimeout(r,100));
      await win.webContents.executeJavaScript(`(() => {
        document.getElementById('nav-settings').click(); document.getElementById('settings-execution').open=true;
        const strategy=document.querySelector('[aria-label="割り当て方針"]');strategy.value='throughput';strategy.dispatchEvent(new Event('change'));
        const context=document.querySelector('input[aria-label^="会話を切り替える文脈量"]');context.value='';context.dispatchEvent(new Event('input'));
        document.querySelector('.execution-settings fieldset > button').click();
      })()`);
      for(let i=0;i<100&&!executionDefaultsSaved;i++)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(executionDefaultsSaved.scheduling,'throughput'); assert.equal(executionDefaultsSaved.reviewMode,'parallel');
      assert.equal(executionDefaultsSaved.contextTokens,undefined);
      await win.webContents.executeJavaScript(`renderExecutionSettings()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('input[aria-label^="会話を切り替える文脈量"]').value`),'');
      assert.equal(goalTask.execution.maxParallel,3,'default saves do not overwrite existing task settings');
      for (const size of [[1100,720],[1400,950]]) {
        win.setContentSize(...size); await new Promise(resolve=>setTimeout(resolve,100));
        await win.webContents.executeJavaScript(`document.querySelector('.execution-settings fieldset > button').scrollIntoView({block:'center'})`);
        assert.ok(await win.webContents.executeJavaScript(`(() => {const s=document.querySelector('.execution-settings fieldset > button').getBoundingClientRect(),p=document.getElementById('settings-view').getBoundingClientRect();return s.top>=p.top-2&&s.bottom<=p.bottom+2;})()`),'strategy save remains reachable after resizing');
      }
      await win.webContents.executeJavaScript(`document.getElementById('settings-execution').scrollIntoView({block:'start'})`);
      win.setContentSize(1100,720);await new Promise(resolve=>setTimeout(resolve,100));
      writeFileSync(join(__dirname,'..','output/pdf/execution-settings-smoke.png'),(await win.webContents.capturePage()).toPNG());
      const {createCrossReviews}=require('../dist/core/cross-review');
      goalTask.workUnits=createCrossReviews({...goalTask,workUnits:[]},['OpenAI','Anthropic','Google']);
      await win.webContents.executeJavaScript(`state.tasks[0]=${JSON.stringify(goalTask)};state.selectedTaskPanels.set(state.tasks[0].id,'plan');document.getElementById('nav-tasks').click();renderTasks();renderDetail();`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-work-parallel').length`),2);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-work-parallel .execution-work-card').length`),6);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent`),/他サービスの判定をクロス検証/);
      win.setContentSize(1400,950);await new Promise(resolve=>setTimeout(resolve,150));
      writeFileSync(join(__dirname,'..','output/pdf/cross-review-layout-smoke.png'),(await win.webContents.capturePage()).toPNG());
      assert.equal(errors.length,0,errors.join('\n'));
      console.log('Cross-review GUI passed: efficiency preset, persisted review strategy/parallel limit, two parallel review layers and provider labels.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--report-location-only')) {
      assert.equal(await evaluate(`document.getElementById('report-remote-execution')`),null);
      assert.match(await evaluate(`document.getElementById('report-settings-form').textContent`),/TeX・PDFはタスクの作業場所/);
      await evaluate(`{
        const t=state.tasks[0];t.state='paused';t.remote={host:'fixture',name:'Cluster',cwd:'/work/project'};
        t.goal=${JSON.stringify(initialGoal('Report fixture'))};t.goal.status='approved';
        t.resumeFromUnitId='report-remote';t.error='ローカルPDFは保持していますが、レビュー用の遠隔転送が完了していません：リンクがあります。';
        t.workUnits=[{id:'report-remote',title:'Report',role:'reporter',state:'pending',dependsOn:[],attemptedAgentIds:[]}];
        state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'overview');showView('tasks');renderTasks();renderDetail();
      }`);
      assert.match(await evaluate(`document.querySelector('.task-stop-notice').textContent`),/次のレポーターはタスクの遠隔作業環境/);
      assert.doesNotMatch(await evaluate(`document.querySelector('.task-stop-notice').textContent`),/次のレポーターはこのMac/);
      assert.match(await evaluate(`document.querySelector('.task-environment-details').textContent`),/PDF生成遠隔側/);
      assert.ok(await evaluate(`[...document.querySelectorAll('.task-environment-details [title]')].some(e=>e.title.includes('このMacでプレビュー'))`));
      await evaluate(`state.tasks[0].error='遠隔レポートのローカル取得に失敗しました（preview/report-1.png）。保存先：/cache/preview/report-1.png。取得先が通常ファイルではありません。';renderDetail()`);
      assert.match(await evaluate(`document.querySelector('.task-stop-notice').textContent`),/このMacへ取得する段階/);
      assert.doesNotMatch(await evaluate(`document.querySelector('.task-stop-notice').textContent`),/遠隔側のTeX環境を確認/);
      await evaluate(`[...document.querySelectorAll('.task-panel-tab')].find(b=>b.textContent==='レポート').click()`);
      assert.equal(await evaluate(`document.querySelector('.task-panel-tab[aria-selected="true"]').textContent`),'レポート');
      assert.match(await evaluate(`document.querySelector('.task-report-section > p').textContent`),/遠隔側のレポート工程完了後に取得したPDF/);
      assert.equal(await evaluate(`!!document.querySelector('[aria-label="成果・検証の表示内容"]')`),false);
      // The independent tab must still render the downloaded PDF via the local reader.
      for (let i=0;i<100 && !await evaluate(`document.querySelector('.task-report-preview')?.contentDocument?.querySelector('.page canvas')?.width>0`);i++) await new Promise(r=>setTimeout(r,50));
      assert.ok(await evaluate(`document.querySelector('.task-report-preview').contentDocument.querySelector('.page canvas')?.width>0`));
      const previewHeights=[];
      for(const [width,height] of [[880,620],[1450,950]]) {
        win.setSize(width,height);await new Promise(r=>setTimeout(r,150));
        previewHeights.push(await evaluate(`document.querySelector('.task-report-preview').getBoundingClientRect().height`));
        assert.ok(await evaluate(`(()=>{const p=document.querySelector('.task-panel-tabs');return p.scrollWidth<=p.clientWidth+2})()`));
      }
      assert.ok(previewHeights[1]>previewHeights[0],'PDF pane grows with the window');
      assert.deepEqual(errors,[]);
      console.log('Report location GUI passed: task-host policy, no location selector, remote resume explanation.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--stop-decision-only')) {
      const decisionWait=async expression=>{
        for(let n=0;n<100;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,20));}
        assert.fail(`Decision UI not ready: ${expression}`);
      };
      const decision={reason:'合格条件と実際の作業順序が一致していません。',question:'numerical_specificationを変更し、事後の許容値変更を開示して独立確認しますか？',options:['条件変更を承認する（別画面で変更内容を確認）','元の条件を維持し、未達として残す']};
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0];t.state='awaiting-input';t.awaitingReason='result';t.autonomyState='needs-input';
        t.error='ユーザ確認が必要です。長い報告';t.goal=${JSON.stringify(initialGoal('Numerical fixture'))};t.goal.status='approved';t.goal.questions=[];
        t.goal.criteria=[{id:'numerical_specification',description:'実装前に許容値を固定する',verification:'時系列ログで確認',required:true}];
        t.workUnits=[{...t.workUnits[0],role:'worker',state:'completed',output:'<work-check>'+JSON.stringify({status:'ask-user',summary:'183件の検証済み。'.repeat(100),remainingWork:'条件を改訂するか。元の基準を維持するか。',userDecision:${JSON.stringify(decision)}})+'</work-check>'}];
        state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'overview');showView('tasks');renderTasks();renderDetail();
      }`);
      assert.equal(await evaluate(`document.querySelectorAll('.followup-composer').length`),1);
      assert.equal(await evaluate(`document.querySelector('.task-decision-notice').open`),true);
      assert.equal(await evaluate(`document.querySelector('.decision-question').textContent`),decision.question);
      assert.equal(await evaluate(`document.querySelector('.decision-original').open`),false);
      assert.equal(await evaluate(`document.querySelector('.task-decision-notice .followup-composer button[type=submit]').textContent`),'回答して続行');
      await evaluate(`document.querySelector('.decision-choices button').click();renderDetail()`);
      assert.equal(await evaluate(`document.querySelector('.followup-composer textarea').value`),decision.options[0]);
      assert.equal(await evaluate(`state.tasks[0].state`),'awaiting-input','choosing an option cannot submit or approve');
      await evaluate(`Array.from(document.querySelectorAll('.followup-composer button')).find(b=>b.textContent==='合格条件・制約を変更…').click()`);
      await decisionWait(`!!document.querySelector('.scope-change-dialog')`);
      assert.equal(await evaluate(`document.querySelector('[aria-label="合格条件を変更：numerical_specification"]').checked`),false);
      await evaluate(`document.querySelector('[aria-label="合格条件を変更：numerical_specification"]').click();document.querySelector('[aria-label="変更後の合格条件：numerical_specification"]').value='';Array.from(document.querySelectorAll('.scope-change-dialog button')).find(b=>b.textContent==='変更を承認して実行').click()`);
      assert.match(await evaluate(`document.querySelector('.scope-change-dialog [role=alert]').textContent`),/空欄/);
      await evaluate(`Array.from(document.querySelectorAll('.scope-change-dialog button')).find(b=>b.textContent==='キャンセル').click()`);
      await decisionWait(`!document.querySelector('.scope-change-dialog')`);
      assert.equal(await evaluate(`state.tasks[0].goal.criteria[0].description`),'実装前に許容値を固定する');
      // Capture exactly what confirmation returns, without dispatching a real task.
      await evaluate(`window.scopeAnswer=undefined;void confirmScopeChange(state.tasks[0],'明示的な変更').then(v=>window.scopeAnswer=v)`);
      await decisionWait(`!!document.querySelector('.scope-change-dialog')`);
      await evaluate(`document.querySelector('[aria-label="合格条件を変更：numerical_specification"]').click();document.querySelector('[aria-label="変更後の合格条件：numerical_specification"]').value='事後変更を明示する';document.querySelector('[aria-label="変更後の検証方法：numerical_specification"]').value='独立して時系列と許容値の妥当性を確認';Array.from(document.querySelectorAll('.scope-change-dialog button')).find(b=>b.textContent==='変更を承認して実行').click()`);
      await decisionWait(`!!window.scopeAnswer`);
      assert.deepEqual(await evaluate(`window.scopeAnswer.criterionEdits`),[{id:'numerical_specification',description:'事後変更を明示する',verification:'独立して時系列と許容値の妥当性を確認'}]);
      for(const size of [[1200,780],[1000,640]]) {
        win.setContentSize(...size);await new Promise(r=>setTimeout(r,80));
        assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`));
        await evaluate(`document.querySelector('.task-decision-notice').scrollTop=9999`);
        assert.ok(await evaluate(`{const r=document.querySelector('.followup-composer textarea').getBoundingClientRect();r.top>=0 && r.bottom<=window.innerHeight}`));
        const scroll=await evaluate(`document.querySelector('.task-decision-notice').scrollTop`);
        await evaluate(`renderDetail()`);
        assert.equal(await evaluate(`document.querySelector('.task-decision-notice').scrollTop`),scroll,'status refresh preserves answer scroll position');
        writeFileSync(join(__dirname,'..','output/pdf/stop-decision-'+size[0]+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      await evaluate(`{const t=state.tasks[0];const v=JSON.parse(t.workUnits[0].output.match(/<work-check>([\\s\\S]*?)<\\/work-check>/)[1]);delete v.userDecision;t.workUnits[0].output='<work-check>'+JSON.stringify(v)+'</work-check>';renderDetail();}`);
      assert.equal(await evaluate(`document.querySelector('.decision-question').textContent`),'条件を改訂するか。元の基準を維持するか。');
      assert.equal(await evaluate(`document.querySelector('.followup-composer textarea').value`),decision.options[0]);
      assert.deepEqual(errors,[]);
      console.log('Stop decision GUI passed: concise reason, question, one persistent reply, explicit goal edit, cancellation, legacy fallback and resize.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--terminal-follow-only')) {
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0];t.state='running';t.runs.forEach(r=>r.state='completed');
        state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'execution');
        state.selectedTerminalAgents.set(t.id,'claude');terminalRunSelections.set(t.id+':claude','run-2');
        showView('tasks');renderTasks();renderDetail();
      }`);
      const publish = async (agent, id) => {
        const tasks = await win.webContents.executeJavaScript(`structuredClone(state.tasks)`);
        tasks[0].runs.push({...tasks[0].runs[0],id,agentId:agent,state:'running',terminal:true});
        win.webContents.send('fixture:tasks-changed',tasks);
        for(let i=0;i<100;i++) {
          if(await win.webContents.executeJavaScript(`state.tasks[0].runs.some(r=>r.id===${JSON.stringify(id)})`))return;
          await new Promise(r=>setTimeout(r,20));
        }
        assert.fail('Task update not received');
      };
      const selectedRun = () => win.webContents.executeJavaScript(`document.querySelector('.terminal-session-selector').value`);
      await publish('claude','run-auto-claude');
      assert.equal(await selectedRun(),'run-auto-claude');
      await win.webContents.executeJavaScript(`{
        const s=document.querySelector('.terminal-session-selector');s.value='run-2';s.dispatchEvent(new Event('change'));
      }`);
      // Repeated status snapshots must not fight a user's history selection.
      win.webContents.send('fixture:tasks-changed',await win.webContents.executeJavaScript(`structuredClone(state.tasks)`));
      await new Promise(r=>setTimeout(r,60));
      assert.equal(await selectedRun(),'run-2');
      await publish('codex','run-auto-codex');
      assert.equal(await selectedRun(),'run-auto-codex');
      assert.equal(await win.webContents.executeJavaScript(`state.selectedTerminalAgents.get(state.tasks[0].id)`),'codex');
      // Keep the tiled layout and show both independent sessions of one CLI.
      await win.webContents.executeJavaScript(`terminalTiledTasks.add(state.tasks[0].id);renderDetail()`);
      await publish('claude','run-auto-claude-parallel');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.terminal-tiles .agent-terminal-pane').length`),3);
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.terminal-session-selector')].map(s=>s.value)`),['run-auto-claude','run-auto-codex','run-auto-claude-parallel']);
      await win.webContents.executeJavaScript(`state.selectedTaskPanels.set(state.tasks[0].id,'overview');renderDetail()`);
      await publish('codex','run-auto-background');
      assert.equal(await win.webContents.executeJavaScript(`state.selectedTaskPanels.get(state.tasks[0].id)`),'overview');
      assert.deepEqual(errors,[]);
      console.log('Terminal follow passed: same/different CLI starts, manual history, parallel tiles, panel preservation');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--terminal-ui-only')) {
      win.show(); win.focus();
      await win.webContents.executeJavaScript(`(() => {
        const t=state.tasks[0]; t.state='running';
        t.workUnits=Array.from({length:12},(_,i)=>({...t.workUnits[0],id:'layout-unit-'+i,title:'工程 '+(i+1)+' · 長い工程名でも枠を保持',role:i%2?'reviewer':'worker',state:i===4?'running':'pending',dependsOn:[],attemptedAgentIds:[]}));
        state.selectedTaskId=t.id;state.selectedTaskPanels.set(t.id,'execution');document.getElementById('nav-tasks').click();renderTasks();renderDetail();
      })()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#global-status')`), null);
      assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].some(b=>/画面履歴|表示クリア|画面モニター/.test(b.textContent))`), false);
      assert.ok(await win.webContents.executeJavaScript(`(() => { const d=document.querySelector('.task-tab.running .task-tab-dot');const probe=document.createElement('span');probe.style.color='var(--green)';document.body.append(probe);const same=getComputedStyle(d).backgroundColor===getComputedStyle(probe).color;probe.remove();return same;})()`));
      for (const width of [1200,1600]) {
        win.setContentSize(width,960); await new Promise(resolve=>setTimeout(resolve,150));
        // The current UI is a scrollable dependency graph, not the retired
        // wrapping card strip. Test its actual nodes at both window widths.
        const cards=await win.webContents.executeJavaScript(`(() => {const viewport=document.querySelector('.workflow-viewport');return {overflow:viewport.scrollWidth>viewport.clientWidth+1,cards:[...viewport.querySelectorAll('.workflow-node')].map(c=>({w:c.getBoundingClientRect().width,y:c.getBoundingClientRect().top,border:getComputedStyle(c).borderTopWidth,title:c.querySelector('strong').textContent}))};})()`);
        assert.equal(cards.overflow,false); assert.equal(cards.cards.length,12);
        assert.ok(new Set(cards.cards.map(c=>Math.round(c.y))).size>1);
        for(const c of cards.cards){assert.ok(c.w>=169);assert.ok(Math.abs(c.w-cards.cards[0].w)<2);assert.equal(c.border,'1px');assert.ok(c.title.trim());}
      }
      await win.webContents.executeJavaScript(`document.querySelectorAll('.agent-terminal-tab').forEach(b=>{if(b.textContent==='codex')b.click();});`);
      for(let i=0;i<100 && !await win.webContents.executeJavaScript(`terminalViews.get('run-1')?.alive`);i++)await new Promise(resolve=>setTimeout(resolve,30));
      await win.webContents.executeJavaScript(`terminalViews.get('run-1').term.focus();`);
      await win.webContents.insertText("printf '\\033[32mNATIVE_%s\\033[0m\\n' INPUT_OK");
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      for(let i=0;i<100 && !runner.snapshot('run-1').data.includes('\x1b[32mNATIVE_INPUT_OK');i++)await new Promise(resolve=>setTimeout(resolve,30));
      assert.match(runner.snapshot('run-1').data,/\x1b\[32mNATIVE_INPUT_OK/);
      await win.webContents.executeJavaScript(`renderDetail();`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.agent-terminal-pane').dataset.inputMode`),'対話端末');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent==='並べて表示').click();`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.interactive-terminal').length`),2);
      // Keep the graph's independently tested size fixed for this terminal
      // growth assertion; its adaptive height otherwise uses part of the gain.
      await win.webContents.executeJavaScript(`workflowCollapsed.add(state.tasks[0].id);renderDetail();`);
      const heights=[];
      for(const height of [700,1000]){win.setContentSize(1600,height);await new Promise(resolve=>setTimeout(resolve,150));heights.push(await win.webContents.executeJavaScript(`document.querySelector('.interactive-terminal').getBoundingClientRect().height`));}
      assert.ok(heights[1]>heights[0]+150);
      await win.webContents.executeJavaScript(`const w=document.querySelector('.workflow-section');w.style.height='280px';w.scrollTop=w.scrollHeight;`);
      await new Promise(resolve=>setTimeout(resolve,100));
      writeFileSync(join(__dirname,'..','output/pdf/native-terminal-layout-smoke.png'),(await win.webContents.capturePage()).toPNG());
      // Retiring task terminals retain their screen but must not send login or
      // other keys into the superseded CLI while the exit acknowledgement waits.
      await win.webContents.executeJavaScript(`appendRunEvent({runId:'run-1',type:'status',text:'Terminal retiring: 担当の終了を確認しています。'});terminalViews.get('run-1').term.focus();`);
      assert.equal(await win.webContents.executeJavaScript(`terminalViews.get('run-1').inputAllowed`),false);
      assert.equal(await win.webContents.executeJavaScript(`terminalViews.get('run-1').term.options.disableStdin`),true);
      await win.webContents.insertText("printf RETIRED_INPUT_MUST_NOT_EXECUTE");
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.doesNotMatch(runner.snapshot('run-1').data,/RETIRED_INPUT_MUST_NOT_EXECUTE/);
      await win.webContents.executeJavaScript(`state.tasks[0].state='paused';state.tasks[0].runs.forEach(r=>r.state='failed');state.queue.activeTaskIds=[];renderDetail();[...document.querySelectorAll('.agent-terminal-pane button')].find(b=>b.textContent==='CLIを復旧…').click()`);
      for(let i=0;i<100&&!runner.snapshot('manual-recovery-fixture')?.alive;i++)await new Promise(r=>setTimeout(r,30));
      assert.ok(runner.snapshot('manual-recovery-fixture')?.alive);
      const readyButton=`[...document.querySelectorAll('.cli-recovery-dialog button')].find(b=>b.textContent==='確認してReadyにする')`;
      assert.equal(await win.webContents.executeJavaScript(`${readyButton}.disabled`),true);
      await win.webContents.executeJavaScript(`document.querySelector('.cli-recovery-dialog input[type=checkbox]').click();document.querySelector('.cli-recovery-terminal .xterm-helper-textarea').focus()`);
      assert.equal(await win.webContents.executeJavaScript(`${readyButton}.disabled`),true,'verification alone must not enable Ready while the shell is alive');
      await win.webContents.insertText("printf 'RECOVERY_%s\\n' UI_OK");
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      for(let i=0;i<100&&!runner.snapshot('manual-recovery-fixture').data.includes('RECOVERY_UI_OK');i++)await new Promise(r=>setTimeout(r,30));
      assert.match(runner.snapshot('manual-recovery-fixture').data,/RECOVERY_UI_OK/);
      await new Promise(r=>setTimeout(r,650)); // Wait for the recovery snapshot poll and xterm paint.
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.cli-recovery-dialog input[type=checkbox]').getBoundingClientRect().width<30`));
      writeFileSync(join(__dirname,'..','output/pdf/cli-recovery-layout-smoke.png'),(await win.webContents.capturePage()).toPNG());
      runner.write('manual-recovery-fixture','exit\r');
      for(let i=0;i<100&&await win.webContents.executeJavaScript(`${readyButton}.disabled`);i++)await new Promise(r=>setTimeout(r,30));
      assert.equal(await win.webContents.executeJavaScript(`${readyButton}.disabled`),false);
      await win.webContents.executeJavaScript(`${readyButton}.click()`);
      for(let i=0;i<100&&!manualRecoveryReady;i++)await new Promise(r=>setTimeout(r,30));
      assert.equal(manualRecoveryReady,true);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.cli-recovery-dialog button')].find(b=>b.textContent==='閉じる').click()`);
      // The compatibility view remains reachable for pre-PTY saved runs. It
      // must show persisted logs, not instantiate a writable CLI terminal.
      await win.webContents.executeJavaScript(`{
        const t=state.tasks[0]; t.state='completed';
        t.runs=t.runs.map(r=>({...r,terminal:false,state:'completed',output:'raw legacy output',displayOutput:'以前の保存済みログ'}));
        state.selectedTerminalAgents.set(t.id,'codex');renderDetail();
      }`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.agent-terminal').textContent`),/以前の保存済みログ/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.interactive-terminal')`),null);
      assert.equal(errors.length,0,errors.join('\n'));
      console.log('Terminal GUI passed: dependency nodes, green running indicator, native input, retirement fence, tiling, resize and saved pre-PTY logs.');
      runner.cancelAll();await Promise.all(runs);app.exit(0);return;
    }
    if (process.argv.includes('--goal-answers-only')) {
      const goal = { ...initialGoal('複数候補の予備評価'), questions: ['評価環境は？', '比較方法は？'] };
      await win.webContents.executeJavaScript(`(() => {
        const t=state.tasks[0]; Object.assign(t,{goal:${JSON.stringify(goal)},state:'awaiting-input',awaitingReason:'goal',runs:[],report:undefined,workflowMode:'primary',workUnits:[],goalHistory:[]});
        state.selectedTaskId=t.id; state.selectedTaskPanels.set(t.id,'overview'); document.getElementById('nav-tasks').click(); renderTasks(); renderDetail();
      })()`);
      goalTask = await win.webContents.executeJavaScript(`structuredClone(state.tasks[0])`);
      const clickButton = text => win.webContents.executeJavaScript(`[...document.querySelectorAll('.goal-editor button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
      const settle = async () => { for(let i=0;i<100 && await win.webContents.executeJavaScript(`goalBusy.size>0`);i++) await new Promise(resolve=>setTimeout(resolve,30)); assert.equal(await win.webContents.executeJavaScript(`goalBusy.size`),0); };
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.goal-question-card textarea').length`), 2);
      await win.webContents.executeJavaScript(`(() => {
        ['Apple M5で予備評価','複数の候補を同じ条件で比較'].forEach((value,i)=>{const input=document.querySelectorAll('.goal-question-card textarea')[i];input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));});
        document.activeElement?.blur(); renderDetail();
      })()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-question-card textarea').value`), 'Apple M5で予備評価');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .primary-button').disabled`), true);
      await clickButton('下書きを保存'); await settle();
      assert.equal(goalTask.goal.questionAnswers.length, 2);
      await win.webContents.executeJavaScript(`goalEdits.clear(); renderDetail();`);
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.goal-question-card textarea')].map(t=>t.value)`), ['Apple M5で予備評価', '複数の候補を同じ条件で比較']);
      await win.webContents.executeJavaScript(`(() => {
        const row=document.querySelector('.goal-question-card'); row.querySelector('input').click();
        const input=row.querySelector('textarea'); input.value='Apple M5で予備評価（更新）'; input.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-question-card input').checked`), false);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-readiness').textContent`), /未解決の確認事項が2件/);
      await clickButton('回答を使ってAIでゴールを更新'); await settle();
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .form-error').textContent`), /AI connection unavailable/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-question-card textarea').value`), 'Apple M5で予備評価（更新）');
      win.setSize(1280,1000); win.show();
      await new Promise(resolve=>setTimeout(resolve,150));
      await win.webContents.executeJavaScript(`document.querySelector('.goal-question-card').scrollIntoView({block:'center'});`);
      await new Promise(resolve=>setTimeout(resolve,150));
      writeFileSync(join(__dirname,'..','output/pdf/goal-question-answers-smoke.png'),(await win.webContents.capturePage()).toPNG());
      await clickButton('回答を使ってAIでゴールを更新'); await settle();
      assert.equal(goalRefinements, 1);
      assert.equal(goalTask.goal.status, 'draft'); assert.equal(goalTask.goal.questions.length, 0);
      assert.ok(goalTask.goal.constraints.includes('Apple M5で予備評価（更新）'));
      assert.ok(goalTask.goalHistory.some(g=>g.questionAnswers?.length===2));
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log('Goal answers GUI passed: inline answers, draft persistence, safe approval, failed refinement recovery and answer transfer.');
      runner.cancelAll(); await Promise.all(runs); app.exit(0); return;
    }
    if (process.argv.includes('--research-only')) {
      const preset = await presets.capture('research-project');
      const units = orderAutonomousUnits(pairUnits(createExecutionWorkflow({workflowMode:'primary',workPreset:preset})));
      await win.webContents.executeJavaScript(`(() => {
        const t=state.tasks[0]; Object.assign(t,{workPreset:${JSON.stringify(preset)},workUnits:${JSON.stringify(units)},goal:${JSON.stringify({...initialGoal('Research fixture',preset),status:'approved',questions:[]})},workflowMode:'primary',runs:[],report:undefined,executionPlans:[],state:'queued'});
        state.selectedTaskId=t.id; state.selectedTaskPanels.set(t.id,'plan'); document.getElementById('nav-tasks').click(); renderTasks(); renderDetail();
      })()`);
      const cards=await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.execution-work-card')).map(e=>e.textContent)`);
      assert.equal(cards.length,units.length);
      assert.ok(!units.some(u=>u.researchStage),'new research is not a four-owner stage chain');
      assert.match(cards[0],/主担当/);
      assert.match(cards[1],/01待ち/);
      assert.ok(await win.webContents.executeJavaScript(`(() => {const p=document.querySelector('.task-panel-content.plan');return p.scrollWidth<=p.clientWidth+2;})()`));
      const legacyPreset=structuredClone(preset);delete legacyPreset.manifest.integratedWorkflow;
      const legacyUnits=orderAutonomousUnits(pairUnits(createExecutionWorkflow({workflowMode:'primary',workPreset:legacyPreset})));
      await win.webContents.executeJavaScript(`Object.assign(state.tasks[0],{workPreset:${JSON.stringify(legacyPreset)},workUnits:${JSON.stringify(legacyUnits)}});renderDetail()`);
      const legacyCards=await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.execution-work-card')).map(e=>e.textContent)`);
      for(const [i,p] of preset.stages.entries())assert.ok(legacyCards[i].includes(p.manifest.name),'legacy stage labels remain');
      await win.webContents.executeJavaScript(`Object.assign(state.tasks[0],{workPreset:${JSON.stringify(preset)},workUnits:${JSON.stringify(units)}});renderDetail()`);
      await win.webContents.executeJavaScript(`state.selectedTaskPanels.set(state.selectedTaskId,'goal'); renderDetail();`);
      const saved=await win.webContents.executeJavaScript(`document.querySelector('.task-preset-rules pre').textContent`);
      for(const p of preset.stages) { assert.ok(saved.includes(p.rules)); assert.ok(saved.includes(p.revision.slice(0,12))); }
      await win.webContents.executeJavaScript(`document.getElementById('nav-settings').click(); presetManagerId='research-project'; renderPresetManager();`);
      const description=await win.webContents.executeJavaScript(`document.getElementById('preset-manager-description').textContent`);
      for(const p of preset.stages) assert.ok(description.includes(p.manifest.name));
      assert.match(description,/各モードの保存済みルール/);
      assert.match(description,/固定の直列工程ではありません/);assert.doesNotMatch(description,/使用順/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-page').length`),8);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-index button').length`),0);
      await win.webContents.executeJavaScript(`presetManagerId='idea'; renderPresetManager(); selectSettingsPage('settings-presets'); document.getElementById('preset-edit').click();`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.preset-panel textarea').length`),1);
      const ideaBefore=await presets.capture('idea');
      await win.webContents.executeJavaScript(`(() => { const input=document.getElementById('preset-rules'); input.value=input.value.replace('## 作業','## 作業\\nCUSTOM_COMPARE_METHOD'); input.dispatchEvent(new Event('input')); document.getElementById('preset-save').click(); })()`);
      for(let i=0;i<100 && !(await presets.capture('idea')).rules.includes('CUSTOM_COMPARE_METHOD');i++) await new Promise(r=>setTimeout(r,30));
      const ideaAfter=await presets.capture('idea'); assert.notEqual(ideaBefore.revision,ideaAfter.revision);
      const {presetSections}=require('../dist/core/work-presets');
      for(const key of ['共通','ゴール設計','主担当の計画','検証','レポート']) assert.equal(presetSections(ideaAfter.rules)[key],presetSections(ideaBefore.rules)[key]);
      assert.match((await presets.capture('research-project')).stages[0].rules,/CUSTOM_COMPARE_METHOD/);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-view details details').length`),0,'mode rerender must not introduce nested disclosures');
      assert.equal(await win.webContents.executeJavaScript(`state.tasks[0].workPreset.stages[0].rules.includes('CUSTOM_COMPARE_METHOD')`),false);
      await win.webContents.executeJavaScript(`void confirmScopeChange({...state.tasks[0],workPreset:${JSON.stringify(ideaAfter)}},'探索を続ける');`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.scope-change-dialog [aria-label="実装・精度検証・性能実験を含める"]').checked`),false,'experimental ideation does not preselect a switch to coding');
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.scope-change-dialog button')).find(b=>b.textContent==='キャンセル').click();`);
      for(const height of [620,1000]) {
        win.setSize(1200,height);
        await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-view details').forEach(d=>d.open=true);document.getElementById('settings-view').scrollTop=1e9;`);
        assert.ok(await win.webContents.executeJavaScript(`(() => {const p=document.getElementById('settings-view');return p.scrollTop+p.clientHeight>=p.scrollHeight-3;})()`),'settings bottom stays reachable after resize');
      }
      assert.deepEqual(errors,[]);
      console.log('Research/settings GUI passed: integrated primary, legacy stage labels, saved method rules, isolated saves and resize scrolling.');
      if(process.argv.includes('--capture-settings')) {
        await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-view details').forEach(d=>d.open=d.id==='settings-presets');document.getElementById('settings-view').scrollTop=0;`);
        win.show(); await new Promise(r=>setTimeout(r,150));
        writeFileSync(join(__dirname,'../output/pdf/settings-organized-smoke.png'),(await win.webContents.capturePage()).toPNG());
      }
      runner.cancelAll(); await Promise.all(runs); app.exit(0);
      return;
    }
    // User choice (including no preset) survives refresh; the default is initial-only.
    await win.webContents.executeJavaScript(`document.getElementById('task-preset').value=''; document.getElementById('task-preset').dispatchEvent(new Event('change')); renderDispatchPresets();`);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-preset').value`), '');
    assert.ok(await win.webContents.executeJavaScript(`document.querySelectorAll('.task-panel-tab').length > 0`));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-view > details[open]').length`),0);
    // The settings page must have one page-level scroll range, including the final save button.
    const settingsWindowSize = win.getSize();
    await win.webContents.executeJavaScript(`(() => { document.getElementById('nav-settings').click(); selectSettingsPage('settings-report'); })()`);
    for (const [width, height] of [[980, 620], [1200, 1020], [980, 620], [1200, 820], [980, 620]]) {
      win.setSize(width, height);
      await new Promise(resolve=>setTimeout(resolve,100));
      const bounds = await win.webContents.executeJavaScript(`(() => {
        const view=document.getElementById('settings-view'); view.scrollTop=view.scrollHeight;
        const panel=document.querySelector('.report-settings-panel');
        const button=document.querySelector('#report-settings-form button[type="submit"]');
        const v=view.getBoundingClientRect(), p=panel.getBoundingClientRect(), b=button.getBoundingClientRect();
        return {height:innerHeight, viewBottom:v.bottom, buttonTop:b.top, buttonBottom:b.bottom, viewTop:v.top, panelBottom:p.bottom, panelOverflow:panel.scrollHeight-panel.clientHeight};
      })()`);
      assert.ok(bounds.buttonTop >= bounds.viewTop && bounds.buttonBottom <= bounds.viewBottom + 2 && bounds.buttonBottom <= bounds.panelBottom + 2, JSON.stringify(bounds));
      assert.ok(bounds.viewBottom <= bounds.height && bounds.panelOverflow <= 2, JSON.stringify(bounds));
    }
    writeFileSync(join(__dirname, '..', 'output/pdf/settings-scroll-bottom-smoke.png'), (await win.webContents.capturePage()).toPNG());
    win.setSize(...settingsWindowSize);
    await win.webContents.executeJavaScript(`selectSettingsPage('settings-execution')`);
    await win.webContents.executeJavaScript(`document.getElementById('nav-settings').click()`);
    await new Promise(resolve=>setTimeout(resolve,100));
    writeFileSync(join(__dirname,'..','output','pdf','settings-sections-smoke.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('remote-codex-permissions').value`), 'full-access', 'new remote profiles default to no sandbox');
    await win.webContents.executeJavaScript(`
      document.getElementById('nav-settings').click();
      selectSettingsPage('settings-remote');
      document.getElementById('remote-mode').value = 'direct'; document.getElementById('remote-mode').dispatchEvent(new Event('change'));
      document.getElementById('remote-name').value = 'テスト用スパコン';
      document.getElementById('remote-host').value = '192.0.2.10';
      document.getElementById('remote-user').value = 'scientist';
      document.getElementById('remote-port').value = '2222';
      document.getElementById('remote-cwd').value = ' ~/projects/test ';
      document.getElementById('remote-instructions').value = 'スケジューラの操作手順をプレーンテキストで登録';
      document.getElementById('remote-codex-permissions').value = 'sandbox';
      document.getElementById('remote-form').requestSubmit();
    `);
    for (let i=0; i<100 && !await win.webContents.executeJavaScript(`document.getElementById('task-remote').options.length === 2`); i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal((await remoteSystems.list())[0].instructions, 'スケジューラの操作手順をプレーンテキストで登録');
    const remoteProfile = (await remoteSystems.list())[0];
    assert.equal(remoteProfile.codexPermissions, 'sandbox', 'sandbox requires an explicit selection for new profiles');
    assert.match(remoteProfile.id, /^remote-/); assert.equal(remoteProfile.host, '192.0.2.10'); assert.equal(remoteProfile.username, 'scientist'); assert.equal(remoteProfile.port, 2222);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('remote-cwd').value`), '~/projects/test');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#settings-view details details').length`),0);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('remote-status').checkVisibility()`),true,'save result must be visible with connection operations collapsed');
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('remote-status').textContent`),/保存しました/);
    await win.webContents.executeJavaScript(`document.getElementById('remote-port').value='70000'; document.getElementById('remote-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    for(let i=0;i<100&&!await win.webContents.executeJavaScript(`document.getElementById('remote-error').textContent.includes('SSHポート')`);i++) await new Promise(r=>setTimeout(r,30));
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('remote-error').textContent`),/SSHポート/);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('remote-error').checkVisibility()`),true,'save errors must be visible without expanding operations');
    await win.webContents.executeJavaScript(`document.getElementById('remote-port').value='2222';document.getElementById('remote-dispatch').click()`);
    assert.equal(await win.webContents.executeJavaScript(`state.currentView`), 'usage');
    await win.webContents.executeJavaScript(`document.getElementById('nav-settings').click(); document.getElementById('remote-user').value='not-saved'; document.getElementById('remote-dispatch').click()`);
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('remote-error').textContent`), /保存/);
    assert.equal(await win.webContents.executeJavaScript(`state.currentView`), 'settings');
    await win.webContents.executeJavaScript(`document.getElementById('remote-select').dispatchEvent(new Event('change'))`);
    assert.ok(await win.webContents.executeJavaScript(`!document.getElementById('remote-advanced').matches('details')`));
    const remoteDialog = async () => win.webContents.executeJavaScript(`showRemoteServiceTerminal({providerKey:'openai@'+${JSON.stringify(remoteProfile.id)},environmentId:${JSON.stringify(remoteProfile.id)},environmentLabel:'Fixture',agentIds:['codex'],connected:false})`);
    const remoteButton = async label => win.webContents.executeJavaScript(`[...document.querySelectorAll('.remote-service-dialog button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
    ipcMain.handle('fixture:service-check',()=>win.webContents.executeJavaScript('state.resources'));
    ipcMain.handle('fixture:service-terminal-start',()=> 'fixture-cli');
    ipcMain.handle('fixture:service-terminal-snapshot',()=>({data:'',offset:0,alive:false,cols:100,rows:28}));
    await remoteDialog();await new Promise(r=>setTimeout(r,50));await remoteButton('接続する');
    await new Promise(r=>setTimeout(r,50));await remoteButton('接続を確認してCLIを開く');
    for (let i=0;i<100&&!attachedEnvironments.has(remoteProfile.id);i++) await new Promise(r=>setTimeout(r,30));
    await remoteButton('画面を閉じる');
    // Workspace selection belongs to dispatch, not the connection terminal.
    await win.webContents.executeJavaScript(`showView('dispatch');document.getElementById('task-remote').value=${JSON.stringify(remoteProfile.id)};updateRemoteDispatch()`);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-remote').value`),remoteProfile.id);
    assert.ok(await win.webContents.executeJavaScript(`document.getElementById('task-local-directory').classList.contains('hidden') && document.getElementById('task-remote-note').textContent.includes('~/projects/test')`));
    const authWait = async expression => {
      for (let i = 0; i < 100; i++) {
        if (await win.webContents.executeJavaScript(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const detail = await win.webContents.executeJavaScript(`({view:state.currentView,selected:state.selectedTaskId,notice:document.querySelector('.task-stop-notice')?.textContent,workflow:document.querySelector('.workflow-strip')?.textContent})`);
      assert.fail(`SSH auth UI condition: ${expression}\n${JSON.stringify(detail)}`);
    };
    win.webContents.send('remote:auth-required', { taskId: 'auth-fixture', title: 'SSH開始テスト', system: remoteProfile });
    await authWait(`document.getElementById('remote-task-auth-dialog').open && !document.getElementById('remote-task-auth-continue').disabled`);
    assert.equal(authConnects, 1);
    assert.ok(await win.webContents.executeJavaScript(`document.getElementById('remote-task-auth-target').textContent.includes('scientist@192.0.2.10') && !!document.querySelector('#remote-task-auth-terminal .xterm')`));
    win.webContents.send('remote:output', { id: remoteProfile.id, stream: 'stdout', text: 'Password: ' });
    await new Promise(resolve => setTimeout(resolve, 100));
    writeFileSync(join(__dirname, '..', 'output', 'pdf', 'ssh-auth-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.getElementById('remote-task-auth-continue').click()`);
    await authWait(`document.getElementById('remote-task-auth-error').textContent.includes('authentication incomplete')`);
    assert.ok(await win.webContents.executeJavaScript(`document.getElementById('remote-task-auth-dialog').open`));
    await win.webContents.executeJavaScript(`document.getElementById('remote-task-auth-continue').click()`);
    await authWait(`!document.getElementById('remote-task-auth-dialog').open`);
    assert.equal(authChecks, 2);
    win.webContents.send('remote:auth-required', { taskId: 'auth-fixture', title: 'SSH取消テスト', system: remoteProfile });
    await authWait(`document.getElementById('remote-task-auth-dialog').open && !document.getElementById('remote-task-auth-continue').disabled`);
    await win.webContents.executeJavaScript(`document.getElementById('remote-task-auth-cancel').click()`);
    await authWait(`!document.getElementById('remote-task-auth-dialog').open`);
    assert.equal(authCancels, 1);
    await win.webContents.executeJavaScript(`document.getElementById('task-remote').value=''; document.getElementById('task-remote').dispatchEvent(new Event('change'));`);
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.sidebar #task-list') && document.querySelector('.resource-sidebar #resource-summary') && !document.querySelector('main #task-list')`));
    await win.webContents.executeJavaScript(`document.getElementById('nav-settings').click(); document.querySelector('.sidebar .task-tab').click();`);
    assert.equal(await win.webContents.executeJavaScript(`state.currentView`), 'tasks');
    const sidebarWidths = await win.webContents.executeJavaScript(`(() => { const l=document.querySelector('.sidebar').getBoundingClientRect(),m=document.querySelector('main').getBoundingClientRect(),r=document.querySelector('.resource-sidebar').getBoundingClientRect(); return { left:l.width, right:r.width, separated:l.right<=m.left && m.right<=r.left, fits:r.right<=innerWidth }; })()`);
    assert.ok(sidebarWidths.left >= 170 && sidebarWidths.right >= 190 && sidebarWidths.separated && sidebarWidths.fits);
    for (const side of ['タスク', '利用量']) {
      const selector = `[aria-label="${side}サイドバーの幅を調整"]`;
      const pane = side === 'タスク' ? '.sidebar' : '.resource-sidebar';
      const before = await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(pane)}).getBoundingClientRect().width`);
      await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
      const after = await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(pane)}).getBoundingClientRect().width`);
      assert.ok(side === 'タスク' ? after > before : after < before);
      await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);
    }
    const quota = await win.webContents.executeJavaScript(`document.querySelector('.resource-sidebar').textContent`);
    for (const label of ['OpenAI', 'Anthropic', 'Current session', 'Current week (all)', 'Current week (Fable)', 'Reset:']) assert.ok(quota.includes(label));
    const measurements = {};
    for (const [tab, selector] of [['Report', '.task-report-preview'], ['Execution', '.interactive-terminal']]) {
      await win.webContents.executeJavaScript(`openTaskPanel(state.tasks.find(t=>t.id===state.selectedTaskId),${JSON.stringify(tab === 'Report' ? 'report' : 'execution')})`);
      if (tab === 'Execution') {
        assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.workflow-section').open`), true);
        await win.webContents.executeJavaScript(`document.querySelector('.workflow-section').open=false`);
        await new Promise(resolve=>setTimeout(resolve,30));
        await win.webContents.executeJavaScript(`renderDetail()`);
        assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.workflow-section').open`), false);
        await win.webContents.executeJavaScript(`document.querySelector('.workflow-section').open=true`);
        await new Promise(resolve=>setTimeout(resolve,30));
        assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.work-unit .assignment-reason').length`), 0);
        assert.ok(await win.webContents.executeJavaScript(`!!document.querySelector('.interactive-terminal .xterm')`), 'interactive terminal is the default for local sessions too');
      }
      measurements[tab] = [];
      for (const height of [620, 820, 1020]) {
        win.setContentSize(1200, height);
        // Native resize delivery can lag under load. Measure the actual resized
        // viewport rather than assuming a fixed delay or an unclamped screen.
        for (let i=0; i<50; i++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          if (await win.webContents.executeJavaScript('innerHeight') === win.getContentSize()[1]) break;
        }
        const size = await win.webContents.executeJavaScript(`(() => {
          const pane = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          const composer = document.querySelector('.followup-composer').getBoundingClientRect();
          return { viewport: innerHeight, pane: pane.height, bottom: pane.bottom, composerBottom: composer.bottom, workflow: document.querySelector('.workflow-section')?.getBoundingClientRect().height ?? 0, reportHint: document.querySelector('.task-report-section > p')?.getBoundingClientRect().height ?? 0,
            ...(pane.height<=50 ? {layout:['.task-panel-content','.task-execution-view','.agent-monitors','.terminal-single','.agent-terminal-pane','.agent-terminal-pane > header'].map(selector=>{
              const e=document.querySelector(selector);return e&&{selector,height:e.getBoundingClientRect().height,flex:getComputedStyle(e).flex,min:getComputedStyle(e).minHeight};})}: {}) };
        })()`);
        assert.ok(size.pane > 50, `${tab} must remain usable: ${JSON.stringify(size)}`);
        assert.ok(size.bottom <= size.viewport && size.composerBottom <= size.viewport, `${tab} must fit the window`);
        measurements[tab].push(size);
      }
      const viewportGrowth = measurements[tab][2].viewport - measurements[tab][0].viewport;
      const workflowGrowth = measurements[tab][2].workflow - measurements[tab][0].workflow;
      // Compact-height mode hides the report hint; account for it reappearing
      // rather than treating the larger, now-readable explanation as lost space.
      const hintGrowth = measurements[tab][2].reportHint - measurements[tab][0].reportHint;
      assert.ok(viewportGrowth >= 150 && measurements[tab][2].pane - measurements[tab][0].pane + workflowGrowth + hintGrowth >= viewportGrowth - 25, `${tab} should grow with the window: ${JSON.stringify(measurements[tab])}`);
      if (tab === 'Execution') writeFileSync(join(__dirname, '..', 'output/pdf/sidebar-layout-smoke.png'), (await win.webContents.capturePage()).toPNG());
      if (tab === 'Report') {
        for (let i = 0; i < 100; i++) {
          const result = await win.webContents.executeJavaScript(`(() => { const d = document.querySelector('.task-report-preview').contentDocument; return { ready: d?.body?.dataset.ready, error: d?.body?.dataset.error, status: d?.getElementById('status')?.textContent }; })()`);
          if (result.error) throw new Error(result.status);
          if (result.ready) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await new Promise(resolve => setTimeout(resolve, 350));
        assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.task-report-preview').contentDocument.querySelector('.page canvas')?.width > 0`), 'PDF must render real page canvases');
        assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.task-report-preview').contentDocument.querySelector('.textLayer span')?.textContent.length > 0`), 'PDF text remains selectable');
        const split = await win.webContents.executeJavaScript(`(() => { const f = document.querySelector('.task-report-preview'), r = f.getBoundingClientRect(), s = f.contentDocument.getElementById('splitter').getBoundingClientRect(); return { x: Math.round(r.x + s.x + 3), y: Math.round(r.y + s.y + 30) }; })()`);
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...split });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: split.x + 70, y: split.y, movementX: 70, movementY: 0 });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: split.x + 70, y: split.y });
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.task-report-preview').contentDocument.getElementById('sidebar').offsetWidth >= 245`), 'PDF sidebar resizes with actual pointer input');
        writeFileSync(join(__dirname, '..', 'output/pdf/viewer-smoke.png'), (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`(() => {
          const t = state.tasks.find(t => t.id === 'layout-fixture');
          t.report.documents = Object.fromEntries(['paper','poster'].map(id => [id, { state:'ready', texPath:'/tmp/'+id+'/main.tex', pdfPath:'/tmp/'+id+'/main.pdf', previewUrl:'about:blank' }]));
          t.history = [{ number:1, instruction:'Saved document fixture', report:structuredClone(t.report) }];
          renderDetail();
        })()`);
        for (const document of ['paper', 'poster', 'report']) {
          await win.webContents.executeJavaScript(`(() => { const s=document.querySelector('[aria-label="PDF成果物"]'); s.value=${JSON.stringify(document)}; s.dispatchEvent(new Event('change')); })()`);
          for (let i=0; i<100 && !await win.webContents.executeJavaScript(`(() => { const d=document.querySelector('.task-report-preview').contentDocument; return d?.body?.dataset.ready === 'true' && d.querySelector('.page canvas')?.width > 0; })()`); i++) await new Promise(resolve=>setTimeout(resolve,100));
          assert.ok(pdfRequests.some(r=>r.document === document && r.round === undefined));
          assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.task-report-preview').contentDocument.querySelector('.page canvas')?.width > 0`));
          if (document === 'poster') writeFileSync(join(__dirname, '..', 'output/pdf/poster-viewer-smoke.png'), (await win.webContents.capturePage()).toPNG());
        }
        await win.webContents.executeJavaScript(`(() => { const v=document.querySelector('[aria-label="レポートの版"]'); v.value='1'; v.dispatchEvent(new Event('change')); const d=document.querySelector('[aria-label="PDF成果物"]'); d.value='paper'; d.dispatchEvent(new Event('change')); })()`);
        for (let i=0; i<100 && !pdfRequests.some(r=>r.document==='paper' && r.round===1); i++) await new Promise(resolve=>setTimeout(resolve,50));
        assert.ok(pdfRequests.some(r=>r.document==='paper' && r.round===1));
      }
    }
    // Actual keystrokes go through xterm -> isolated preload -> main -> native PTY.
    await win.webContents.executeJavaScript(`document.querySelectorAll('.agent-terminal-tab').forEach(b => { if (b.textContent === 'claude') b.click(); });`);
    // Renderer can see the run before its PTY has started. Later output must
    // restore input without requiring a task or application restart.
    await new Promise(resolve => setTimeout(resolve, 100));
    claudeFirstSnapshot = true;
    await win.webContents.executeJavaScript(`syncTerminal(terminalViews.get('run-2'))`);
    assert.equal(await win.webContents.executeJavaScript(`terminalViews.get('run-2').alive`), false);
    runner.write('run-2', "printf 'CLAUDE_READY\\n'\r");
    for (let i=0; i<100 && !await win.webContents.executeJavaScript(`terminalViews.get('run-2')?.alive`); i++) await new Promise(r=>setTimeout(r,30));
    assert.ok(await win.webContents.executeJavaScript(`terminalViews.get('run-2').host.isConnected && !terminalViews.get('run-2').term.options.disableStdin`));
    win.show(); win.focus();
    await win.webContents.executeJavaScript(`terminalViews.get('run-2').term.focus()`);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(await win.webContents.executeJavaScript(`terminalViews.get('run-2').host.contains(document.activeElement)`));
    await win.webContents.insertText("printf 'CLAUDE_INPUT_%s\\n' OK");
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.match(runner.snapshot('run-2').data, /CLAUDE_INPUT_OK/);
    await win.webContents.executeJavaScript(`document.querySelectorAll('.agent-terminal-tab').forEach(b => { if (b.textContent === 'codex') b.click(); });`);
    win.show(); win.focus();
    await new Promise(resolve => setTimeout(resolve, 150));
    await win.webContents.executeJavaScript(`document.querySelector('.xterm-helper-textarea').focus()`);
    await win.webContents.insertText("printf '\\033[31mGUI_%s\\033[0m\\n' PTY_OK");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.match(runner.snapshot('run-1').data, /\x1b\[31mGUI_PTY_OK/);
    const screen = () => win.webContents.executeJavaScript(String.raw`(() => { const b = terminalViews.get('run-1').term.buffer.active; return Array.from({length:b.length}, (_,i) => b.getLine(i).translateToString()).join('\n'); })()`);
    assert.match(await screen(), /GUI_PTY_OK/);
    runner.write('run-1', "printf '\\033[?1049l'\r");
    await new Promise(resolve => setTimeout(resolve,150));
    await win.webContents.executeJavaScript(`document.querySelectorAll('.task-panel-tab').forEach(b => { if (b.textContent === '概要') b.click(); }); document.querySelectorAll('.task-panel-tab').forEach(b => { if (b.textContent === '実行') b.click(); });`);
    assert.match(await screen(), /GUI_PTY_OK/);
    await win.webContents.executeJavaScript(`document.querySelectorAll('button').forEach(b => { if (b.textContent === '並べて表示') b.click(); });`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.interactive-terminal').length`), 2);
    // Even two live sessions of the SAME CLI must remain visible as two panes.
    await win.webContents.executeJavaScript(`(() => { const t=state.tasks.find(t=>t.id==='layout-fixture'); t.runs[1].agentId='codex'; renderDetail(); })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.interactive-terminal').length`), 2);
    await win.webContents.executeJavaScript(`(() => { const t=state.tasks.find(t=>t.id==='layout-fixture'); t.runs[1].agentId='claude'; renderDetail(); })()`);
    // Resize the workflow using the real pointer handler and verify it remembers its size.
    const splitter = await win.webContents.executeJavaScript(`(() => { const r=document.querySelector('.task-execution-view > .pane-splitter').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+3)} })()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...splitter});
    win.webContents.sendInputEvent({type:'mouseMove',x:splitter.x,y:splitter.y+110,movementX:0,movementY:110});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:splitter.x,y:splitter.y+110});
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.workflow-section').getBoundingClientRect().height > 100`));
    await win.webContents.reload();
    await new Promise(resolve => setTimeout(resolve, 300));
    await win.webContents.executeJavaScript(`document.querySelectorAll('.task-panel-tab').forEach(b => { if (b.textContent === '実行') b.click(); });`);
    await win.webContents.executeJavaScript(`document.querySelectorAll('.agent-terminal-tab').forEach(b => { if (b.textContent === 'codex') b.click(); });`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(await screen(), /GUI_PTY_OK/);
    const verifyRestarts = async () => {
    // Run after the goal fixture below has been created and approved.
    goalTask = { ...goalTask, state: 'paused' };
    const reportDirectory = join(directory, 'restart-source'); mkdirSync(join(reportDirectory, 'figures'), { recursive: true });
    writeFileSync(join(reportDirectory, 'report.tex'), 'Preserved original report source');
    writeFileSync(join(reportDirectory, 'figures', 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    goalTask.report = { state: 'draft', texPath: join(reportDirectory, 'report.tex'), pdfPath: join(reportDirectory, 'report.pdf') };
    await win.webContents.executeJavaScript(`(() => { document.getElementById('nav-tasks').click(); state.selectedTaskId='goal-fixture'; state.tasks.find(t=>t.id==='goal-fixture').state='paused'; renderTasks(); renderDetail(); })()`);
    await win.webContents.executeJavaScript(`{const s=document.querySelector('.followup-composer [aria-label="進め方"]');s.value='carry';s.dispatchEvent(new Event('change'));}`);
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.restart-dialog').open`));
    await win.webContents.executeJavaScript(`[...document.querySelector('.restart-dialog').querySelectorAll('button')].find(b=>b.textContent==='キャンセル').click()`);
    assert.equal(restartedTasks.length, 0);
    for (const mode of ['carry','fresh']) {
      await win.webContents.executeJavaScript(`(() => { state.selectedTaskId='goal-fixture'; renderTasks(); renderDetail(); const s=document.querySelector('.followup-composer [aria-label="進め方"]'); s.value=${JSON.stringify(mode)}; s.dispatchEvent(new Event('change')); })()`);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.restart-dialog').textContent`), mode === 'fresh' ? /元コードや入力資料も自動コピーしません/ : /作業フォルダを共有/);
      if (mode === 'carry') {
        rejectRestartOnce = true;
        await win.webContents.executeJavaScript(`[...document.querySelector('.restart-dialog').querySelectorAll('button')].find(b=>b.textContent==='新しいタスクを作成').click()`);
        for (let i=0;i<100 && !await win.webContents.executeJavaScript(`document.querySelector('.restart-dialog [role="alert"]').textContent.includes('copy unavailable')`);i++) await new Promise(resolve=>setTimeout(resolve,30));
        assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.restart-dialog').open`));
      }
      writeFileSync(join(__dirname, '..', `output/pdf/restart-${mode}-smoke.png`), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`(() => { const b=[...document.querySelector('.restart-dialog').querySelectorAll('button')].find(b=>b.textContent==='新しいタスクを作成'); b.click(); b.click(); })()`);
      for (let i=0;i<100 && await win.webContents.executeJavaScript(`!!document.querySelector('.restart-dialog')`);i++) await new Promise(resolve=>setTimeout(resolve,30));
      assert.equal(restartedTasks.length, mode==='carry'?1:2);
      const next = restartedTasks.at(-1);
      assert.deepEqual(next.goal, goalTask.goal); assert.equal(next.state, 'queued');
      if (mode === 'carry') {
        assert.equal(readFileSync(next.report.texPath, 'utf8'), 'Preserved original report source');
        assert.equal(readFileSync(join(directory, next.id, 'figures', 'figure.svg'), 'utf8'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
        assert.equal(readFileSync(goalTask.report.texPath, 'utf8'), 'Preserved original report source');
      }
      assert.equal(await win.webContents.executeJavaScript(`state.selectedTaskId`), next.id);
      assert.equal(await win.webContents.executeJavaScript(`state.tasks.find(t=>t.id==='goal-fixture').state`), 'paused');
    }
    };
    assert.ok(errors.length === 0, errors.join('\n'));
    // Render stored and interrupted histories without interpreting raw PTY frames as prose.
    const historyProbe = await win.webContents.executeJavaScript(`(() => {
      const raw='\\x1b[?2031h\\x1b]10;?\\x07\\x1bP+q4d73\\x1b\\\\\\x1b_Gi=31337;AAAA\\x1b\\\\frame';
      const unit={id:'history-b',title:'全文献照合B',state:'pending',output:raw,error:'API接続失敗'};
      const t={...state.tasks[0],roundNumber:2,roundKind:'continue',workUnits:[unit],history:[{number:1,kind:'initial',state:'paused',instruction:'以前',workUnits:[unit]}],interruptedHistory:[{number:2,kind:'continue',state:'paused',instruction:'中断前',workUnits:[unit]}]};
      const view=buildTaskHistory(t);
      return {text:view.textContent,outputs:[...view.querySelectorAll('.history-report-body')].map(e=>e.textContent),original:t.workUnits[0].output,raw};
    })()`);
    assert.equal(historyProbe.outputs.length,3);
    for (const output of historyProbe.outputs) { assert.match(output,/CLI原画面/); assert.match(output,/API接続失敗/); assert.doesNotMatch(output,/\x1b|4d73|AAAA|frame/); }
    assert.equal(historyProbe.original,historyProbe.raw);
    assert.match(historyProbe.text,/再開前の記録/);
    // Real editable writing rules and native disclosure UI. No live settings touched.
    for (let i=0; i<100 && !await win.webContents.executeJavaScript(`Object.keys(finishingEditors).length===6 && Object.values(finishingEditors).every(e=>e.settings && !e.busy)`); i++) await new Promise(resolve=>setTimeout(resolve,30));
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('nav-settings').click(); selectSettingsPage('settings-writing');
      document.querySelector('#writing-rule-sections > details').open=false;
      document.querySelector('#writing-rule-sections > details > summary').click();
      const editor=document.getElementById('finishing-rules'); editor.value+='\\nGUI保存テスト'; editor.dispatchEvent(new Event('input'));
      document.querySelector('#writing-rule-sections > details > summary').click();
      document.querySelector('#writing-rule-sections > details > summary').click();
      document.getElementById('finishing-save').click();
    })()`);
    for (let i=0; i<100 && await win.webContents.executeJavaScript(`finishingEditors.common.busy`); i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.match((await finishing.capture()).rules, /GUI保存テスト/);
    await win.webContents.executeJavaScript(`document.getElementById('finishing-reload').click()`);
    for (let i=0; i<100 && await win.webContents.executeJavaScript(`finishingEditors.common.busy`); i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules').value`), /GUI保存テスト/);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('finishing-error').textContent`), '');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#writing-rule-sections > details').open`),true);
    assert.ok(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules').getBoundingClientRect().height>0`));
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('finishing-heading').textContent`),/レポート執筆ルール/);
    await win.webContents.executeJavaScript(`document.querySelector('#writing-rule-sections > details > summary').click()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#writing-rule-sections > details').open`),false);
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules').value`),/GUI保存テスト/);
    // Style and verification have independent editors but are still mandatory
    // in the fixed snapshot. Imported source kits are not appended again.
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.writing-rule-section').length`), 6);
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules-style').value`), /口語・比喩を具体化/);
    assert.doesNotMatch(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules-style').value`), /公開資料から追加|調査出典|https?:\/\//);
    assert.doesNotMatch(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules').value`), /口語・比喩を具体化/);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#finishing-rules-expression, #finishing-rules-academic').length`), 0);
    await win.webContents.executeJavaScript(`document.querySelector('#writing-rule-sections > details > summary').click()`);
    const commonRevision = (await finishing.get()).current.revision;
    for (const section of ['style','verification','paper','poster','slides']) {
      await win.webContents.executeJavaScript(`(() => {
        const panel=document.getElementById('writing-editor-${section}'); panel.parentElement.open=true;
        const editor=document.getElementById('finishing-rules-${section}'); editor.value+='\\nGUI独立保存:${section}'; editor.dispatchEvent(new Event('input'));
        document.getElementById('finishing-save-${section}').click();
      })()`);
      for (let i=0;i<100 && await win.webContents.executeJavaScript(`finishingEditors.${section}.busy`);i++) await new Promise(resolve=>setTimeout(resolve,30));
      assert.match((await finishing.get(section)).current.rules, new RegExp(`GUI独立保存:${section}`));
      assert.equal((await finishing.get()).current.revision, commonRevision);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('finishing-error-${section}').textContent`), '');
      await win.webContents.executeJavaScript(`document.getElementById('writing-editor-${section}').parentElement.open=false`);
    }
    await win.webContents.executeJavaScript(`(() => {
      const editor=document.getElementById('finishing-rules-poster'); editor.value+='\\n未保存ポスター'; editor.dispatchEvent(new Event('input'));
      document.getElementById('finishing-reload-slides').click();
    })()`);
    for (let i=0;i<100 && await win.webContents.executeJavaScript(`finishingEditors.slides.busy`);i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules-poster').value`), /未保存ポスター/);
    assert.doesNotMatch((await finishing.get('poster')).current.rules, /未保存ポスター/);
    legacyWritingResponse = true;
    await win.webContents.executeJavaScript(`document.getElementById('finishing-reload-slides').click()`);
    for (let i=0;i<100 && await win.webContents.executeJavaScript(`finishingEditors.slides.busy`);i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('finishing-error-slides').textContent`), /再起動/);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('finishing-save-slides').disabled`), true);
    legacyWritingResponse = false;
    await win.webContents.executeJavaScript(`document.getElementById('finishing-reload-slides').click()`);
    for (let i=0;i<100 && await win.webContents.executeJavaScript(`finishingEditors.slides.busy`);i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('finishing-save-slides').disabled`), false);
    const savedPaper = (await finishing.get('paper')).current.rules;
    await win.webContents.executeJavaScript(`(() => {
      const originalConfirm=window.confirm; window.confirm=()=>true;
      try { document.getElementById('finishing-default-paper').click(); } finally { window.confirm=originalConfirm; }
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules-paper').value`), (await finishing.get('paper')).defaultRules);
    assert.equal((await finishing.get('paper')).current.rules, savedPaper, 'default restoration is a draft until saved');
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('finishing-rules-poster').value`), /未保存ポスター/);
    await win.webContents.executeJavaScript(`document.getElementById('writing-editor-common').parentElement.open=false; document.getElementById('writing-rule-sections').scrollIntoView({block:'center'})`);
    await new Promise(resolve=>setTimeout(resolve,150));
    writeFileSync(join(__dirname, '..', 'output/pdf/writing-rule-sections-smoke.png'), (await win.webContents.capturePage()).toPNG());
    if (process.argv.includes('--writing-only')) {
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log('Writing rules UI: six focused sections, independent style/verification saves, reload and draft preservation passed.');
      runner.cancelAll(); await Promise.all(runs);
      app.exit(0);
      return;
    }
    await win.webContents.executeJavaScript(`document.querySelector('#writing-rule-sections > details > summary').click()`);
    // One editable rule per mode, with real persistence. No user settings touched.
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-preset').options.length`), (await presets.catalog()).presets.length + 1);
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('nav-settings').click();
      const select=document.getElementById('preset-manager-select'); select.value='coding'; select.dispatchEvent(new Event('change'));
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('preset-rules').readOnly`), false);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('preset-save').disabled`), true);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('preset-copy')`), null);
    const presetId = await win.webContents.executeJavaScript(`document.getElementById('preset-manager-select').value`);
    assert.equal(presetId, 'coding');
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('preset-rules').readOnly`), false);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('preset-defaults')`), null);
    const originalPresetGoal = (await presets.capture(presetId)).manifest.goal;
    await win.webContents.executeJavaScript(`(() => { selectSettingsPage('settings-presets'); document.getElementById('preset-edit').click(); const rules=document.getElementById('preset-rules'); rules.value+=${JSON.stringify("\n初回の保存済みルール")}; rules.dispatchEvent(new Event('input')); document.getElementById('preset-save').click(); })()`);
    for (let i=0; i<100 && await win.webContents.executeJavaScript(`presetsBusy`); i++) await new Promise(resolve=>setTimeout(resolve,30));
    const capturedPreset = await presets.capture(presetId);
    assert.match(capturedPreset.rules, /初回の保存済みルール/);
    assert.deepEqual(capturedPreset.manifest.goal, originalPresetGoal);
    await win.webContents.executeJavaScript(`selectSettingsPage('settings-presets'); document.getElementById('preset-raw-editor').scrollIntoView({block:'start'})`);
    await new Promise(resolve=>setTimeout(resolve,100));
    writeFileSync(join(__dirname,'..','output/pdf/preset-goal-editor-smoke.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.getElementById('task-preset').value=${JSON.stringify(presetId)}; document.getElementById('task-preset').dispatchEvent(new Event('change'));`);
    // Exercise the real Dispatch -> Goal editor -> approval UI with isolated persistence.
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-details').disabled`), false);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-cwd').value`), '');
    await win.webContents.executeJavaScript(`document.getElementById('task-workspace-mode').value='existing';document.getElementById('task-cwd').value='/tmp'`);
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-details').disabled`), false);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-workflow-mode')`), null);
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('nav-dispatch').click();
      document.getElementById('task-title').value = 'Goal UI fixture';
      document.getElementById('task-prompt').value = 'データを検証して説明する';
      document.querySelector('#task-form button[value="manual"]').click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(goalTask.awaitingReason, 'goal');
    assert.equal(goalTask.workspaceMode, 'existing');
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-details').disabled`), false);
    assert.equal(goalTask.workPreset.manifest.id, presetId);
    assert.equal(goalTask.workPreset.revision, capturedPreset.revision);
    assert.ok(goalTask.goal.criteria.some(c=>c.id==='behavior'));
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-preset-rules').textContent`), /初回の保存済みルール/);
    await win.webContents.executeJavaScript(`(() => {
      const input=document.querySelector('.goal-editor .execution-settings input[aria-label="トークン予算目安"]');
      input.value='120000'; input.dispatchEvent(new Event('input',{bubbles:true}));
      [...document.querySelectorAll('.goal-actions button')].find(b=>b.textContent==='下書きを保存').click();
    })()`);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(goalTask.execution.tokenBudget,120000);
    await new Promise(resolve=>setTimeout(resolve,50));
    await win.webContents.executeJavaScript(`document.getElementById('nav-tasks').click()`);
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor') !== null`));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.followup-composer')`), null);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .primary-button').disabled`), true);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-readiness').textContent`), /未解決の確認事項が1件/);
    await win.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('.goal-editor');
      const set = (label, text) => { const input = [...editor.querySelectorAll('textarea')].find(e => e.getAttribute('aria-label') === label); input.value = text; input.dispatchEvent(new Event('input', {bubbles:true})); };
      set('ゴール・目的', '検証済みデータの説明');
      editor.querySelector('[aria-label="確認事項 1 をゴールに反映済み"]').click();
      const target = editor.querySelector('input[aria-label="作業目安時間（分）"]'); target.value = '45'; target.dispatchEvent(new Event('input', {bubbles:true}));
      editor.querySelector('textarea').focus();
      renderDetail();
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.activeElement.getAttribute('aria-label')`), 'ゴール・目的');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .primary-button').disabled`), false);
    // Selection excludes candidates rather than changing their priority; additions keep full verification.
    await win.webContents.executeJavaScript(`(() => {
      const list=document.querySelector('[data-goal-list="criteria"]');
      for (const check of list.querySelectorAll('.goal-choice-label input')) check.click();
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .primary-button').disabled`), true);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-readiness').textContent`), /必須/);
    await win.webContents.executeJavaScript(`(() => {
      for (const check of document.querySelectorAll('[data-goal-list="criteria"] .goal-choice-label input')) check.click();
      const input=document.querySelector('input[aria-label="成果物を追加"]'); input.value='GUI未選択の成果物'; input.dispatchEvent(new Event('input')); renderDetail();
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('input[aria-label="成果物を追加"]').value`), 'GUI未選択の成果物');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .primary-button').disabled`), true);
    await win.webContents.executeJavaScript(`(() => {
      const list=document.querySelector('[data-goal-list="deliverables"]'); list.querySelector('.goal-add-line button').click();
      [...list.querySelectorAll('.goal-choice')].find(row=>row.textContent.includes('GUI未選択の成果物')).querySelector('input[type="checkbox"]').click();
      const input=document.querySelector('input[aria-label="達成条件を追加"]'); input.value='GUI追加検証'; input.dispatchEvent(new Event('input'));
      document.querySelector('[data-goal-list="criteria"] .goal-add-line button').click();
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .primary-button').disabled`), true);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-readiness').textContent`), /検証方法/);
    await win.webContents.executeJavaScript(`(() => {
      const row=[...document.querySelectorAll('.goal-criterion')].find(row=>row.textContent.includes('GUI追加検証'));
      const verification=row.querySelector('textarea[aria-label^="検証方法"]'); verification.value='追加条件の出力と期待値を比較する'; verification.dispatchEvent(new Event('input'));
      row.querySelector('input[type="checkbox"]').click(); row.querySelector('details').open=false;
      document.activeElement?.blur(); renderDetail();
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .primary-button').disabled`), false);
    assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.goal-criterion')].find(row=>row.textContent.includes('GUI追加検証')).querySelector('input').checked`), false);
    // A manually resolved question stays reversible while editing, including after a re-render.
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="確認事項 1 をゴールに反映済み"]').click()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .primary-button').disabled`), true);
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="確認事項 1 をゴールに反映済み"]').click()`);
    await win.webContents.executeJavaScript(`document.querySelectorAll('.goal-editor details').forEach(d=>d.open=false); document.querySelector('.goal-editor').scrollIntoView({block:'start'})`);
    await new Promise(resolve=>setTimeout(resolve,150));
    writeFileSync(join(__dirname, '..', 'output/pdf/goal-checklist-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('textarea[aria-label="AIへの補足・質問への回答"]');
      input.value = '未反映の回答'; input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .primary-button').disabled`), true);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-readiness').textContent`), /まだゴールに反映/);
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('textarea[aria-label="AIへの補足・質問への回答"]');
      input.value = ''; input.dispatchEvent(new Event('input', {bubbles:true}));
      const task = state.tasks.find(t => t.id === 'goal-fixture');
      task.state = 'planning'; task.goalPreparation = true; renderDetail();
    })()`);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-readiness').textContent`), /AIがゴールを再提案中/);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-fields').disabled`), true);
    await win.webContents.executeJavaScript(`(() => {
      const task = state.tasks.find(t => t.id === 'goal-fixture');
      task.state = 'awaiting-input'; task.goalPreparation = false; renderDetail();
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.goal-fields').disabled`), false);
    await win.webContents.executeJavaScript(`document.querySelector('.goal-editor .primary-button').click()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(goalTask.goal.status, 'approved'); assert.equal(goalTask.state, 'queued');
    assert.equal(goalTask.autonomy.enabled, true); assert.equal(goalTask.autonomy.maxCycles, 3);
    assert.equal(goalTask.autonomy.targetMinutes, 45);
    assert.deepEqual(goalTask.workUnits.map(u => u.role), ['worker', 'reporter', 'reviewer', 'reviewer']);
    assert.equal(goalTask.workUnits[0].primary, true);
    await win.webContents.executeJavaScript(`openTaskPanel(state.tasks.find(t=>t.id==='goal-fixture'),'goal')`);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor').textContent`), /実行計画と体制/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor').textContent`), /時間による強制終了はしません/);
    assert.equal(goalTask.goal.objective, '検証済みデータの説明');
    assert.ok(goalTask.goal.unselected.deliverables.includes('GUI未選択の成果物'));
    assert.ok(goalTask.goal.unselected.criteria.some(c=>c.description==='GUI追加検証'));
    assert.ok(!goalTask.goal.criteria.some(c=>c.description==='GUI追加検証'));
    assert.equal(goalTask.goalHistory.length, 2, 'inline strategy draft save and final goal approval each retain a revision');
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor h3').textContent.includes('承認済み')`));
    assert.ok(await win.webContents.executeJavaScript(`!!document.querySelector('textarea[aria-label="AIへの補足・質問への回答"]')`));
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('textarea[aria-label="AIへの補足・質問への回答"]');
      input.value = '承認後もAIで整理'; input.dispatchEvent(new Event('input', {bubbles:true}));
      [...document.querySelectorAll('.goal-editor button')].find(b=>b.textContent === '編集内容・回答からAIで再提案').click();
    })()`);
    for (let i=0; i<100 && await win.webContents.executeJavaScript(`goalBusy.size > 0`); i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(goalRefinements, 1); assert.equal(goalTask.goal.status, 'draft');
    assert.equal(goalTask.state, 'awaiting-input'); assert.equal(goalTask.goal.objective, 'AI再整理後のゴール');
    await win.webContents.executeJavaScript(`state.selectedTaskPanels.set('goal-fixture','overview'); renderDetail(); document.querySelector('.goal-editor .primary-button').click()`);
    for (let i=0; i<100 && await win.webContents.executeJavaScript(`goalBusy.size > 0`); i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(goalTask.goal.status, 'approved');
    await win.webContents.executeJavaScript(`(() => {
      const task = state.tasks.find(t => t.id === 'goal-fixture');
      task.autonomyState = 'cycle-limit'; task.autonomyCycle = 3; task.state = 'awaiting-input'; task.awaitingReason = 'result';
      task.evaluations = [{ goalRevision: task.goal.revision, round: 1, cycle: 3, reviewedAt: new Date().toISOString(), summary: '検証待ちの条件が残っています', criteria: [{criterionId: 'report', status:'unverified', detail:'表示確認が未完了', evidence:[]}]}];
      openTaskPanel(task,'goal');
    })()`);
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.goal-ledger').textContent.includes('修正サイクル上限')`));
    assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].some(b => b.textContent === 'タスクを完了にする')`), false);
    await win.webContents.executeJavaScript(`(() => {
      const task = state.tasks.find(t => t.id === 'goal-fixture');
      task.state = 'paused'; task.resumeFromUnitId = task.workUnits.find(u => u.role === 'reporter').id;
      task.error = 'CLIが途中終了しました。'; renderDetail();
    })()`);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.detail-actions .primary-button').textContent`), /中断した工程から再開/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.detail-actions .primary-button').title`), /完了済み工程/);
    await win.webContents.executeJavaScript(`document.querySelector('.detail-actions .primary-button').click()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(resumedTaskId, 'goal-fixture');
    await new Promise(resolve => setTimeout(resolve, 100));
    writeFileSync(join(__dirname, '..', 'output/pdf/goal-smoke.png'), (await win.webContents.capturePage()).toPNG());
    // Render real saved/revised plans, including retired failed readers. These
    // fixtures use isolated state and never launch an external agent.
    const { applyExecutionPlan, replanAfterFailure } = require('../dist/core/execution-plan');
    const planned = structuredClone(goalTask);
    const owner = planned.workUnits.find(u => u.primary); owner.state = 'completed';
    const planInput = { summary: '一次資料を確認し、主担当が統合して説明する', reason: '独立した根拠確認が必要なため専門担当を配置', primaryWork: '確認済み根拠から本文と図を作り、TeXへ反映する', acceptance: '出典と数値計算を照合する', criterionIds: planned.goal.criteria.map(c => c.id), estimatedTokens: 8000, estimatedMinutes: 30, escalation: '新しいデータ利用権限が必要な場合は確認する', tasks: ['source', 'verify'].map(key => ({ key, title: key === 'source' ? '一次資料の調査担当' : '独立検証担当', instructions: '参照資料を読み取り専用で調べる', deliverable: '根拠と出典の一覧', acceptance: '原文との照合', criterionIds: [planned.goal.criteria[0].id], dependsOn: [], estimatedTokens: 1000 })) };
    Object.assign(planned, applyExecutionPlan(planned, owner, planInput));
    planned.executionPlans[0].coordination = { criticalPath:'実装→検証→統合', parallelBenefit:'独立した根拠確認を同時に進める', contextPlan:'直接依存する成果だけを渡す', resourcePlan:'複数サービスへ配分してレビュー予算を残す' };
    planInput.coordination = planned.executionPlans[0].coordination;
    const readers = planned.workUnits.filter(u => u.subtask);
    readers[0].state = 'completed'; readers[0].assignedAgentId = 'codex';
    readers[1].state = 'failed'; readers[1].error = '検証資料にアクセスできません';
    const parallelPlan = structuredClone(planned);
    Object.assign(planned, replanAfterFailure(planned, readers[1].error));
    const replanner = planned.workUnits.find(u => u.primary && u.state === 'pending'); replanner.state = 'completed';
    Object.assign(planned, applyExecutionPlan(planned, replanner, { ...planInput, reason: '検証資料にアクセスできないため、取得済み資料を主担当が検証する', tasks: [] }));
    planned.executionPlans.at(-1).refinement = { objective:'根拠から説明方法を改善する <img src=x onerror=alert(1)>', proposalKeys:[], stopWhen:'有用な追加変更がなくなった場合' };
    const activeWriter=planned.workUnits.find(u=>u.primary && !u.planPhase && u.state==='pending');
    activeWriter.state='running'; activeWriter.assignedAgentId='codex';
    planned.runs.push(...['failed','running'].map((runState,i)=>({id:'card-attempt-'+i,workUnitId:activeWriter.id,agentId:'codex',role:'worker',state:runState,startedAt:new Date().toISOString(),output:'',providerKey:'openai-default'})));
    planned.runs.at(-1).skillUsage = {source:'mcp',reads:[{id:'fair-benchmark',revision:'a'.repeat(64),bytes:1200,calls:2}],estimatedTokens:800,truncated:false};
    await win.webContents.executeJavaScript(`(() => {
      const task = state.tasks.find(t => t.id === 'goal-fixture'); Object.assign(task, ${JSON.stringify(planned)});
      openTaskPanel(task,'plan');
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-plan-version').length`), 2);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-strategy').textContent`),/依存関係.*実装→検証→統合/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-strategy').textContent`),/内容改善の焦点：根拠から説明方法を改善する/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-strategy').textContent`),/主担当が代案・弱点を点検/);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-plan-strategy img').length`),0);
    await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-strategy summary').click()`);
    await new Promise(resolve=>setTimeout(resolve,30));
    await win.webContents.executeJavaScript(`renderDetail()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-strategy').open`),true);
    await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-strategy summary').click()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-work-card').length`),planned.workUnits.length);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-work-card.running[open]').length`),1);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-work-card.pending[open]').length`),0);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-history').open`),false);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-work-card.running .work-card-extra').textContent`),/実行履歴（2回）/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-work-card.running .work-card-body').textContent`),/fair-benchmark@aaaaaaaa ×2.*800.*課金実測・適用済みの証明ではありません/);
    for (const role of ['reporter','reviewer']) for(const u of planned.workUnits.filter(u=>u.role===role)) {
      assert.ok(await win.webContents.executeJavaScript(`!!document.querySelector('[data-unit-id="${u.id}"]')`));
    }
    await win.webContents.executeJavaScript(`document.querySelector('.execution-work-card.running > summary').click()`);
    await new Promise(resolve=>setTimeout(resolve,30));
    await win.webContents.executeJavaScript(`renderDetail()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.execution-work-card.running').open`),false);
    await win.webContents.executeJavaScript(`document.querySelector('.execution-work-card.running > summary').click()`);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent`), /主担当＋専門担当0件/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent`), /再計画で撤回/);
    await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-plan-version')[1].open=true`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await win.webContents.executeJavaScript(`renderDetail()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-plan-version')[1].open`), true);
    assert.ok(await win.webContents.executeJavaScript(`(() => { const pane=document.querySelector('.task-panel-content.plan'); return pane.scrollWidth <= pane.clientWidth+2; })()`));
    await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-history').open=false`);
    writeFileSync(join(__dirname, '..', 'output/pdf/execution-plan-smoke.png'), (await win.webContents.capturePage()).toPNG());
    // Persisted coordinator decisions show separately from actual worker/review
    // results, including why a useful extra package was added.
    const orchestrated = structuredClone(parallelPlan);
    orchestrated.state = 'running'; orchestrated.workflowMode = 'primary';
    orchestrated.execution = { ...orchestrated.execution, decompose:true, maxParallel:2, tokenBudget:undefined };
    orchestrated.workUnits.filter(u => u.subtask)[1].state = 'running';
    const {newCoordinator, coordinatorStart, applyCoordinatorDecision}=require('../dist/core/orchestrator');
    const coordinator = newCoordinator(orchestrated,[orchestrated.workUnits.find(u=>u.subtask&&u.state==='completed').id]);
    assert.ok(coordinator); Object.assign(orchestrated,coordinatorStart(orchestrated,coordinator));
    await win.webContents.executeJavaScript(`Object.assign(state.tasks.find(t=>t.id==='goal-fixture'),${JSON.stringify(orchestrated)});renderDetail()`);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.orchestrator-status').textContent`),/未着手の作業を確認中/);
    const refinementTarget = orchestrated.workUnits.find(u=>u.primary&&!u.planPhase&&u.state==='pending');
    coordinator.output='<work-plan>'+JSON.stringify({action:'adjust',reason:'独立した境界条件を先に確認し、統合時の待ち時間を減らす',tasks:[{key:'boundary',title:'境界条件の追加確認',instructions:'既存資料を確認',deliverable:'根拠一覧',acceptance:'一次資料と照合',criterionIds:[orchestrated.goal.criteria[0].id],dependsOn:[],estimatedTokens:1000,purpose:'verify'}],refinements:[{unitId:refinementTarget.id,note:'既存の達成条件を維持し、新しく見つかった境界条件も検証する。'}]})+'</work-plan>';
    Object.assign(orchestrated,applyCoordinatorDecision(orchestrated,coordinator));
    await win.webContents.executeJavaScript(`Object.assign(state.tasks.find(t=>t.id==='goal-fixture'),${JSON.stringify(orchestrated)});renderDetail();document.querySelector('.orchestrator-status details').open=true`);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.orchestrator-status').textContent`),/1件へ指示補足・1件追加.*境界条件/);
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent.includes('境界条件の追加確認')`));
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent`), /新しく見つかった境界条件も検証する/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-plan-view').textContent`), /独立検証・品質向上/);
    await win.webContents.executeJavaScript(`document.querySelector('[data-unit-id="${refinementTarget.id}"]').open=true`);
    await new Promise(resolve=>setTimeout(resolve,150));
    writeFileSync(join(__dirname,'..','output/pdf/orchestrator-smoke.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`Object.assign(state.tasks.find(t=>t.id==='goal-fixture'),${JSON.stringify(planned)},{orchestratorDecisions:undefined});renderDetail()`);
    let instructionExports = 0;
    const instructionText = '===== 保存済みの指示 =====\n日本語の確定指示\n' + '全文を省略せずに表示する。\n'.repeat(100);
    ipcMain.handle('fixture:instructions', (_e, id) => { assert.equal(id,'goal-fixture'); return {id:'instruction-snapshot',text:instructionText,filename:'指示書.txt',createdAt:new Date().toISOString()}; });
    ipcMain.handle('fixture:instructions-export', (_e, id) => { assert.equal(id,'instruction-snapshot'); instructionExports++; return {canceled:false,path:join(directory,'指示書.txt')}; });
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.execution-plan-view > button')].find(b=>b.textContent==='指示書の全文表示・TXT書き出し').click()`);
    for (let i=0;i<100 && !await win.webContents.executeJavaScript(`document.querySelector('.instruction-document-dialog textarea')?.value.includes('日本語の確定指示')`);i++) await new Promise(r=>setTimeout(r,30));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.instruction-document-dialog textarea').value`),instructionText);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.instruction-document-dialog textarea').readOnly`),true);
    const documentButton = label => `[...document.querySelectorAll('.instruction-document-dialog button')].find(b=>b.textContent===${JSON.stringify(label)})`;
    await win.webContents.executeJavaScript(`${documentButton('TXTで書き出し')}.click()`);
    for(let i=0;i<100 && !instructionExports;i++) await new Promise(r=>setTimeout(r,30));
    assert.equal(instructionExports,1);
    await new Promise(r=>setTimeout(r,80));
    writeFileSync(join(__dirname, '..', 'output/pdf/instruction-document-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`${documentButton('閉じる')}.click()`);
    for(let i=0;i<100 && await win.webContents.executeJavaScript(`!!document.querySelector('.instruction-document-dialog')`);i++) await new Promise(r=>setTimeout(r,30));
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('.instruction-document-dialog')`),false);
    const researchPreset = await presets.capture('research-project');
    const researchUnits = orderAutonomousUnits(pairUnits(createExecutionWorkflow({workflowMode:'primary',workPreset:researchPreset})));
    await win.webContents.executeJavaScript(`(() => {
      const t=state.tasks.find(t=>t.id==='goal-fixture');
      t.workUnits=${JSON.stringify(researchUnits)}; t.executionPlans=[]; t.workPreset=${JSON.stringify(researchPreset)};
      renderDetail();
      document.querySelector('.execution-work-card').open=true;
      document.querySelector('.task-panel-content.plan').scrollTop=0;
    })()`);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.execution-work-card').textContent`),/アイディアモード/);
    const stageCards = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.execution-work-card')).slice(0,4).map(e=>e.textContent)`);
    for(const [i,name] of ['アイディアモード','関連研究調査モード','コーディング（実装）モード','論文執筆モード'].entries()) assert.ok(stageCards[i].includes(name));
    assert.match(await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-work-card')[1].textContent`),/01待ち/);
    await new Promise(r=>setTimeout(r,100));
    writeFileSync(join(__dirname, '..', 'output/pdf/research-mode-plan-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`state.tasks.find(t=>t.id==='goal-fixture').workPreset=${JSON.stringify(goalTask.workPreset)};`);
    const repairInstructions = 'Repair ONLY these unmet required conditions: []\nFurther required investigation within the approved goal: ["境界値の追加検証が必要"]\nReviewer instructions: 検証根拠を確認する\nPreserve already passing behavior, scope and the approved goal.';
    await win.webContents.executeJavaScript(`(() => {
      const t=state.tasks.find(t=>t.id==='goal-fixture');
      t.workUnits=[{id:'repair-card-fixture',role:'worker',primary:true,title:'主担当',state:'running',mode:'write',dependsOn:[],attemptedAgentIds:[],instructions:${JSON.stringify(repairInstructions)}}];
      renderDetail();
    })()`);
    const repairCard = await win.webContents.executeJavaScript(`document.querySelector('.execution-work-card .work-card-body dl').textContent`);
    assert.match(repairCard, /追加検討事項を調査/); assert.match(repairCard, /境界値の追加検証が必要/);
    assert.doesNotMatch(repairCard, /Repair ONLY|\[\]/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.work-card-extra').textContent`), /Repair ONLY/);
    await new Promise(resolve=>setTimeout(resolve,50));
    writeFileSync(join(__dirname, '..', 'output/pdf/repair-work-card-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`Object.assign(state.tasks.find(t=>t.id==='goal-fixture'),${JSON.stringify(parallelPlan)});renderDetail()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.execution-work-parallel .execution-work-card').length`),2);
    await win.webContents.executeJavaScript(`Object.assign(state.tasks.find(t=>t.id==='goal-fixture'),${JSON.stringify(planned)});renderDetail()`);
    await win.webContents.executeJavaScript(`(() => { document.getElementById('nav-settings').click(); selectSettingsPage('settings-presets'); const rules=document.getElementById('preset-rules'); rules.value+=${JSON.stringify("\n次のタスクだけに適用するルール")}; rules.dispatchEvent(new Event('input')); document.getElementById('preset-save').click(); })()`);
    for (let i=0; i<100 && await win.webContents.executeJavaScript(`presetsBusy`); i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.notEqual((await presets.capture(presetId)).revision, goalTask.workPreset.revision);
    assert.doesNotMatch(goalTask.workPreset.rules, /次のタスクだけ/);
    const taskCommonBefore = goalTask.workPreset.commonRules;
    for (let i=0;i<100 && await win.webContents.executeJavaScript(`!presetCommon || presetCommonBusy`);i++) await new Promise(resolve=>setTimeout(resolve,30));
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('settings-work-common').open=true;
      const editor=document.getElementById('work-common-rules'); editor.value+='\\nGUIの共通原則の保存'; editor.dispatchEvent(new Event('input'));
      document.getElementById('work-common-save').click();
    })()`);
    for (let i=0;i<100 && await win.webContents.executeJavaScript(`presetCommonBusy`);i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.match((await presets.getCommon()).rules,/GUIの共通原則/);
    assert.equal(goalTask.workPreset.commonRules, taskCommonBefore);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('work-common-error').textContent`), '');
    await win.webContents.executeJavaScript(`document.getElementById('work-common-reload').click()`);
    for (let i=0;i<100 && await win.webContents.executeJavaScript(`presetCommonBusy`);i++) await new Promise(resolve=>setTimeout(resolve,30));
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('work-common-rules').value`), /GUIの共通原則/);
    await win.webContents.executeJavaScript(`document.getElementById('settings-work-common').open=false`);
    assert.ok(await win.webContents.executeJavaScript(`(() => { const p=document.querySelector('.preset-panel'); return p.scrollWidth <= p.clientWidth+2; })()`));
    writeFileSync(join(__dirname, '..', 'output/pdf/preset-settings-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('nav-tasks').click(); state.selectedTaskId = 'goal-fixture'; renderTasks(); renderDetail();
      openTaskPanel(state.tasks.find(t=>t.id==='goal-fixture'),'goal');
      const select = document.querySelector('[aria-label="作業とレビューに利用するCLI"]');
      select.closest('details').open = true;
      for (const option of select.options) option.selected = true;
      [...select.closest('details').querySelectorAll('button')].find(b => b.textContent === '利用CLIを保存').click();
    })()`);
    for (let i = 0; i < 100 && goalTask.allowedAgentIds.length !== 3; i++) await new Promise(r => setTimeout(r, 30));
    assert.equal(goalTask.allowedAgentIds.length, 3);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor').textContent`), /直前とは別CLI/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor').textContent`), /2回連続合格/);
    await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('[aria-label="作業とレビューに利用するCLI"]');
      select.closest('details').open = true;
      for (const option of select.options) option.selected = option.value !== 'antigravity';
      select.closest('details').querySelector('button').click();
    })()`);
    for (let i = 0; i < 100 && allowedAgentSaves < 2; i++) await new Promise(r => setTimeout(r, 30));
    assert.equal(allowedAgentSaves, 2); assert.deepEqual(goalTask.allowedAgentIds, ['codex', 'claude']);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor').textContent`), /最低2種類/);
    await verifyRestarts();
    // Prepare a final host independently. Dispatch owns task selection; the
    // existing backend binding remains compatible with saved goals.
    const retainedGoal = structuredClone(goalTask.goal);
    await win.webContents.executeJavaScript(`document.getElementById('nav-settings').click(); document.getElementById('remote-mode').value='prepared'; document.getElementById('remote-mode').dispatchEvent(new Event('change')); document.getElementById('remote-form').requestSubmit()`);
    for (let i=0; i<100 && (await remoteSystems.list())[0].connectionMode !== 'prepared'; i++) await new Promise(r=>setTimeout(r,30));
    await authWait(`document.getElementById('remote-status').textContent.includes('保存しました')`);
    assert.ok(await win.webContents.executeJavaScript(`document.getElementById('remote-direct-folder').classList.contains('hidden') && !document.getElementById('remote-diagnose')`));
    await win.webContents.executeJavaScript(`document.getElementById('remote-dispatch').click()`);
    await remoteDialog();await new Promise(r=>setTimeout(r,50));await remoteButton('接続する');
    await new Promise(r=>setTimeout(r,50));await remoteButton('接続を確認してCLIを開く');
    await authWait(`preparedStatuses.get(${JSON.stringify(remoteProfile.id)})?.stage==='ready'`);
    writeFileSync(join(__dirname, '..', 'output', 'pdf', 'prepared-settings-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await remoteButton('画面を閉じる');
    await win.webContents.executeJavaScript(`showView('dispatch');document.getElementById('task-remote').value=${JSON.stringify(remoteProfile.id)};updateRemoteDispatch()`);
    await authWait(`state.currentView === 'dispatch' && document.getElementById('task-remote-note').textContent.includes('/home/scientist/final-project')`);
    await win.webContents.executeJavaScript(`(async()=>{const task=await api.bindTaskRemote('goal-fixture',${JSON.stringify(remoteProfile.id)});state.tasks=state.tasks.map(t=>t.id===task.id?task:t);state.selectedTaskId=task.id;renderTasks();openTaskPanel(task,'goal');showView('tasks')})()`);
    await authWait(`state.currentView === 'tasks' && document.querySelector('.task-setting-path')?.title.includes('scientist@final-node') && document.querySelector('.task-setting-path')?.textContent.includes('/home/scientist/final-project')`);
    assert.deepEqual(goalTask.goal, retainedGoal);
    assert.equal(goalTask.remote.preparedTarget.cwd, '/home/scientist/final-project');
    writeFileSync(join(__dirname, '..', 'output', 'pdf', 'prepared-environment-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`
      const stopped = state.tasks.find(t => t.id === 'goal-fixture');
      stopped.state = 'awaiting-input'; stopped.autonomyState = 'needs-input';
      stopped.error = 'ユーザ確認が必要です。bwrap: setting up uid map: Permission denied';
      stopped.workUnits = [{id:'denied-worker',role:'worker',primary:true,title:'Worker',state:'completed',dependsOn:[],attemptedAgentIds:['codex'],output:'<work-check>{"status":"ask-user","summary":"bwrap denied"}</work-check>'},{id:'waiting-reporter',role:'reporter',title:'Report',state:'pending',dependsOn:['denied-worker'],attemptedAgentIds:[]}];
      stopped.runs = [{id:'denied-run',workUnitId:'denied-worker',agentId:'codex',role:'worker',state:'completed',output:'',startedAt:new Date().toISOString()}];
      state.selectedTaskId=stopped.id; state.selectedTaskPanels.set(stopped.id,'execution'); workflowViews.set(stopped.id,'graph'); renderDetail();
    `);
    await authWait(`document.querySelector('.task-stop-notice').textContent.includes('bwrap denied') && document.querySelector('.workflow-section').textContent.includes('要対応・作業未完了') && document.querySelector('.workflow-section').textContent.includes('先行工程の対応待ち')`);
    writeFileSync(join(__dirname, '..', 'output', 'pdf', 'sandbox-blocked-smoke.png'), (await win.webContents.capturePage()).toPNG());
    let pauseResponse = false;
    ipcMain.handle('fixture:cancel-task', (_e, id) => {
      assert.equal(id, goalTask.id);
      if (pauseResponse === 'error') throw Error('Fixture pause failed');
      win.webContents.send('fixture:queue-changed', {running:false,stopping:false,activeTaskIds:[]});
      return pauseResponse;
    });
    const pauseButton = `[...document.querySelectorAll('#task-detail button')].find(b=>b.textContent==='一時停止')`;
    for (const response of [false, true, 'error']) {
      pauseResponse=response;
      await win.webContents.executeJavaScript(`state.queue.activeTaskIds=['goal-fixture']; renderDetail(); ${pauseButton}.click()`);
      await authWait(`document.getElementById('toast').textContent.includes(${JSON.stringify(response==='error' ? 'Fixture pause failed' : response ? '一時停止を要求しました' : '現在実行されていません')})`);
      assert.equal(await win.webContents.executeJavaScript(`!!${pauseButton}`), response==='error');
      if (response==='error') assert.equal(await win.webContents.executeJavaScript(`${pauseButton}.disabled`),false);
    }
    await win.webContents.executeJavaScript(`state.queue.activeTaskIds=[]; renderDetail()`);
    let recoveryReady = false, recoveryCalls = 0, permissionSaves = 0, fixturePermissions = 'sandbox';
    ipcMain.handle('fixture:codex-permissions', (_e, id, value, confirmed) => { assert.equal(id, goalTask.id); assert.equal(confirmed,value==='full-access'); permissionSaves++; fixturePermissions = value; goalTask.remote.codexPermissions=value; return {...goalTask}; });
    ipcMain.handle('fixture:recovery-inspect', () => ({ ready: recoveryReady, unitId:'denied-worker', unitTitle:'Worker', diagnostic:{codexPermissions:fixturePermissions,platform:'linux',kernel:'fixture',cwd:'/home/scientist/final-project',checks:[{name:fixturePermissions==='full-access' ? 'CLIの起動' : 'Codex 読み取り専用サンドボックス',ok:recoveryReady,detail:recoveryReady ? '成功' : 'bwrap: setting up uid map: Permission denied'}]} }));
    ipcMain.handle('fixture:recovery-resume', () => { recoveryCalls++; return goalTask; });
    // The permission-only entry point works even before goal approval and never
    // diagnoses, resumes, or approves the draft as a side effect of saving.
    const recoveryButton = text => `[...document.querySelectorAll('.environment-recovery-dialog button')].find(b=>b.textContent===${JSON.stringify(text)})`;
    goalTask.goal.status='draft';
    await win.webContents.executeJavaScript(`state.tasks.find(t=>t.id==='goal-fixture').goal.status='draft'; renderDetail(); [...document.querySelectorAll('#task-detail button')].find(b=>b.textContent==='遠隔Codexの権限…').click()`);
    await authWait(`document.querySelector('.environment-recovery-dialog')?.open`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.environment-recovery-dialog h3').textContent`), '遠隔Codexの権限');
    assert.equal(await win.webContents.executeJavaScript(`!!${recoveryButton('接続・診断')} || !!${recoveryButton('復旧を確認して再開')}`), false);
    await win.webContents.executeJavaScript(`window.confirm=()=>false; document.querySelector('[aria-label="このタスクの遠隔Codex権限"]').value='full-access'; ${recoveryButton('権限をこのタスクに保存')}.click()`);
    assert.equal(permissionSaves,0);
    await win.webContents.executeJavaScript(`window.confirm=()=>true; ${recoveryButton('権限をこのタスクに保存')}.click()`);
    await authWait(`document.querySelector('.recovery-diagnostic-output').textContent.includes('次回のCodex起動')`);
    assert.equal(permissionSaves,1); assert.equal(recoveryCalls,0);
    assert.notEqual(goalTask.goal.status,'approved');
    writeFileSync(join(__dirname, '..', 'output', 'pdf', 'remote-goal-permissions-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="このタスクの遠隔Codex権限"]').value='sandbox'; ${recoveryButton('権限をこのタスクに保存')}.click()`);
    await authWait(`document.querySelector('.environment-recovery-dialog').textContent.includes('保存済み：工程別サンドボックス')`);
    await win.webContents.executeJavaScript(`${recoveryButton('閉じる')}.click()`);
    await authWait(`!document.querySelector('.environment-recovery-dialog')`);
    permissionSaves=0;
    goalTask.goal.status='approved';
    await win.webContents.executeJavaScript(`state.tasks.find(t=>t.id==='goal-fixture').goal.status='approved'; renderDetail(); [...document.querySelectorAll('#task-detail button')].find(b=>b.textContent==='実行環境を復旧…').click()`);
    await authWait(`document.querySelector('.environment-recovery-dialog')?.open`);
    await win.webContents.executeJavaScript(`${recoveryButton('接続・診断')}.click()`);
    await authWait(`document.querySelector('.recovery-diagnostic-output').textContent.includes('環境の修正が必要')`);
    assert.equal(await win.webContents.executeJavaScript(`${recoveryButton('復旧を確認して再開')}.disabled`), true);
    assert.equal(recoveryCalls, 0);
    await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(join(__dirname, '..', 'output', 'pdf', 'remote-recovery-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`window.confirm=()=>false; const p=document.querySelector('[aria-label="このタスクの遠隔Codex権限"]'); p.value='full-access'; p.dispatchEvent(new Event('change')); ${recoveryButton('権限をこのタスクに保存')}.click()`);
    assert.equal(permissionSaves, 0);
    await win.webContents.executeJavaScript(`window.confirm=()=>true; ${recoveryButton('権限をこのタスクに保存')}.click()`);
    await authWait(`document.querySelector('.recovery-diagnostic-output').textContent.includes('権限を保存しました')`);
    assert.equal(permissionSaves, 1); assert.equal(recoveryCalls, 0);
    assert.equal(await win.webContents.executeJavaScript(`${recoveryButton('復旧を確認して再開')}.disabled`), true);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('task-detail').textContent.includes('遠隔Codex：Full access')`), true);
    recoveryReady = true;
    await win.webContents.executeJavaScript(`${recoveryButton('接続・診断')}.click()`);
    await authWait(`!${recoveryButton('復旧を確認して再開')}.disabled`);
    await authWait(`document.querySelector('.recovery-diagnostic-output').textContent.includes('サンドボックスは使用・検証していません')`);
    await win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    writeFileSync(join(__dirname, '..', 'output', 'pdf', 'remote-full-access-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`window.confirm=()=>true; ${recoveryButton('復旧を確認して再開')}.click()`);
    await authWait(`!document.querySelector('.environment-recovery-dialog')`);
    assert.equal(recoveryCalls, 1);
    let loginStarts = 0, loginCloses = 0, loginRefreshes = 0, loginInputs = '';
    ipcMain.handle('fixture:login-status', () => ({loggedIn:false, detail:'Claude Codeにログインしていません。'}));
    ipcMain.handle('fixture:login-start', () => { loginStarts++; return 'login-fixture'; });
    ipcMain.handle('fixture:login-snapshot', () => ({ data: 'Claude login fixture\r\nEnter code: ', offset: 39, alive: true }));
    ipcMain.handle('fixture:login-input', (_e, id, data) => { assert.equal(id,'login-fixture'); loginInputs += data; });
    ipcMain.handle('fixture:login-close', (_e, id) => { assert.equal(id,'login-fixture'); loginCloses++; });
    ipcMain.handle('fixture:login-refresh', () => { loginRefreshes++; return []; });
    await win.webContents.executeJavaScript(`showCliLogin("claude")`);
    await authWait(`document.querySelector('.claude-login-dialog').textContent.includes('ログインしていません')`);
    const loginButton = label => `[...document.querySelectorAll('.claude-login-dialog button')].find(b=>b.textContent===${JSON.stringify(label)})`;
    assert.equal(loginStarts, 0, 'viewing status must not start login');
    await win.webContents.executeJavaScript(`${loginButton('CLIを開く')}.click()`);
    await authWait(`document.querySelector('.login-terminal .xterm') !== null`);
    await win.webContents.executeJavaScript(`document.querySelector('.login-terminal .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'a',code:'KeyA',keyCode:65,bubbles:true}))`);
    await new Promise(r=>setTimeout(r,200)); assert.ok(loginInputs.includes('a'));
    writeFileSync(join(__dirname, '..', 'output', 'pdf', 'claude-login-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`${loginButton('状態を更新')}.click()`);
    await authWait(`!${loginButton('状態を更新')}.disabled`); assert.equal(loginRefreshes,1);
    await win.webContents.executeJavaScript(`window.confirm=()=>false; ${loginButton('閉じる')}.click()`);
    assert.equal(loginCloses, 0);
    await win.webContents.executeJavaScript(`window.confirm=()=>true; ${loginButton('閉じる')}.click()`);
    await authWait(`!document.querySelector('.claude-login-dialog')`); assert.equal(loginCloses,1);
    let codexStarts = 0, codexCloses = 0, codexInputs = '', codexRefreshes = 0;
    ipcMain.handle('fixture:codex-login-status', () => ({loggedIn:true, detail:'CLIはChatGPTにログイン済みです。', authMethod:'ChatGPT'}));
    ipcMain.handle('fixture:codex-login-start', () => { codexStarts++; return 'codex-login-fixture'; });
    ipcMain.handle('fixture:codex-login-snapshot', () => ({data:'Codex login fixture\r\n', offset:21, alive:true}));
    ipcMain.handle('fixture:codex-login-input', (_e, id, data) => { assert.equal(id,'codex-login-fixture'); codexInputs += data; });
    ipcMain.handle('fixture:codex-login-close', (_e, id) => { assert.equal(id,'codex-login-fixture'); codexCloses++; });
    ipcMain.handle('fixture:codex-login-refresh', () => { codexRefreshes++; return []; });
    await win.webContents.executeJavaScript(`
      document.getElementById('nav-usage').click();
      serviceEnvironment='local';renderResources();showCliLogin('codex');
    `);
    await authWait(`document.querySelector('.claude-login-dialog').textContent.includes('ChatGPTにログイン済み')`);
    assert.equal(codexStarts, 0, 'opening settings must not change authentication');
    await win.webContents.executeJavaScript(`${loginButton('CLIを開く')}.click()`);
    await authWait(`document.querySelector('.login-terminal .xterm') !== null`);
    await win.webContents.executeJavaScript(`document.querySelector('.login-terminal .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'c',code:'KeyC',keyCode:67,bubbles:true}))`);
    await new Promise(r=>setTimeout(r,200)); assert.ok(codexInputs.includes('c')); assert.equal(codexStarts,1);
    writeFileSync(join(__dirname, '..', 'output/pdf/codex-login-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`${loginButton('状態を更新')}.click()`);
    await authWait(`!${loginButton('状態を更新')}.disabled`); assert.equal(codexRefreshes,1);
    await win.webContents.executeJavaScript(`${loginButton('閉じる')}.click()`);
    await authWait(`!document.querySelector('.claude-login-dialog')`); assert.equal(codexCloses,1);
    assert.equal(loginStarts,1); assert.equal(loginCloses,1); // Provider sessions must not cross.
    await win.webContents.executeJavaScript(`
      const reportTask = state.tasks.find(t=>t.id==='goal-fixture');
      reportTask.state='paused'; reportTask.resumeFromUnitId='waiting-reporter';
      reportTask.error='レポート執筆ルールが未完了、未解決事項あり、または適用したルールの版が一致しません。';
      reportTask.workUnits=[{id:'waiting-reporter',role:'reporter',state:'pending',title:'Report',dependsOn:[],attemptedAgentIds:[],output:'<editorial-check>{"status":"blocked","concerns":["latexmk: command not found。PDF生成と表示確認が未実施"]}</editorial-check>'}];
      state.selectedTaskId=reportTask.id; renderDetail();
    `);
    await authWait(`document.querySelector('.task-stop-notice').textContent.includes('latexmk: command not found')`);
    assert.doesNotMatch(await win.webContents.executeJavaScript(`document.querySelector('.task-stop-notice').textContent`), /ルールの版が一致しません/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.task-stop-notice').textContent`), /次のレポーターはタスクの遠隔作業環境/);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('report-remote-execution')`), null);
    assert.ok(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-stop-notice button')].some(b=>b.textContent==='レポーターから再開')`));
    const ideaPreset = await presets.capture('idea');
    let transitionFixture = {...structuredClone(goalTask), workPreset:ideaPreset, goal:{...initialGoal('アイディアを検討する',ideaPreset),status:'approved',questions:[],constraints:['本段階では実験しない']},state:'completed',awaitingReason:undefined,remote:undefined,error:undefined};
    transitionFixture.history=[];
    const {validateFollowup,captureRound,nextRoundPatch}=require('../dist/core/iterations');
    const {implementationTransitionPatch,approvedScopeChangePatch}=require('../dist/core/scope-transition');
    ipcMain.handle('fixture:followup',async (_e,id,input,start)=>{
      assert.equal(id,transitionFixture.id);
      const checked=validateFollowup(input,transitionFixture);
      if(!start) return transitionFixture={...transitionFixture,pendingFollowup:checked};
      const patch=checked.scopeChange ? approvedScopeChangePatch(transitionFixture,checked,await presets.capture('coding')) : implementationTransitionPatch(transitionFixture,checked,await presets.capture('coding'));
      transitionFixture.history=[captureRound(transitionFixture)];
      return transitionFixture={...transitionFixture,...nextRoundPatch(transitionFixture,checked),...patch};
    });
    await win.webContents.executeJavaScript(`(() => {
      state.tasks=state.tasks.map(t=>t.id==='goal-fixture'?${JSON.stringify(transitionFixture)}:t);
      followupDrafts.delete('goal-fixture'); state.selectedTaskId='goal-fixture';
      document.getElementById('nav-tasks').click(); openTaskPanel(state.tasks.find(t=>t.id==='goal-fixture'),'followup');
      const check=document.querySelector('[aria-label="実装・実験へ進む"]'); check.click();
      const kind=document.querySelector('[aria-label="進め方"]'); kind.value='review'; kind.dispatchEvent(new Event('change'));
    })()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[aria-label="実装・実験へ進む"]').checked`),false);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[aria-label="実装・実験へ進む"]').disabled`),true);
    await win.webContents.executeJavaScript(`(() => {
      const kind=document.querySelector('[aria-label="進め方"]');kind.value='continue';kind.dispatchEvent(new Event('change'));
      document.querySelector('[aria-label="実装・実験へ進む"]').click();
      const input=document.querySelector('[aria-label="追加指示"]'); input.value='採用案Aを実装し、入力100件で基準法と実測比較する'; input.dispatchEvent(new Event('input'));
      [...document.querySelectorAll('.followup-composer button')].find(b=>b.textContent==='次回用に保存').click();
    })()`);
    await authWait(`state.tasks.find(t=>t.id==='goal-fixture').pendingFollowup?.implementation===true`);
    assert.equal(transitionFixture.workPreset.manifest.focus,'idea');
    await win.webContents.executeJavaScript(`document.querySelector('.followup-composer button[type="submit"]').click()`);
    await authWait(`state.tasks.find(t=>t.id==='goal-fixture').goalRevisionPending===true && !!document.querySelector('.goal-editor')`);
    assert.equal(transitionFixture.goal.status,'draft');
    assert.equal(transitionFixture.workPreset.manifest.focus,'implementation');
    assert.ok(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.goal-editor button')].some(b=>b.textContent==='ゴールを承認してキューへ'&&!b.disabled)`));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.followup-composer')`),null);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('.goal-editor').textContent`),/実装禁止・実験禁止/);
    await new Promise(r=>setTimeout(r,100));
    writeFileSync(join(__dirname,'..','output/pdf/idea-implementation-goal-smoke.png'),(await win.webContents.capturePage()).toPNG());
    transitionFixture={...transitionFixture,state:'awaiting-input',awaitingReason:'result',goalRevisionPending:undefined,
      goal:{...transitionFixture.goal,status:'approved',revision:5,constraints:['FP64命令は禁止','着想検討に専念する'],outOfScope:['演算カーネルの実装、性能ベンチマークや数値実験の実行。','別マシンは使わない']}};
    await win.webContents.executeJavaScript(`(() => {
      state.tasks=state.tasks.map(t=>t.id==='goal-fixture'?${JSON.stringify(transitionFixture)}:t);followupDrafts.delete('goal-fixture');openTaskPanel(state.tasks.find(t=>t.id==='goal-fixture'),'followup');
      const input=document.querySelector('[aria-label="追加指示"]');input.value='Apple M5で実装・精度検証・性能実験を行う。FP64禁止は維持する。';input.dispatchEvent(new Event('input'));
      [...document.querySelectorAll('.followup-composer button')].find(b=>b.textContent==='作業範囲・制約を変更して実行…').click();
    })()`);
    await authWait(`!!document.querySelector('.scope-change-dialog')`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.scope-change-dialog [aria-label="解除：FP64命令は禁止"]').checked`),false);
    await win.webContents.executeJavaScript(`document.querySelector('.scope-change-dialog [aria-label="解除：着想検討に専念する"]').click();document.querySelector('.scope-change-dialog [aria-label="解除：演算カーネルの実装、性能ベンチマークや数値実験の実行。"]').click();document.querySelector('.scope-change-dialog [aria-label="実装・精度検証・性能実験を含める"]').click();`);
    assert.equal(transitionFixture.goal.revision,5,'opening the confirmation does not alter the goal');
    await new Promise(r=>setTimeout(r,100));
    writeFileSync(join(__dirname,'..','output/pdf/scope-change-approval-smoke.png'),(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.scope-change-dialog button')].find(b=>b.textContent==='キャンセル').click()`);
    await authWait(`!document.querySelector('.scope-change-dialog')`);
    assert.equal(transitionFixture.goal.revision,5);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.followup-composer button')].find(b=>b.textContent==='作業範囲・制約を変更して実行…').click()`);
    await authWait(`!!document.querySelector('.scope-change-dialog')`);
    await win.webContents.executeJavaScript(`document.querySelector('.scope-change-dialog [aria-label="解除：着想検討に専念する"]').click();document.querySelector('.scope-change-dialog [aria-label="解除：演算カーネルの実装、性能ベンチマークや数値実験の実行。"]').click();document.querySelector('.scope-change-dialog [aria-label="実装・精度検証・性能実験を含める"]').click();[...document.querySelectorAll('.scope-change-dialog button')].find(b=>b.textContent==='変更を承認して実行').click();`);
    await authWait(`state.tasks.find(t=>t.id==='goal-fixture').goal?.revision===6`);
    assert.equal(transitionFixture.goal.status,'approved');assert.equal(transitionFixture.goalRevisionPending,undefined);
    assert.deepEqual(transitionFixture.goal.constraints,['FP64命令は禁止']);assert.deepEqual(transitionFixture.goal.outOfScope,['別マシンは使わない']);
    assert.ok(errors.length === 0, errors.join('\n'));
    console.log(JSON.stringify(measurements, null, 2));
    console.log('Native Electron PTY, keyboard input, ANSI screen, tab retention, tiled panes, drag resize and reload replay verified.');
    runner.cancelAll(); await Promise.all(runs);
    app.exit(0);
  } catch (error) { console.error(error); runner.cancelAll(); await Promise.all(runs); app.exit(1); }
});
// Chromium may still flush its temporary profile during quit. Retry transient
// ENOTEMPTY instead of leaving a native error dialog after successful checks.
app.on('quit', () => rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
