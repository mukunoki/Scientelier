export const AGENT_IDS = ["codex", "claude", "gemini", "opencode", "antigravity"] as const;

export type AgentId = (typeof AGENT_IDS)[number];
// Gemini remains a historical record ID, never an executable choice.
export const ACTIVE_AGENT_IDS = ["codex", "claude", "antigravity", "opencode"] as const;

export interface PreparedTarget { hostname: string; username: string; home: string; cwd: string; nodeExecutable: string; }
export interface RemoteSystem {
  terminalBackend?: "auto" | "tmux" | "direct";
  codexPermissions?: "sandbox" | "full-access";
  connectionMode?: "direct" | "prepared";
  pythonCommand?: string;
  preparedTarget?: PreparedTarget;
  id: string; name: string; host: string; cwd: string;
  username?: string; port?: number;
  resolvedCwd?: string;
  nodeCommand: string; startup: string; instructions: string;
  texCommand: string;
}

export type TaskState =
  | "queued"
  | "planning"
  | "running"
  | "reviewing"
  | "reporting"
  | "paused"
  | "awaiting-input"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStrategy = "balanced" | "quality" | "quota-saver";
/** staged is read-only compatibility for saved tasks, not a new-task option. */
export type WorkflowMode = "primary" | "staged";
export type WorkFocus = "research" | "idea" | "literature" | "implementation" | "paper" | "poster" | "paper-explainer";
export interface WorkPresetManifest {
  id: string; name: string; description: string; version: 1; rules: "rules.md";
  focus?: WorkFocus;
  ideaApproach?: "experimental";
  document?: "paper" | "poster";
  primaryDocument?: "beamer" | "paper";
  /** Modes supply methods to one owner, not compulsory handoff phases. */
  integratedWorkflow?: boolean;
  goal: { deliverables: string[]; criteria: GoalCriterion[]; questions: string[] };
}
export interface WorkPresetSnapshot {
  manifest: WorkPresetManifest; rules: string; commonRules: string;
  stages?: WorkPresetSnapshot[];
  documentTemplate?: { id: "paper" | "poster"; source: string; latexmkrc: string };
  revision: string; source: "builtin" | "user"; capturedAt: string;
}
export interface WorkPresetCatalog { presets: WorkPresetSnapshot[]; errors: string[]; userDirectory: string; editingVersion?: number; defaultPresetId?: string; }
export interface ExecutionPolicy {
  scheduling?: "balanced" | "throughput";
  reviewMode?: "pair" | "cross-service" | "parallel";
  reuseContext: boolean;
  decompose: boolean;
  maxSubtasks: number;
  maxParallel: number;
  tokenBudget?: number;
  contextTokens?: number;
}
export type ModelFamily = "openai" | "anthropic" | "gemini" | "deepseek" | "glm";
export interface WorkRequirements {
  /** Blind peers can run together when their allowed model-family sets are disjoint. */
  independenceGroup?: string;
  modelFamilies?: ModelFamily[];
  independentFrom?: string[];
  skills?: Array<{ id: string; revision?: string }>;
}
export interface SubtaskSpec {
  /** Explicit peer consultation; independent seats can never opt in. */
  communication?: {with:string[];purpose:string};
  /** Competing blind candidates share input/evaluation, but explore different approaches. */
  comparison?: { input: string; evaluation: string; approach: string };
  purpose?: "speed" | "balance" | "verify" | "explore";
  requirements?: WorkRequirements;
  researchCritic?: boolean;
  capability?: import("./model-benchmarks").Capability;
  kind?: "investigation" | "primary-work" | "isolated-work";
  /** Reason from supplied assignment text only, never mutable workspace files. */
  inputScope?: "assignment";
  /** Opt-in for non-measurement primary steps; benchmarks remain exclusive. */
  allowTaskOnlyPeers?: boolean;
  ownedFiles?: string[];
  estimatedMinutes?: number;
  key: string; title: string; instructions: string; deliverable: string;
  acceptance: string; criterionIds: string[]; dependsOn: string[]; estimatedTokens: number;
}
export interface ExecutionPlan {
  /** Early content improvement uses ordinary packages, not a new review gate. */
  refinement?: { objective: string; proposalKeys: string[]; applicationKey?: string; stopWhen: string };
  coordination?: { criticalPath: string; parallelBenefit: string; contextPlan: string; resourcePlan: string };
  revision: number; round: number; goalRevision: number; createdAt: string; sourceUnitId: string;
  summary: string; reason: string; primaryWork: string; acceptance: string; criterionIds: string[];
  estimatedTokens: number; estimatedMinutes: number; escalation: string;
  tasks: SubtaskSpec[]; primaryUnitId: string; taskUnitIds: Record<string, string>;
}
export type WorkUnitRole = "planner" | "worker" | "reviewer" | "reporter";
export type WorkUnitMode = "read" | "write" | "local";
export type WorkUnitState = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";
export type AgentRunState = "running" | "completed" | "failed" | "rate-limited" | "cancelled";

