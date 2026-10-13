// renderer共通のデータ契約。画面固有の型は各画面にも置く。実行コードやNode/Electronのimportを置かない。
// 各画面は従来のdeferスクリプトとして同じグローバル型を参照する。
type AgentId = "codex" | "claude" | "gemini" | "opencode" | "antigravity";
type OpenCodePlan = "zai" | "ollama" | "ollama-app";
interface WorkRequirements { independenceGroup?:string; modelFamilies?: Array<"openai"|"anthropic"|"gemini"|"deepseek"|"glm">; independentFrom?:string[]; skills?:Array<{id:string;revision?:string}>; }
interface AssignmentRecoveryOption { id:string;title:string;requirements?:WorkRequirements;peers:Array<{key:string;title:string;model?:string;writingRevision?:string}>; }
interface CliModelCatalog { models: Array<{ id: string; label: string }>; source: "cli" | "aliases"; note: string; }
interface ModelBenchmark { id:string; name:string; intelligence?:number; coding?:number; agentic?:number; tokensPerSecond?:number; reference?:{kind:"variants"|"alias";model:string;evaluationIds:string[];ranges:Partial<Record<"intelligence"|"coding"|"agentic"|"tokensPerSecond",[number,number]>>;note:string}; }
interface BenchmarkSnapshot { enabled:boolean; hasKey:boolean; fetchedAt?:string; indexVersion?:number; error?:string; retryAt?:string; retryBlocked?:boolean; models:ModelBenchmark[]; }
interface BenchmarkMatch { status:"missing"|"stale"|"default"|"unmatched"|"matched"; enabled:boolean; record?:ModelBenchmark; }
type TaskStrategy = "balanced" | "quality" | "quota-saver";
type TaskState = "queued" | "planning" | "running" | "reviewing" | "reporting" | "paused" | "awaiting-input" | "blocked" | "completed" | "failed" | "cancelled";
type RoundKind = "initial" | "consult" | "continue" | "review" | "report";
interface RoleAssignment { agentId?: AgentId; model?: string; allowFallback: boolean; }
interface FollowupInput {
  scopeChange?: { goalRevision: number; removeConstraints: string[]; removeOutOfScope: string[]; criterionEdits?: { id: string; description: string; verification: string }[]; implementation: boolean; confirmed: true };
  implementation?: boolean;
  instruction: string;
  kind: Exclude<RoundKind, "initial">;
  assignments: Partial<Record<WorkUnit["role"], RoleAssignment>>;
  pauseAfterPlan: boolean;
}
interface TaskRound {
  workClosure?: TaskRecord["workClosure"];
  workPreset?: WorkPresetSnapshot;
  goal?: GoalContract;
  number: number; kind: RoundKind; instruction: string; state: TaskState;
  workUnits: WorkUnit[]; report?: ReportRecord; finishedAt: string;
}
type WorkUnitState = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";
type AuthMode = "subscription" | "api-key" | "cloud" | "unknown";

interface AgentStatus {
  id: AgentId;
  label: string;
  command: string;
  installed: boolean;
  executable?: string;
  version?: string;
  error?: string;
}

interface UsageRecord {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  source: "reported" | "estimated" | "unknown";
}

interface ReportRecord {
  documents?: Partial<Record<"paper" | "poster", ReportRecord>>;
  state: "draft" | "building" | "ready" | "failed";
  texPath?: string;
  pdfPath?: string;
  previewUrl?: string;
  error?: string;
  builtAt?: string;
}

