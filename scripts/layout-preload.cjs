const { contextBridge, ipcRenderer } = require('electron');
const roles = ['planner', 'worker', 'reviewer', 'reporter'];
const agents = ['codex', 'claude', 'antigravity'].map(id => ({ id, label: id, command: id, installed: true, version: 'fixture' }));
const snapshot = {
  agents, defaultCwd: '/tmp', queue: { running: false, stopping: false }, resources: [],
  reportSettings: { texCommand: 'latexmk', texArgs: [], plotCommand: 'python3', plotCheckArgs: [], outputDirectory: '/tmp' },
  reportEnvironment: { tex: { ok: true, command: 'fixture', detail: 'fixture' }, plot: { ok: true, command: 'fixture', detail: 'fixture' }, checkedAt: new Date().toISOString() },
  orchestrationSettings: { warningPercent: 70, drainPercent: 85, agentPolicies: agents.map(a => ({ agentId: a.id, enabled: true, providerKey: a.id, providerLabel: a.id, authMode: 'subscription', priority: 80 })) },
  tasks: [{ id: 'layout-fixture', title: 'Layout fixture', prompt: 'No real CLI execution', cwd: '/tmp', strategy: 'balanced', allowedAgentIds: ['codex', 'claude'], modelOverrides: {},
    workUnits: roles.map((role, i) => ({ id: `unit-${i}`, role, title: role, instructions: '', mode: 'read', state: 'completed', dependsOn: [], attemptedAgentIds: ['codex'], assignedAgentId: 'codex' })),
    runs: [{ id: 'run-1', workUnitId: 'unit-0', role: 'planner', agentId: 'codex', providerKey: 'codex', state: 'completed', output: 'Fixture log\n'.repeat(150), displayOutput: 'Fixture log\n'.repeat(150), startedAt: new Date().toISOString() }],
    state: 'awaiting-input', awaitingReason: 'result', output: '', report: { state: 'ready', texPath: '/tmp/fixture.tex', pdfPath: '/tmp/fixture.pdf', previewUrl: 'about:blank' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
};
snapshot.tasks[0].runs = ['codex', 'claude'].map((id, index) => ({ ...snapshot.tasks[0].runs[0], id: `run-${index + 1}`, agentId: id, terminal: true, state: 'running', output: '' }));
snapshot.resources = [
  {providerKey:'openai',providerLabel:'OpenAI',agentIds:['codex'],labels:['5 hours','Current week']},
  {providerKey:'anthropic',providerLabel:'Anthropic',agentIds:['claude'],labels:['Current session','Current week (all)','Current week (Fable)']}
].map(p => ({ ...p, authModes:['subscription'],state:'available',totalTokens:0,inputTokens:0,outputTokens:0,runs:0,failures:0,usedPercent:12,models:[],limitSource:'probe',capacityUpdatedAt:new Date().toISOString(),windows:p.labels.map((label,i)=>({id:label,label,usedPercent:12+i*5,scope:'shared',resetAt:'2026-09-19T09:00:00Z'})) }));
const api = { getSnapshot: async () => ({ ...snapshot, remoteSystems: await ipcRenderer.invoke('fixture:remote-list'), workPresets: await ipcRenderer.invoke('fixture:presets-list') }),
  checkService: (key, retryAuthorization) => ipcRenderer.invoke('fixture:service-check', key, retryAuthorization),
  setServiceAccount: (key, label) => ipcRenderer.invoke('fixture:service-account', key, label),
  cancelTask: id => ipcRenderer.invoke('fixture:cancel-task', id),
  deleteTask: id => ipcRenderer.invoke('fixture:delete-task', id),
  getBenchmarks: () => ipcRenderer.invoke('fixture:benchmarks-get'),
  inspectBenchmark: model => ipcRenderer.invoke('fixture:benchmarks-inspect',model),
  configureBenchmarks: value => ipcRenderer.invoke('fixture:benchmarks-configure',value),
  refreshBenchmarks: () => ipcRenderer.invoke('fixture:benchmarks-refresh'),
  onBenchmarksChanged: () => () => {},
  listSkills: id=>ipcRenderer.invoke('fixture:skills-list',id),
  saveSkill: (id,value)=>ipcRenderer.invoke('fixture:skills-save',id,value),
  skillHistory: (id,key)=>ipcRenderer.invoke('fixture:skills-history',id,key),
  promoteSkill: (id,key,revision)=>ipcRenderer.invoke('fixture:skills-promote',id,key,revision),
  listModels: id => ipcRenderer.invoke('fixture:models-list', id),
  saveModelDefaults: (value, enabled) => ipcRenderer.invoke('fixture:models-save', value, enabled),
  updateOrchestrationSettings: value => ipcRenderer.invoke('fixture:routing-save', value),
  chooseWorkspace: async () => '/tmp',
  chooseLessonPdfs: async () => [{id:'lesson-file',name:'sample-paper.pdf'}],
  validateWorkspace: async (path, mode) => { if (!path.startsWith('/') || !['existing','new'].includes(mode)) throw Error('作業場所を選択してください'); return path; },
  refreshAgents: async () => { await ipcRenderer.invoke('fixture:agents-detected'); return agents; },
  refreshCapacity: () => ipcRenderer.invoke('fixture:capacity-refresh'),
  ollamaUsageOpen: () => ipcRenderer.invoke('fixture:ollama-usage-open'),
  ollamaUsageRefresh: () => ipcRenderer.invoke('fixture:ollama-usage-refresh'),
  ollamaUsageDisconnect: () => ipcRenderer.invoke('fixture:ollama-usage-disconnect'),
  getTaskInstructions: id => ipcRenderer.invoke('fixture:instructions', id),
  hpcAction: (id, request) => ipcRenderer.invoke('fixture:hpc', id, request),
  researchSnapshot: id => ipcRenderer.invoke('fixture:research', id),
  researchRecover: async () => undefined,
  qualitySnapshot: id => ipcRenderer.invoke('fixture:quality', id),
  qualityRecover: async () => undefined,
  exportTaskInstructions: id => ipcRenderer.invoke('fixture:instructions-export', id),
  claudeLoginStatus: () => ipcRenderer.invoke('fixture:login-status'),
  claudeLoginStart: () => ipcRenderer.invoke('fixture:login-start'),
  claudeLoginSnapshot: id => ipcRenderer.invoke('fixture:login-snapshot', id),
  claudeLoginInput: (id, data) => ipcRenderer.invoke('fixture:login-input', id, data),
  claudeLoginResize: async () => {},
  claudeLoginClose: id => ipcRenderer.invoke('fixture:login-close', id),
  claudeLoginRefresh: () => ipcRenderer.invoke('fixture:login-refresh'),
  codexLoginStatus: () => ipcRenderer.invoke('fixture:codex-login-status'),
  codexLoginStart: () => ipcRenderer.invoke('fixture:codex-login-start'),
  codexLoginSnapshot: id => ipcRenderer.invoke('fixture:codex-login-snapshot', id),
  codexLoginInput: (id, data) => ipcRenderer.invoke('fixture:codex-login-input', id, data),
  codexLoginResize: async () => {},
  codexLoginClose: id => ipcRenderer.invoke('fixture:codex-login-close', id),
  codexLoginRefresh: () => ipcRenderer.invoke('fixture:codex-login-refresh'),
  antigravityLoginStatus: () => ipcRenderer.invoke('fixture:agy-login-status'),
  antigravityUsageInstall: environmentId => ipcRenderer.invoke('fixture:agy-usage-install', environmentId),
  confirmServiceAccountChange: key => ipcRenderer.invoke('fixture:service-account-changed', key),
  antigravityUsageRefresh: () => ipcRenderer.invoke('fixture:agy-usage-refresh'),
  antigravityLoginStart: () => ipcRenderer.invoke('fixture:agy-login-start'),
  antigravityLoginSnapshot: id => ipcRenderer.invoke('fixture:agy-login-snapshot', id),
  antigravityLoginInput: (id, data) => ipcRenderer.invoke('fixture:agy-login-input', id, data),
  antigravityLoginResize: (id, cols, rows) => ipcRenderer.invoke('fixture:agy-login-resize', id, cols, rows),
  antigravityLoginClose: id => ipcRenderer.invoke('fixture:agy-login-close', id),
  opencodeLoginStatus: plan => ipcRenderer.invoke('fixture:opencode-login-status', plan),
  opencodeLoginStart: plan => ipcRenderer.invoke('fixture:opencode-login-start', plan),
  opencodeLoginSnapshot: id => ipcRenderer.invoke('fixture:opencode-login-snapshot', id),
  opencodeLoginInput: (id, data) => ipcRenderer.invoke('fixture:opencode-login-input', id, data),
  opencodeLoginResize: async () => {},
  opencodeLoginClose: async () => {},
  openCodeModels: plan => ipcRenderer.invoke('fixture:opencode-models', plan),
  configureOpenCode: (plan, model) => ipcRenderer.invoke('fixture:opencode-configure', plan, model),
  remoteSave: (value,confirmed,addressUpdate) => ipcRenderer.invoke('fixture:remote-save', value, confirmed, addressUpdate),
  remoteStatus: id => ipcRenderer.invoke('fixture:remote-status', id),
  bindTaskRemote: (task, system) => ipcRenderer.invoke('fixture:remote-bind', task, system),
  setTaskLoginRoute: (task, system,confirmation) => ipcRenderer.invoke('fixture:login-route', task, system,confirmation),
  remoteSnapshot: async () => undefined,
  serviceTerminalStart: (key, mode) => ipcRenderer.invoke('fixture:service-terminal-start', key, mode),
  serviceTerminalSnapshot: id => ipcRenderer.invoke('fixture:service-terminal-snapshot', id),
  serviceTerminalInput: (id, data) => ipcRenderer.invoke('fixture:service-terminal-input', id, data),
  serviceTerminalResize: async () => {},
  serviceTerminalStop: id => ipcRenderer.invoke('fixture:service-terminal-stop', id),
  remoteCheck: id => ipcRenderer.invoke('fixture:remote-check', id),
  remoteDiagnose: async () => ({ platform:'linux',kernel:'fixture',cwd:'/home/scientist/final-project',checks:[{name:'通常コマンド',ok:true,detail:'成功'},{name:'Codex 読み取り専用サンドボックス',ok:false,detail:'bwrap: setting up uid map: Permission denied'}] }),
  inspectTaskRecovery: id => ipcRenderer.invoke('fixture:recovery-inspect', id),
  recoverTask: id => ipcRenderer.invoke('fixture:recovery-resume', id),
  setTaskCodexPermissions: (id, value, confirmed) => ipcRenderer.invoke('fixture:codex-permissions', id, value, confirmed),
  remoteConnect: async () => true,
  remoteTaskConnect: id => ipcRenderer.invoke('fixture:remote-task-connect', id),
  remoteTaskReady: id => ipcRenderer.invoke('fixture:remote-task-ready', id),
  remoteTaskCancel: id => ipcRenderer.invoke('fixture:remote-task-cancel', id),
  remoteInput: async () => {}, remoteResize: async () => {}, remoteDisconnect: async () => true,
  listWorkPresets: () => ipcRenderer.invoke('fixture:presets-list'),
  getFinishingSkill: (section) => ipcRenderer.invoke('fixture:finishing-get', section),
  saveFinishingSkill: (revision, rules, section) => ipcRenderer.invoke('fixture:finishing-save', revision, rules, section),
  saveWorkPresetRules: (id, revision, rules, goal) => ipcRenderer.invoke('fixture:presets-save', id, revision, rules, goal),
  getWorkPresetCommon: () => ipcRenderer.invoke('fixture:presets-common-get'),
  saveWorkPresetCommon: (revision, rules) => ipcRenderer.invoke('fixture:presets-common-save', revision, rules),
  createTask: input => ipcRenderer.invoke('fixture:create-goal', input),
  submitFollowup: (id, input, start) => ipcRenderer.invoke('fixture:followup', id, input, start),
  resumeTask: id => ipcRenderer.invoke('fixture:resume', id),
  restartTask: (id, mode) => ipcRenderer.invoke('fixture:restart', id, mode),
  configureExecution: (id, value, revision) => ipcRenderer.invoke('fixture:execution', id, value, revision),
  configureInitialCli: (id, value, updatedAt) => ipcRenderer.invoke('fixture:initial-cli', id, value, updatedAt),
  updateExecutionDefaults: value => ipcRenderer.invoke('fixture:execution-defaults', value),
  onExecutionDefaultsChanged: () => () => {},
  configureAllowedAgents: (id, value) => ipcRenderer.invoke('fixture:allowed-agents', id, value),
  saveGoal: (id, value, revision, approve, autonomy) => ipcRenderer.invoke('fixture:save-goal', id, value, revision, approve, autonomy),
  refineGoal: (id, notes, revision) => ipcRenderer.invoke('fixture:refine-goal', id, notes, revision),
  readReportPdf: (taskId, round, document) => ipcRenderer.invoke('fixture:pdf', taskId, round, document),
  terminalSnapshot: (_taskId, runId) => ipcRenderer.invoke('fixture:snapshot', runId),
  terminalRecovery: (_taskId, _runId, action, value) => ipcRenderer.invoke('fixture:cli-recovery', action, value),
  terminalInput: (_taskId, runId, data) => ipcRenderer.invoke('fixture:input', runId, data),
  terminalResize: (_taskId, runId, cols, rows) => ipcRenderer.invoke('fixture:resize', runId, cols, rows),
  terminalComplete: (_taskId, runId, value) => ipcRenderer.invoke('fixture:complete', runId, value),
  terminalClose: (_taskId, runId) => ipcRenderer.invoke('fixture:close', runId)
};
for (const name of ['onRunEvent', 'onTasksChanged', 'onAgentsChanged', 'onQueueChanged', 'onReportEnvironmentChanged', 'onReportSettingsChanged', 'onResourcesChanged', 'onOrchestrationSettingsChanged']) api[name] = () => () => {};
api.onTasksChanged = callback => {
  const listener = (_event, tasks) => callback(tasks);
  ipcRenderer.on('fixture:tasks-changed', listener);
  return () => ipcRenderer.removeListener('fixture:tasks-changed', listener);
};
api.onQueueChanged = callback => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on('fixture:queue-changed', listener);
  return () => ipcRenderer.removeListener('fixture:queue-changed', listener);
};
api.onRunEvent = listener => { const wrapped = (_event, value) => listener(value); ipcRenderer.on('run:event', wrapped); return () => ipcRenderer.removeListener('run:event', wrapped); };
for (const [method, channel] of [['onRemoteAuthRequired', 'remote:auth-required'], ['onRemoteOutput', 'remote:output']]) {
  api[method] = listener => { const wrapped = (_event, value) => listener(value); ipcRenderer.on(channel, wrapped); return () => ipcRenderer.removeListener(channel, wrapped); };
}
contextBridge.exposeInMainWorld('harness', api);