export type RoundKind = "initial" | "consult" | "continue" | "review" | "report";
export interface RoleAssignment {
  agentId?: AgentId;
  model?: string;
  allowFallback: boolean;
}
export interface FollowupInput {
  scopeChange?: { goalRevision: number; removeConstraints: string[]; removeOutOfScope: string[]; criterionEdits?: { id: string; description: string; verification: string }[]; implementation: boolean; confirmed: true };
  implementation?: boolean;
  instruction: string;
  kind: Exclude<RoundKind, "initial">;
  assignments: Partial<Record<WorkUnitRole, RoleAssignment>>;
  pauseAfterPlan: boolean;
}
export interface TaskRound {
  workClosure?: TaskRecord["workClosure"];
  workPreset?: WorkPresetSnapshot;
  goal?: GoalContract;
  number: number;
  kind: RoundKind;
  instruction: string;
  state: TaskState;
  workUnits: WorkUnit[];
  report?: ReportRecord;
  finishedAt: string;
}

export interface WorkUnit {
  /** Captured once per substantive round. Old saved graphs have no new gate. */
  contentCheck?: {stage:"initial"|"peer"|"response";round:number;goalRevision:number;sourceUnitId?:string;estimatedMinutes?:number};
  /** User-selected replacement for this unit only; normal eligibility still applies. */
  retryAgentId?: AgentId;
  launchBlocked?: boolean;
  qualityRetries?: number;
  orchestrator?: { round: number; goalRevision: number; planRevision: number; triggerUnitIds: string[];
    timeCheckpoint?: 1|2;
    pendingUnits?: Array<{ id: string; fingerprint: string }> };
  /** Additive guidance only: original scope, dependencies and launch contracts remain. */
  coordinationNotes?: Array<{ decisionId: string; note: string }>;
  allocatedBy?: string;
  primaryStep?: boolean;
  /** Independent seats bind providerKey; an aggregate may use any eligible
   * fresh reviewer and receives all sourceUnitIds. It never adds a blind vote. */
  crossReview?: { wave: 1 | 2; providerKey: string; sourceUnitIds: string[]; aggregate?: boolean };
  researchStage?: string;
  ideaPhase?: boolean;
  reviewPass?: 1 | 2;
  reviewFormatRetries?: number;
  reviewFormatFeedback?: string;
  workCheckRetries?: number;
  planFormatRetries?: number;
  timePlanReviewed?: boolean;
  planFormatFeedback?: string;
  workCheckFeedback?: string;
  planPhase?: boolean;
  planRevision?: number;
  plannedTokens?: number;
  subtask?: SubtaskSpec;
  delegationHandled?: boolean;
  delegationUsed?: boolean;
  primary?: boolean;
  checkpointFor?: string;
  checkpointHandled?: boolean;
  workAttempt?: number;
  id: string;
  role: WorkUnitRole;
  title: string;
  instructions: string;
  mode: WorkUnitMode;
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

export interface FinishingSkillSnapshot { rules: string; revision: string; capturedAt: string; }
export interface FinishingCheck {
  revision: string; status: "completed" | "blocked"; summary: string; sources: string[]; concerns: string[];
  /** Missing scientific/source evidence is separate from editorial/PDF defects.
   * These issues still block release and must never be converted to a pass. */
  prerequisites?: string[];
}

export interface AgentRun {
  /** Reattachment identity, not authority to launch or certify work. */
  remoteSession?: { token: string; controlDirectory: string; detached?: boolean };
  /** Confirmed native failure, separate from subscription usage/quota. */
  executionFailure?: import("./cli-transient-failure").CliFailure;
  runtimeIdentity?: import("./runtime-identity").RuntimeIdentity;
  /** Startup/permission wait is not active work. Missing metadata is legacy/unknown, not confirmed work. */
  executionTiming?: { workStartedAt?: string; source: "channel" | "log" };
  /** File/freshness verification only; never substitutes for editorial or independent review. */
  reportArtifactCheck?: { available: boolean; checkedAt: string };
  /** Fail-closed handoff barrier; survives restart until CLI exit is verified. */
  terminationUnconfirmed?: boolean;
  terminationPid?: number;
  /** Manual CLI health confirmation, never a work-completion or quota receipt. */
  recoveredAt?: string;
  executionLocation?: "local" | "remote";
  codexPermissions?: "sandbox" | "full-access";
  remoteStartedAt?: string;
  finishingSkill?: FinishingSkillSnapshot;
  finishingCheck?: FinishingCheck;
  editorialSnapshot?: import("./editorial-reuse").EditorialSnapshot;
  editorialReuseFrom?: string;
  primary?: boolean;
  sessionId?: string;
  continuedFrom?: string;
  contextReason?: string;
  goalRevision?: number;
  estimatedTokens?: number;
  contextEstimate?: number;
  skillUsage?: import("./channel-state").SkillUsage;
  goalPreparation?: boolean;
  terminal?: boolean;
  id: string;
  workUnitId: string;
  role: WorkUnitRole;
  agentId: AgentId;
  providerKey: string;
  model?: string;
  state: AgentRunState;
  output: string;
  displayOutput?: string;
  // Recovery data only. A receipt never authorizes workflow completion.
  structuredResult?: string;
  logPath?: string;
  error?: string;
  usage?: UsageRecord;
  subagentCount?: number;
  startedAt: string;
  completedAt?: string;
}

export interface OrchestratorDecision {
  timeCheckpoint?: 1|2;
  id: string;
  round: number;
  goalRevision: number;
  planRevision: number;
  triggerUnitIds: string[];
  status: "deciding" | "added" | "adjusted" | "waiting" | "skipped";
  reason: string;
  addedUnitIds: string[];
  refinements?: Array<{ unitId: string; note: string }>;
  createdAt: string;
  completedAt?: string;
}

export interface TaskRecord {
  /** First-hop routing only. The final prepared target remains pinned. */
  loginRouteChanges?: Array<{at:string;from:Pick<RemoteSystem,"id"|"name"|"host"|"username"|"port">;to:Pick<RemoteSystem,"id"|"name"|"host"|"username"|"port">}>;
  agentMessages?: import("./agent-messages").AgentMessage[];
  /** Negative environment evidence only; never a goal acceptance record. */
  executionBlocker?: import("./execution-blocker").ExecutionBlocker;
  /** Explicit user choice; never inherited from a remote profile or a model plan. */
  localCodexPermissions?: "sandbox" | "full-access";
  /** View projection only; never used to authorize execution. */
  executionMetrics?: import("./execution-metrics").ExecutionMetrics;
  /** All rounds, for graph/timeline display only. Round-scoped budgets stay unchanged. */
  workflowMetrics?: import("./execution-metrics").ExecutionMetrics;
  /** Derived UI hint; an answer and normal execution gates are still required. */
  continuationUnitId?: string;
  timeOutlook?: ReturnType<typeof import("./time-budget").taskTimeOutlook>;
  /** Partial closure never certifies goal satisfaction; scoped to a single round. */
  workClosure?: { round: number; cycle: number; goalRevision: number; startedAt: string; finishedAt?: string; reportCorrectionAttemptedAt?: string; reason: string; issues: string[] };
  lessonSources?: LessonSource[];
  lessonSkills?: Array<{ id: string; description: string; content: string }>;
  reportRepairs?: Array<{ round: number; goalRevision: number; reporterId: string; ownerId: string; reason: string; at: string }>;
  /** Derived UI explanation; not authority to mark a report accepted. */
  reportRecovery?: ReportRecovery;
  crossReviewReplans?: Array<{at:string;round:number;removedProvider:string;workUnits:WorkUnit[]}>;
  qualityCycle?: 1;
  researchCycle?: 1;
  /** Transient per-run catalog; never used as authority or persisted by itself. */
  managedSkills?: Array<{id:string;description:string;content:string}>;
  orchestratorDecisions?: OrchestratorDecision[];
  goalRevisionPending?: boolean;
  scopeTransition?: { fromPreset?: WorkPresetSnapshot; requestedAt: string; round: number; instruction: string; removedConstraints?: string[]; removedOutOfScope?: string[] };
  remote?: RemoteSystem;
  reviewPolicy?: "adversarial-pair";
  reviewAdjustments?: Array<{ round: number; cycle: number; goalRevision: number; mode: "pair" | "single"; unitIds: string[]; omittedUnits: WorkUnit[]; decidedAt: string; targetMinutes: number; elapsedMinutes: number; estimatedMinutes: number; reason: string }>;
  restart?: { sourceTaskId: string; mode: "carry" | "fresh"; handoff?: string };
  workPreset?: WorkPresetSnapshot;
  executionPlans?: ExecutionPlan[];
  retiredWorkUnits?: WorkUnit[];
  execution?: ExecutionPolicy;
  pendingExecution?: { policy: ExecutionPolicy; savedAt: string };
  executionRevision?: number;
  executionAppliedAt?: string;
  contextPath?: string;
  budgetStatus?: { used: number; reserve: number; limit?: number; estimated: boolean };
  workflowMode?: WorkflowMode;
  resumeFromUnitId?: string;
  resumeCount?: number;
  resumeInstructions?: Array<{ round: number; unitId: string; at: string; instruction: string }>;
  lastResumedAt?: string;
  interruptedHistory?: TaskRound[];
  autonomy?: AutonomySettings;
  autonomyCycle?: number;
  autonomyState?: "working" | "satisfied" | "needs-input" | "cycle-limit" | "stalled" | "invalid-review";
  evaluations?: GoalEvaluation[];
  autonomyHistory?: Array<{ cycle: number; round: number; workUnits: WorkUnit[] }>;
  goal?: GoalContract;
  goalHistory?: GoalContract[];
  goalPreparation?: boolean;
  id: string;
  title: string;
  prompt: string;
  cwd: string;
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
  agentId?: AgentId;
  legacySingleAgent?: boolean;
  roundNumber?: number;
  roundKind?: RoundKind;
  instruction?: string;
  history?: TaskRound[];
  pendingFollowup?: FollowupInput;
  assignments?: Partial<Record<WorkUnitRole, RoleAssignment>>;
  initialAssignment?: RoleAssignment & { round: number };
  pauseAfterPlan?: boolean;
  planApproved?: boolean;
  awaitingReason?: "plan" | "result" | "goal";
}

export interface ReportRecovery {
  reporterId: string;
  resumeStage?: "paper";
  kind: "prerequisite" | "document" | "environment" | "user-input";
  summary: string;
  concerns: string[];
  pdfAvailable: boolean;
  canReplan: boolean;
  unavailableReason?: string;
}

export interface CreateTaskInput {
  /** Advisory duration for the whole execution round, not a timeout per CLI. */
  targetMinutes?: number;
  lesson?: { attachmentIds: string[]; references: string[]; audience: string; interests: string; language: "ja" | "en" };
  workspaceMode?: "existing" | "new" | "remote";
  remoteSystemId?: string;
  presetId?: string;
  presetRevision?: string;
  execution?: ExecutionPolicy;
  workflowMode?: WorkflowMode;
  goalMode?: "manual" | "ai";
  title: string;
  prompt: string;
  cwd: string;
  strategy: TaskStrategy;
  allowedAgentIds: AgentId[];
  modelOverrides: Partial<Record<AgentId, string>>;
}

export interface GoalCriterion {
  id: string;
  description: string;
  verification: string;
  required: boolean;
}

export interface GoalDraftInput {
  lesson?: LessonPlan;
  objective: string;
  deliverables: string[];
  criteria: GoalCriterion[];
  constraints: string[];
  outOfScope: string[];
  questions: string[];
  /** User clarification notes for goal preparation; not independent execution authority. */
  questionAnswers?: { question: string; answer: string }[];
  /** Editor candidates only. Never part of the authorized execution goal. */
  unselected?: { deliverables: string[]; criteria: GoalCriterion[]; constraints: string[]; outOfScope: string[] };
}

export interface LessonSource { name: string; relativePath: string; sha256: string; bytes: number; }
export type LessonDepth = "known" | "recap" | "foundation" | "deep";
export interface LessonPlan {
  audience: string;
  interests: string;
  language: "ja" | "en";
  references: string[];
  topics: Array<{ id: string; title: string; reason: string; dependsOn: string[]; recommended: LessonDepth; depth: LessonDepth }>;
}

export interface GoalContract extends GoalDraftInput {
  revision: number;
  status: "draft" | "approved";
  updatedAt: string;
  approvedAt?: string;
}

export interface AutonomySettings { enabled: boolean; maxCycles: number; targetMinutes?: number; }
export interface CriterionEvaluation {
  criterionId: string;
  status: "pass" | "fail" | "unverified";
  detail: string;
  evidence: Array<{ path: string; detail: string; hash?: string }>;
}
export interface GoalEvaluation {
  reviewNumber?: number;
  artifactEvidence?: Array<{ path: string; hash: string }>;
  reviewPass?: 1 | 2;
  reviewUnitId?: string;
  reviewerAgentId?: AgentId;
  concerns?: string[];
  /** Optional, bounded manuscript-only corrections; never new experiments. */
  reportCorrections?: string[];
  goalRevision: number;
  cycle: number;
  round: number;
  reviewedAt: string;
  criteria: CriterionEvaluation[];
  nextAction: "repair" | "ask-user";
  repairInstructions: string;
  summary: string;
}

export interface UsageRecord {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  source: "reported" | "estimated" | "unknown";
}

export interface AgentStatus {
  id: AgentId;
  label: string;
  command: string;
  installed: boolean;
  executable?: string;
  version?: string;
  error?: string;
}

export interface QueueStatus {
  activeTaskIds?: string[];
  running: boolean;
  stopping: boolean;
  activeTaskId?: string;
}

export type ReportState = "draft" | "building" | "ready" | "failed";

export interface ReportRecord {
  /** Artifact-only directory; harness logs/history live outside this directory. */
  storageLayout?: "isolated";
  remoteSnapshotId?: string;
  documents?: Partial<Record<"paper" | "poster", ReportRecord>>;
  state: ReportState;
  texPath?: string;
  pdfPath?: string;
  previewUrl?: string;
  error?: string;
  builtAt?: string;
}

export interface ReportSettings {
  remoteExecution?: "local" | "remote";
  texCommand: string;
  texArgs: string[];
  plotCommand: string;
  plotCheckArgs: string[];
  outputDirectory: string;
}

export type AuthMode = "subscription" | "api-key" | "cloud" | "unknown";

export interface AgentPolicy {
  codingPlan?: "zai" | "ollama" | "ollama-app";
  openCodeModels?: Partial<Record<"zai" | "ollama" | "ollama-app", string>>;
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

export interface OrchestrationSettings {
  agentPolicies: AgentPolicy[];
  warningPercent: number;
  drainPercent: number;
}

export interface ToolCheck {
  ok: boolean;
  command: string;
  detail: string;
}

export interface ReportEnvironmentStatus {
  tex: ToolCheck;
  plot: ToolCheck;
  checkedAt: string;
}

export type LimitSource = "reported-live" | "reported-run" | "configured" | "error-derived" | "unknown";

export interface UsageLimitWindow {
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
}

export interface ProviderModelInfo {
  id: string;
  label: string;
  isDefault?: boolean;
  source: "catalog" | "observed";
}

export interface RateLimitState {
  /** Explicit user-confirmed account change, not a successful authentication. */
  accountChangedAt?: string;
  refreshRetryAt?: string;
  refreshFailures?: number;
  providerKey: string;
  usedPercent?: number;
  resetAt?: string;
  windows?: UsageLimitWindow[];
  models?: ProviderModelInfo[];
  plan?: string;
  creditBalance?: string;
  ordinaryUsageAllowed?: boolean;
  cooldownUntil?: string;
  source: LimitSource;
  lastError?: string;
  refreshError?: string;
  updatedAt: string;
}

export interface ProviderResourceSummary {
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
  windows: UsageLimitWindow[];
  models: ProviderModelInfo[];
  configuredModel?: string;
  plan?: string;
  creditBalance?: string;
  ordinaryUsageAllowed?: boolean;
  capacityUpdatedAt?: string;
  capacityError?: string;
  cooldownUntil?: string;
  limitSource: LimitSource;
}

export interface AppSnapshot {
  executionDefaults?: ExecutionPolicy;
  remoteSystems?: RemoteSystem[];
  workPresets: WorkPresetCatalog;
  agents: AgentStatus[];
  tasks: TaskRecord[];
  defaultCwd: string;
  queue: QueueStatus;
  reportSettings: ReportSettings;
  reportEnvironment: ReportEnvironmentStatus;
  orchestrationSettings: OrchestrationSettings;
  resources: ProviderResourceSummary[];
}

export type RunEventType = "stdout" | "stderr" | "status";

export interface RunEvent {
  terminalOffset?: number;
  taskId: string;
  runId?: string;
  workUnitId?: string;
  agentId?: AgentId;
  type: RunEventType;
  text: string;
  displayText?: string;
  at: string;
}