interface WorkUnit {
  retryAgentId?: AgentId;
  orchestrator?: { round: number; goalRevision: number; planRevision: number; triggerUnitIds: string[] };
  coordinationNotes?: Array<{ decisionId: string; note: string }>;
  allocatedBy?: string;
  primaryStep?: boolean;
  crossReview?: { wave: 1 | 2; providerKey: string; sourceUnitIds: string[]; aggregate?: boolean };
  ideaPhase?: boolean;
  reviewPass?: 1 | 2;
  planPhase?: boolean;
  planRevision?: number;
  subtask?: { inputScope?: "assignment"; allowTaskOnlyPeers?: boolean; comparison?: { input:string; evaluation:string; approach:string }; kind?: "investigation"|"primary-work"|"isolated-work"; ownedFiles?: string[]; purpose?: "speed"|"balance"|"verify"|"explore"; requirements?: WorkRequirements; capability?: "reasoning"|"coding"|"agentic"|"speed"; key: string; deliverable: string; acceptance: string; criterionIds: string[]; estimatedTokens: number };
  primary?: boolean;
  checkpointFor?: string;
  checkpointHandled?: boolean;
  workAttempt?: number;
  workCheckRetries?: number;
  workCheckFeedback?: string;
  researchStage?: string;
  id: string;
  role: "planner" | "worker" | "reviewer" | "reporter";
  title: string;
  instructions: string;
  mode: "read" | "write" | "local";
  state: WorkUnitState;
  dependsOn: string[];
  assignedAgentId?: AgentId;
  assignmentReason?: string;
  attemptedAgentIds: AgentId[];
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface ManagedSkill {
  id:string; description:string; content:string; revision:string; status:"experimental"|"validated"|"retired";
  evidence:string; updatedAt:string; path:string; builtin:boolean;
}
interface SkillCatalog { skills:ManagedSkill[]; errors:string[]; root:string; history:Array<{id:string;revision:string;calls:number;bytes:number;task:string;at:string;run:string}>; }
interface AgentRun {
  remoteSession?: {token:string;controlDirectory:string;detached?:boolean};
  executionTiming?: {workStartedAt?:string;source:"channel"|"log"};
  terminationUnconfirmed?:boolean;
  recoveredAt?:string;
  executionLocation?: "local" | "remote";
  finishingSkill?: { rules: string; revision: string; capturedAt: string };
  finishingCheck?: { summary: string; sources: string[] };
  contextReason?: string;
  continuedFrom?: string;
  estimatedTokens?: number;
  skillUsage?: { source: "mcp"; reads: { id: string; revision: string; bytes: number; calls: number }[]; estimatedTokens: number; truncated: boolean };
  goalPreparation?: boolean;
  terminal?: boolean;
  id: string;
  workUnitId: string;
  role: WorkUnit["role"];
  agentId: AgentId;
  providerKey: string;
  model?: string;
  state: "running" | "completed" | "failed" | "rate-limited" | "cancelled";
  output: string;
  displayOutput?: string;
  logPath?: string;
  error?: string;
  usage?: UsageRecord;
  subagentCount?: number;
  startedAt: string;
  completedAt?: string;
}

interface TaskRecord {
  agentMessages?: Array<{id:string;threadId:string;round:number;at:string;fromUnitId:string;fromAgentId:AgentId;toUnitId:string;kind:"request"|"answer"|"finding"|"warning";text:string;state:"queued"|"delivered"|"read"|"expired"}>;
  executionBlocker?: {kind:"permission"|"tool"|"hardware"|"connection";summary:string;recovery:string;check?:string;unitId:string;runId?:string;round:number;cycle:number;goalRevision?:number;at:string};
  localCodexPermissions?: "sandbox" | "full-access";
  executionMetrics?: { elapsedMs:number; measuredAt:number; ticking:boolean; measuredRuns:number; totalRuns:number; usage:UsageRecord; startupMs:number;unknownMs:number;currentParallel:number;waitingRuns:number;peakParallel:number;parallelMs:number;intervals:Array<{runId:string;unitId:string;agentId:AgentId;start:number;end:number;workStart:number;uncertain:boolean;live:boolean;waiting:boolean}>; models:Array<{agentId:AgentId;model?:string;measuredRuns:number;totalRuns:number;usage:UsageRecord}> };
  workflowMetrics?: TaskRecord["executionMetrics"];
  continuationUnitId?: string;
  timeOutlook?: {targetMinutes?:number;elapsedMinutes:number;remainingMinutes:number;projectedMinutes:number;unknownUnits:number};
  workClosure?: { round: number; cycle: number; goalRevision: number; startedAt: string; finishedAt?: string; reason: string; issues: string[] };
  lessonSources?: Array<{ name: string; relativePath: string; sha256: string; bytes: number }>;
  reportRecovery?: { reporterId: string; resumeStage?: "paper"; kind: "prerequisite" | "document" | "environment" | "user-input"; summary: string; concerns: string[]; pdfAvailable: boolean; canReplan: boolean; unavailableReason?: string };
  crossReviewReplans?: Array<{at:string;round:number;removedProvider:string;workUnits:WorkUnit[]}>;
  researchCycle?: 1;
  qualityCycle?: 1;
  orchestratorDecisions?: Array<{ id: string; round: number; status: "deciding" | "added" | "adjusted" | "waiting" | "skipped"; reason: string; addedUnitIds: string[]; refinements?:Array<{unitId:string;note:string}>; createdAt: string }>;
  goalRevisionPending?: boolean;
  scopeTransition?: { fromPreset?: WorkPresetSnapshot; requestedAt: string; round: number; instruction: string; removedConstraints?: string[]; removedOutOfScope?: string[] };
  remote?: RemoteSystem;
  reviewPolicy?: "adversarial-pair";
  reviewAdjustments?: Array<{ round: number; cycle: number; goalRevision: number; mode: "pair" | "single"; unitIds: string[]; omittedUnits: WorkUnit[]; decidedAt: string; targetMinutes: number; elapsedMinutes: number; estimatedMinutes: number; reason: string }>;
  restart?: { sourceTaskId: string; mode: "carry" | "fresh"; handoff?: string };
  workPreset?: WorkPresetSnapshot;
  autonomyHistory?: Array<{ cycle: number; round: number; workUnits: WorkUnit[] }>;
  executionPlans?: ExecutionPlan[];
  retiredWorkUnits?: WorkUnit[];
  execution?: ExecutionPolicy;
  pendingExecution?: { policy: ExecutionPolicy; savedAt: string };
  executionRevision?: number;
  executionAppliedAt?: string;
  budgetStatus?: { used: number; reserve: number; limit?: number; estimated: boolean };
  workflowMode?: "primary" | "staged";
  resumeFromUnitId?: string;
  resumeCount?: number;
  resumeInstructions?: Array<{ round: number; unitId: string; at: string; instruction: string }>;
  lastResumedAt?: string;
  interruptedHistory?: TaskRound[];
  autonomy?: { enabled: boolean; maxCycles: number; targetMinutes?: number };
  autonomyCycle?: number;
  autonomyState?: "working" | "satisfied" | "needs-input" | "cycle-limit" | "stalled" | "invalid-review";
  evaluations?: Array<{ reviewNumber?: number; reviewPass?: 1 | 2; reviewUnitId?: string; reviewerAgentId?: AgentId; concerns?: string[]; goalRevision: number; round: number; cycle: number; reviewedAt: string; summary: string; criteria: Array<{ criterionId: string; status: "pass" | "fail" | "unverified"; detail: string; evidence: Array<{ path: string; detail: string; hash?: string }> }> }>;
  goal?: GoalContract;
  goalHistory?: GoalContract[];
  goalPreparation?: boolean;
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  agentId?: AgentId;
  strategy: TaskStrategy;
  allowedAgentIds: AgentId[];
  modelOverrides: Partial<Record<AgentId, string>>;
  workUnits: WorkUnit[];
  runs: AgentRun[];
  state: TaskState;
  output: string;
  error?: string;
  usage?: UsageRecord;
  report?: ReportRecord;
  createdAt: string;
  updatedAt: string;
  legacySingleAgent?: boolean;
  roundNumber?: number;
  roundKind?: RoundKind;
  instruction?: string;
  history?: TaskRound[];
  pendingFollowup?: FollowupInput;
  assignments?: Partial<Record<WorkUnit["role"], RoleAssignment>>;
  initialAssignment?: RoleAssignment & { round: number };
  pauseAfterPlan?: boolean;
  planApproved?: boolean;
  awaitingReason?: "plan" | "result" | "goal";
}

interface QueueStatus {
  activeTaskIds?: string[];
  running: boolean;
  stopping: boolean;
  activeTaskId?: string;
}

interface ReportSettings {
  remoteExecution?: "local" | "remote";
  texCommand: string;
  texArgs: string[];
  plotCommand: string;
  plotCheckArgs: string[];
  outputDirectory: string;
}

interface ReportEnvironmentStatus {
  tex: { ok: boolean; command: string; detail: string };
  plot: { ok: boolean; command: string; detail: string };
  checkedAt: string;
}

interface AgentPolicy {
  codingPlan?: OpenCodePlan;
  openCodeModels?: Partial<Record<OpenCodePlan, string>>;
  agentId: AgentId;
  enabled: boolean;
  providerKey: string;
  providerLabel: string;
  authMode: AuthMode;
  defaultModel?: string;
  priority: number;
  usageLimitPercent?: number;
  softTokenBudget?: number;
}

interface OrchestrationSettings {
  agentPolicies: AgentPolicy[];
  warningPercent: number;
  drainPercent: number;
}

interface ProviderResourceSummary {
  serviceTerminalId?: string;
  quotaSupported?: boolean;
  serviceKey?: string;
  serviceLabel?: string;
  environmentId?: string;
  environmentLabel?: string;
  connected?: boolean;
  cliInstalled?: boolean;
  enabled?: boolean;
  accountLabel?: string;
  login?: { loggedIn?: boolean; checkedAt: string; detail: string; blocked?: boolean; checkSupported?: boolean; runtimeReady?: boolean };
  capacityRetryAt?: string;
  providerKey: string;
  providerLabel: string;
  agentIds: AgentId[];
  authModes: AuthMode[];
  state: "available" | "warning" | "draining" | "cooldown" | "unavailable";
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
  failures: number;
  usedPercent?: number;
  softTokenBudget?: number;
  resetAt?: string;
  windows: Array<{
    resetText?: string;
    detail?: string;
    observedAt?: string;
    id: string;
    label: string;
    usedPercent: number;
    windowMinutes?: number;
    resetAt?: string;
    scope?: "shared" | "model" | "unknown";
    model?: string;
  }>;
  models: Array<{
    id: string;
    label: string;
    isDefault?: boolean;
    source: "catalog" | "observed";
  }>;
  configuredModel?: string;
  plan?: string;
  creditBalance?: string;
  ordinaryUsageAllowed?: boolean;
  capacityUpdatedAt?: string;
  capacityError?: string;
  cooldownUntil?: string;
  limitSource: string;
}

interface RunEvent {
  terminalOffset?: number;
  taskId: string;
  runId?: string;
  workUnitId?: string;
  agentId?: AgentId;
  type: "stdout" | "stderr" | "status";
  text: string;
  displayText?: string;
  at: string;
}

interface Snapshot {
  executionDefaults?: ExecutionPolicy;
  remoteSystems?: RemoteSystem[];
  workPresets?: WorkPresetCatalog;
  agents: AgentStatus[];
  tasks: TaskRecord[];
  defaultCwd: string;
  queue: QueueStatus;
  reportSettings: ReportSettings;
  reportEnvironment: ReportEnvironmentStatus;
  orchestrationSettings: OrchestrationSettings;
  resources: ProviderResourceSummary[];
}

interface HarnessApi {
  chooseLessonPdfs(): Promise<Array<{id: string; name: string}>>;
  checkService(providerKey: string, retryAuthorization?: boolean): Promise<ProviderResourceSummary[]>;
  serviceTerminalStart(key: string, mode: "cli" | "login"): Promise<string>;
  serviceTerminalSnapshot(id: string): Promise<TerminalSnapshot | undefined>;
  serviceTerminalInput(id: string, data: string): Promise<void>;
  serviceTerminalResize(id: string, cols: number, rows: number): Promise<void>;
  serviceTerminalStop(id: string): Promise<boolean>;
  setServiceAccount(providerKey: string, label: string): Promise<ProviderResourceSummary[]>;
  listSkills(taskId?:string):Promise<SkillCatalog>;
  saveSkill(taskId:string|undefined,input:{id:string;revision:string;content:string;status:ManagedSkill["status"];evidence:string}):Promise<ManagedSkill>;
  skillHistory(taskId:string|undefined,id:string):Promise<ManagedSkill[]>;
  promoteSkill(taskId:string,id:string,revision:string):Promise<ManagedSkill|undefined>;
  hpcAction(taskId: string, request: unknown): Promise<any>;
  researchSnapshot(taskId: string): Promise<any>;
  qualitySnapshot(taskId: string): Promise<QualityViewSnapshot>;
  qualityRecover(taskId: string, domain: "work"|"report"): Promise<unknown>;
  researchRecover(taskId: string): Promise<any>;
  listModels(id: AgentId): Promise<CliModelCatalog>;
  getBenchmarks():Promise<BenchmarkSnapshot>;
  inspectBenchmark(model:string):Promise<BenchmarkMatch>;
  configureBenchmarks(value:{enabled:boolean;apiKey?:string;clearKey?:boolean}):Promise<BenchmarkSnapshot>;
  refreshBenchmarks():Promise<BenchmarkSnapshot>;
  onBenchmarksChanged(listener:(value:BenchmarkSnapshot)=>void):()=>void;
  saveModelDefaults(value: Record<string, string>, enabled?: Record<string, boolean>): Promise<{ settings: OrchestrationSettings; resources: ProviderResourceSummary[] }>;
  ollamaUsageOpen(): Promise<void>;
  ollamaUsageRefresh(): Promise<ProviderResourceSummary[]>;
  ollamaUsageDisconnect(): Promise<ProviderResourceSummary[]>;
  updateExecutionDefaults(value: ExecutionPolicy): Promise<ExecutionPolicy>;
  onExecutionDefaultsChanged(listener: (value: ExecutionPolicy) => void): () => void;
  getTaskInstructions(taskId: string): Promise<{ id: string; text: string; filename: string; createdAt: string }>;
  exportTaskInstructions(snapshotId: string): Promise<{ canceled: boolean; path?: string }>;
  codexLoginStatus: HarnessApi["claudeLoginStatus"];
  codexLoginStart: HarnessApi["claudeLoginStart"];
  codexLoginSnapshot: HarnessApi["claudeLoginSnapshot"];
  codexLoginInput: HarnessApi["claudeLoginInput"];
  codexLoginResize: HarnessApi["claudeLoginResize"];
  codexLoginClose: HarnessApi["claudeLoginClose"];
  codexLoginRefresh: HarnessApi["claudeLoginRefresh"];
  antigravityUsageInstall(environmentId?: string): Promise<string>;
  confirmServiceAccountChange(key: string): Promise<ProviderResourceSummary[]>;
  antigravityUsageRefresh(): Promise<ProviderResourceSummary[]>;
  antigravityLoginStatus(): Promise<{ installed: boolean; state: string; detail: string; authMethod?: string; subscriptionType?: string; sessionId?: string; launchBlocked?: boolean;
    usageLink?: { state: "enabled" | "not-configured" | "conflict" | "unavailable"; detail: string } }>;
  antigravityLoginStart: HarnessApi["claudeLoginStart"];
  antigravityLoginSnapshot: HarnessApi["claudeLoginSnapshot"];
  antigravityLoginInput: HarnessApi["claudeLoginInput"];
  antigravityLoginResize: HarnessApi["claudeLoginResize"];
  antigravityLoginClose: HarnessApi["claudeLoginClose"];
  opencodeLoginStatus(plan?: OpenCodePlan): ReturnType<HarnessApi["claudeLoginStatus"]>;
  opencodeLoginStart(plan?: OpenCodePlan): Promise<string>;
  opencodeLoginSnapshot: HarnessApi["claudeLoginSnapshot"];
  opencodeLoginInput: HarnessApi["claudeLoginInput"];
  opencodeLoginResize: HarnessApi["claudeLoginResize"];
  opencodeLoginClose: HarnessApi["claudeLoginClose"];
  openCodeModels(plan: OpenCodePlan): Promise<string[]>;
  configureOpenCode(plan: OpenCodePlan, model: string): ReturnType<HarnessApi["updateOrchestrationSettings"]>;
  claudeLoginStatus(): Promise<{ loggedIn?: boolean; detail: string; authMethod?: string; subscriptionType?: string; checkSupported?: boolean; runtimeReady?: boolean }>;
  claudeLoginStart(): Promise<string>;
  claudeLoginSnapshot(id: string): Promise<{ data: string; offset: number; alive: boolean; exitCode?: number; issue?: { code: string; message: string } }>;
  claudeLoginInput(id: string, data: string): Promise<void>;
  claudeLoginResize(id: string, cols: number, rows: number): Promise<void>;
  claudeLoginClose(id: string): Promise<void>;
  claudeLoginRefresh(): Promise<ProviderResourceSummary[]>;
  remoteList(): Promise<RemoteSystem[]>;
  remoteSave(value: RemoteSystem, confirmed?: boolean, addressUpdate?: { expectedHost: string; confirmed: true }): Promise<RemoteSystem[]>;
  setTaskCodexPermissions(id: string, value: "sandbox" | "full-access", confirmed?: boolean): Promise<TaskRecord>;
  remoteStatus(id: string): Promise<PreparedConnectionStatus>;
  bindTaskRemote(taskId: string, systemId: string): Promise<TaskRecord>;
  setTaskLoginRoute(taskId:string,systemId:string,confirmation:{updatedAt:string;confirmed:true}):Promise<TaskRecord>;
  remoteConnect(id: string): Promise<boolean>;
  remoteCheck(id: string): Promise<{ agents: AgentStatus[]; cwd: string; target?: PreparedTarget }>;
  remoteDiagnose(id: string, agentId?: AgentId): Promise<{ codexPermissions?: string; platform: string; kernel: string; cwd: string; checks: Array<{ name: string; ok: boolean; detail: string }> }>;
  inspectTaskRecovery(id: string): Promise<{ diagnostic: { codexPermissions?: string; platform: string; kernel: string; cwd: string; checks: Array<{ name: string; ok: boolean; detail: string }> }; ready: boolean; unitId: string; unitTitle: string }>;
  recoverTask(id: string): Promise<TaskRecord>;
  remoteSnapshot(id: string): Promise<TerminalSnapshot | undefined>;
  remoteInput(id: string, data: string): Promise<void>;
  remoteResize(id: string, cols: number, rows: number): Promise<void>;
  remoteDisconnect(id: string): Promise<boolean>;
  remoteTaskConnect(id: string): Promise<boolean>;
  remoteTaskReady(id: string): Promise<{ agents: AgentStatus[]; cwd: string; target?: PreparedTarget }>;
  remoteTaskCancel(id: string): Promise<boolean>;
  onRemoteAuthRequired(listener: (event: { taskId: string; title: string; system: RemoteSystem; recovery?: "inspect" | "resume" }) => void): () => void;
  onRemoteOutput(listener: (event: { id: string; stream: string; text: string }) => void): () => void;
  getFinishingSkill(section?: string): Promise<FinishingSkillSettings>;
  saveFinishingSkill(revision: string, rules: string, section?: string): Promise<FinishingSkillSettings["current"]>;
  listWorkPresets(): Promise<WorkPresetCatalog>;
  saveWorkPresetRules(id: string, revision: string, rules: string, goal?: WorkPresetSnapshot["manifest"]["goal"]): Promise<WorkPresetSnapshot>;
  getWorkPresetCommon(): Promise<PresetCommonSettings>;
  saveWorkPresetCommon(revision: string, rules: string): Promise<PresetCommonSettings>;
  saveGoal(id: string, value: GoalDraftInput, revision: number, approve: boolean, autonomy?: { enabled: boolean; maxCycles: number }): Promise<TaskRecord>;
  refineGoal(id: string, notes: string, revision: number): Promise<TaskRecord>;
  terminalSnapshot(taskId: string, runId: string): Promise<TerminalSnapshot>;
  terminalInput(taskId: string, runId: string, data: string): Promise<void>;
  terminalRecovery(taskId:string,runId:string,action:string,value?:unknown):Promise<any>;
  terminalHandoffOptions(taskId:string,runId:string):Promise<Array<{agentId:AgentId;enabled:boolean;reason:string}>>;
  terminalHandoff(taskId:string,runId:string,agentId:AgentId):Promise<TaskRecord>;
  terminalReviewReduction(taskId:string,runId:string,start:boolean):Promise<{enabled:boolean;reason:string;providers:string[]}>;
  terminalResize(taskId: string, runId: string, cols: number, rows: number): Promise<void>;
  terminalComplete(taskId: string, runId: string, value: { status: string; summary: string }): Promise<void>;
  terminalClose(taskId: string, runId: string): Promise<void>;
  getSnapshot(): Promise<Snapshot>;
  refreshAgents(): Promise<AgentStatus[]>;
  refreshCapacity(): Promise<ProviderResourceSummary[]>;
  createTask(input: {
    targetMinutes?: number;
    lesson?: { attachmentIds: string[]; references: string[]; audience: string; interests: string; language: "ja" | "en" };
    workspaceMode: "existing" | "new" | "remote";
    remoteSystemId?: string;
    presetId?: string;
    presetRevision?: string;
    execution?: ExecutionPolicy;
    workflowMode?: "primary" | "staged";
    goalMode?: "manual" | "ai";
    title: string;
    prompt: string;
    cwd: string;
    strategy: TaskStrategy;
    allowedAgentIds: AgentId[];
    modelOverrides: Partial<Record<AgentId, string>>;
  }): Promise<TaskRecord>;
  runTask(taskId: string): Promise<TaskRecord>;
  chooseWorkspace(mode: string): Promise<string | undefined>;
  validateWorkspace(path: string, mode: string): Promise<string>;
  assignmentOptions(taskId:string):Promise<AssignmentRecoveryOption[]>;
  repairAssignment(taskId:string,unitId:string,requirements:WorkRequirements,updatedAt:string):Promise<TaskRecord>;
  resumeTask(taskId: string): Promise<TaskRecord>;
  restartTask(taskId: string, mode: "carry" | "fresh"): Promise<TaskRecord>;
  configureAllowedAgents(taskId: string, ids: string[]): Promise<TaskRecord>;
  submitFollowup(taskId: string, input: FollowupInput, start: boolean): Promise<TaskRecord>;
  completeTask(taskId: string): Promise<TaskRecord>;
  configureTask(taskId: string, input: FollowupInput): Promise<TaskRecord>;
  configureInitialCli(taskId: string, input: RoleAssignment, updatedAt: string): Promise<TaskRecord>;
  configureExecution(taskId: string, value: ExecutionPolicy, revision?: number): Promise<TaskRecord>;
  discardFollowup(taskId: string): Promise<TaskRecord>;
  cancelTask(taskId: string): Promise<boolean>;
  deleteTask(taskId: string): Promise<TaskRecord[]>;
  startQueue(): Promise<QueueStatus>;
  stopQueue(): Promise<QueueStatus>;
  generateReport(taskId: string): Promise<TaskRecord>;
  readReportPdf(taskId: string, round?: number, document?: string): Promise<Uint8Array>;
  updateReportSettings(settings: ReportSettings): Promise<{ settings: ReportSettings; environment: ReportEnvironmentStatus }>;
  refreshReportEnvironment(): Promise<ReportEnvironmentStatus>;
  updateOrchestrationSettings(settings: OrchestrationSettings): Promise<{ settings: OrchestrationSettings; resources: ProviderResourceSummary[] }>;
  onRunEvent(listener: (event: RunEvent) => void): () => void;
  onTasksChanged(listener: (tasks: TaskRecord[]) => void): () => void;
  onAgentsChanged(listener: (agents: AgentStatus[]) => void): () => void;
  onQueueChanged(listener: (status: QueueStatus) => void): () => void;
  onReportEnvironmentChanged(listener: (status: ReportEnvironmentStatus) => void): () => void;
  onReportSettingsChanged(listener: (value: { settings: ReportSettings; environment: ReportEnvironmentStatus }) => void): () => void;
  onResourcesChanged(listener: (resources: ProviderResourceSummary[]) => void): () => void;
  onOrchestrationSettingsChanged(listener: (value: { settings: OrchestrationSettings; resources: ProviderResourceSummary[] }) => void): () => void;
}
