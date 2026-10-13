import { mkdir, readFile } from "node:fs/promises";
import { JsonFileWriter } from "./json-file-writer";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createLegacyWorkflow, createExecutionWorkflow } from "./orchestration";
import { AgentOutputFormatter, extractAgentFailure } from "./agent-output";
import { initialGoal, goalPreparationUnit } from "./goals";
import { validateLesson } from "./paper-lesson";
import { validateAutonomy } from "./autonomy";
import { defaultExecution, validateExecution } from "./execution-policy";
import { pairUnits } from "./review-pair";
import { repairPausedCrossReviews } from "./recovery";
import { isActiveTaskState } from "./task-state";
import type { AgentId, CreateTaskInput, TaskRecord, TaskState } from "./types";

interface StoreFile {
  version: 2;
  tasks: TaskRecord[];
}

interface LegacyTask {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  agentId: AgentId;
  state: string;
  output: string;
  error?: string;
  usage?: TaskRecord["usage"];
  report?: TaskRecord["report"];
  createdAt: string;
  updatedAt: string;
}

function normalizeLegacyState(state: string): TaskState {
  if (state === "waiting") return "blocked";
  if (state === "review") return "reviewing";
  if (["queued", "running", "completed", "failed", "cancelled", "paused"].includes(state)) {
    return state as TaskState;
  }
  return "failed";
}

function migrateTask(value: TaskRecord | LegacyTask): TaskRecord {
  const candidate = value as Partial<TaskRecord>;
  if (Array.isArray(candidate.workUnits) && Array.isArray(candidate.runs)
    && Array.isArray(candidate.allowedAgentIds) && candidate.strategy) {
    return value as TaskRecord;
  }
  const legacy = value as LegacyTask;
  const state = normalizeLegacyState(legacy.state);
  const finished = ["completed", "failed", "cancelled"].includes(state);
  return {
    id: legacy.id,
    title: legacy.title,
    prompt: legacy.prompt,
    cwd: legacy.cwd,
    strategy: "balanced",
    allowedAgentIds: [legacy.agentId],
    modelOverrides: {},
    workUnits: createLegacyWorkflow(legacy.agentId, finished),
    runs: [],
    state,
    output: legacy.output ?? "",
    error: legacy.error,
    usage: legacy.usage,
    report: legacy.report,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    agentId: legacy.agentId,
    legacySingleAgent: true
  };
}

const LEGACY_PROVIDER: Record<AgentId, string> = {
  codex: "openai-default",
  claude: "anthropic-default",
  gemini: "google-default",
  antigravity: "google-antigravity",
  opencode: "opencode-default"
};

function repairLegacyRun(task: TaskRecord): { task: TaskRecord; changed: boolean } {
  if (!task.legacySingleAgent || task.runs.length || !task.output || !task.agentId) {
    return { task, changed: false };
  }
  const worker = task.workUnits.find((unit) => unit.role === "worker");
  if (!worker) return { task, changed: false };
  const formatter = new AgentOutputFormatter(task.agentId);
  const displayOutput = formatter.push("stdout", task.output) + formatter.flush();
  const runState = task.state === "cancelled" ? "cancelled" : task.state === "failed" ? "failed" : "completed";
  return {
    changed: true,
    task: {
      ...task,
      output: displayOutput || task.output,
      runs: [{
        id: randomUUID(),
        workUnitId: worker.id,
        role: "worker",
        agentId: task.agentId,
        providerKey: LEGACY_PROVIDER[task.agentId],
        state: runState,
        output: task.output,
        displayOutput: displayOutput || task.output,
        error: task.error,
        usage: task.usage,
        startedAt: task.createdAt,
        completedAt: task.updatedAt
      }]
    }
  };
}

function recoverInterruptedTask(task: TaskRecord): { task: TaskRecord; changed: boolean } {
  if (!isActiveTaskState(task.state)
    && !task.runs.some(run => run.state === "running") && !task.workUnits.some(unit => unit.state === "running")) {
    return { task, changed: false };
  }
  // Cancelling a local record does not terminate an SSH-side process. Persist
  // the existing launch fence before a new attempt can reuse its workspace.
  const remoteUnitIds = new Set(task.runs.filter(run => run.state === "running" && run.executionLocation === "remote").map(run => run.workUnitId));
  const message = remoteUnitIds.size
    ? "アプリの終了で遠隔担当との接続が途切れました。作業と計画は保持しています。SSHを再接続して同じ工程から再開すると、旧担当の終了・実行ロックを確認してから次の担当を起動します。"
    : "The previous Scientelier session ended during this workflow. Retry routing to continue safely.";
  return {
    changed: true,
    task: {
      ...task,
      state: task.state === "paused" ? "paused" : "blocked",
      resumeFromUnitId: task.workUnits.find(unit => unit.state === "running")?.id ?? task.workUnits.find(unit => unit.state !== "completed")?.id,
      error: message,
      workUnits: task.workUnits.map((unit) => unit.state === "running"
        ? { ...unit, state: "blocked", error: message, ...(remoteUnitIds.has(unit.id) ? { launchBlocked: true } : {}) }
        : unit),
      runs: task.runs.map((run) => run.state === "running"
        ? { ...run, state: "cancelled", error: message,
          // A crash's exact exit time is unknown. Use the last saved observation,
          // not app restart time, which would charge hours of offline waiting.
          completedAt: new Date(Math.min(Date.now(), Math.max(Date.parse(run.startedAt) || 0, Date.parse(task.updatedAt) || Date.parse(run.startedAt) || Date.now()))).toISOString(),
          ...(run.executionLocation === "remote" ? { terminationUnconfirmed: true,
            ...(run.remoteSession ? {remoteSession:{...run.remoteSession,detached:true}} : {}) } : {}) }
        : run),
      report: task.report?.state === "building"
        ? { ...task.report, state: "failed", error: message }
        : task.report,
      updatedAt: new Date().toISOString()
    }
  };
}

function repairEmptyCodexRun(task: TaskRecord): { task: TaskRecord; changed: boolean } {
  const failedRun = task.runs.find((run) =>
    !run.terminal && run.agentId === "codex"
    && run.state === "completed"
    && run.usage?.source === "unknown"
    && /Reading additional input from stdin/i.test(run.output)
  );
  if (!failedRun) return { task, changed: false };
  const failedIndex = task.workUnits.findIndex((unit) => unit.id === failedRun.workUnitId);
  if (failedIndex < 0) return { task, changed: false };
  const message = "Codex produced no task output because the previous runner left stdin open. Retry routing to rerun this step.";
  return {
    changed: true,
    task: {
      ...task,
      state: "blocked",
      error: message,
      workUnits: task.workUnits.map((unit, index) => index < failedIndex ? unit : {
        ...unit,
        state: index === failedIndex ? "blocked" : "pending",
        assignedAgentId: undefined,
        attemptedAgentIds: [],
        output: undefined,
        error: index === failedIndex ? message : undefined,
        startedAt: undefined,
        completedAt: undefined
      }),
      runs: task.runs.map((run) => run.id === failedRun.id
        ? { ...run, state: "failed", error: message }
        : run),
      updatedAt: new Date().toISOString()
    }
  };
}

function refreshReadableRuns(task: TaskRecord): { task: TaskRecord; changed: boolean } {
  let changed = false;
  const runs = task.runs.map((run) => {
    if (!run.output || run.terminal) return run;
    const formatter = new AgentOutputFormatter(run.agentId);
    const displayOutput = formatter.push("stdout", run.output) + formatter.flush();
    if (!displayOutput || displayOutput === run.displayOutput) return run;
    changed = true;
    return { ...run, displayOutput };
  });
  const workUnits = task.workUnits.map((unit) => {
    const run = [...runs].reverse().find((candidate) => candidate.workUnitId === unit.id);
    // A terminal summary is presentation text, not the workflow result. Older
    // reloads replaced the latter and lost the separately submitted work-check.
    if (run?.terminal) {
      if (unit.state === "completed" && run.state === "completed"
        && unit.output === run.displayOutput && run.structuredResult
        && run.structuredResult.length <= 256000 && !unit.output?.includes("<work-check>")) {
        const checks = [...run.structuredResult.matchAll(/<work-check>([\s\S]*?)<\/work-check>/g)];
        // Recover only the explicit unfinished-work report from this exact run.
        // Never promote a saved receipt into completion or recover failed runs.
        if (checks.length === 1) try {
          if (JSON.parse(checks[0][1]).status === "needs-work") {
            changed = true;
            return { ...unit, output: `${unit.output ?? ""}\n${checks[0][0]}` };
          }
        } catch { /* Malformed receipts remain untrusted. */ }
      }
      return unit;
    }
    if (!run?.displayOutput || unit.output === run.displayOutput) return unit;
    changed = true;
    return { ...unit, output: run.displayOutput };
  });
  const output = workUnits
    .filter((unit) => unit.output)
    .map((unit) => `===== ${unit.title} · ${unit.assignedAgentId ?? "local"} =====\n${unit.output}`)
    .join("\n\n");
  if (output && output !== task.output) changed = true;
  return {
    changed,
    task: changed ? { ...task, runs, workUnits, output: output || task.output } : task
  };
}

function repairHistoricalRunErrors(task: TaskRecord): { task: TaskRecord; changed: boolean } {
  let changed = false;
  const runs = task.runs.map((run) => {
    if (run.terminal) return run;
    const maxTurns = run.state === "rate-limited" && /(?:error_max_turns|terminal_reason\\?":\\?"max_turns|Reached maximum number of turns)/i.test(run.error ?? "");
    const generic = /^CLI exited with code/i.test(run.error ?? "");
    if (!maxTurns && !generic) return run;
    const concrete = extractAgentFailure(run.output, run.output);
    changed = true;
    return {
      ...run,
      state: maxTurns ? "failed" as const : run.state,
      error: concrete ?? (maxTurns ? "Agent reached its configured turn limit." : run.error)
    };
  });
  const lastFailed = [...runs].reverse().find((run) => run.state === "failed" && run.error);
  const taskError = /^CLI exited with code/i.test(task.error ?? "") && lastFailed?.error
    ? lastFailed.error
    : task.error;
  if (taskError !== task.error) changed = true;
  const workUnits = task.workUnits.map((unit) => {
    if (!/^CLI exited with code/i.test(unit.error ?? "")) return unit;
    const run = [...runs].reverse().find((candidate) => candidate.workUnitId === unit.id && candidate.error);
    if (!run?.error) return unit;
    changed = true;
    return { ...unit, error: run.error };
  });
  return { changed, task: changed ? { ...task, runs, workUnits, error: taskError } : task };
}

export class JsonTaskStore {
  private data: StoreFile = { version: 2, tasks: [] };
  private readonly writer: JsonFileWriter;

  constructor(private readonly filePath: string) { this.writer = new JsonFileWriter(filePath); }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { version?: number; tasks?: Array<TaskRecord | LegacyTask> };
      let repaired = false;
      const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks.map(migrateTask) : []).map((task) => {
        const legacy = repairLegacyRun(task);
        const interrupted = recoverInterruptedTask(legacy.task);
        const emptyCodex = repairEmptyCodexRun(interrupted.task);
        const readable = refreshReadableRuns(emptyCodex.task);
        const errors = repairHistoricalRunErrors(readable.task);
        const paused = repairPausedCrossReviews(errors.task);
        repaired ||= legacy.changed || interrupted.changed || emptyCodex.changed || readable.changed || errors.changed || paused !== errors.task;
        return paused;
      });
      this.data = {
        version: 2,
        tasks
      };
      if (parsed.version !== 2 || repaired) await this.persist();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  list(): TaskRecord[] {
    // Newest-first UI order, including tasks created within the same millisecond.
    // The queue reverses this list, so ties must retain original insertion order.
    return structuredClone(this.data.tasks).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): TaskRecord | undefined {
    const task = this.data.tasks.find((item) => item.id === id);
    return task ? structuredClone(task) : undefined;
  }

  async create(input: CreateTaskInput, workPreset?: TaskRecord["workPreset"], remote?: TaskRecord["remote"]): Promise<TaskRecord> {
    const autonomy = validateAutonomy({ enabled: true, maxCycles: 3, targetMinutes: input.targetMinutes });
    const now = new Date().toISOString();
    if (input.goalMode !== undefined && !["manual", "ai"].includes(input.goalMode)) throw new Error("ゴール作成方法が不正です。");
    if (input.workflowMode !== undefined && input.workflowMode !== "primary") throw new Error("新しいタスクは主担当方式で作成してください。");
    const workflowMode = "primary";
    const goalMode = input.goalMode ?? (workPreset ? "manual" : undefined);
    const goal = goalMode ? initialGoal(input.prompt.trim(), workPreset) : undefined;
    if (goal && workPreset?.manifest.primaryDocument === "beamer") {
      if (!input.lesson) throw new Error("論文解説の入力が必要です。");
      goal.lesson = validateLesson({ ...input.lesson, topics: [] });
    }
    const task: TaskRecord = {
      remote: remote ? structuredClone(remote) : undefined,
      // User-selected application default, captured only when creating a local
      // task. Never reinterpret missing permissions on previously saved tasks.
      ...(!remote ? { localCodexPermissions: "full-access" as const } : {}),
      id: randomUUID(),
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      cwd: input.cwd,
      strategy: input.strategy,
      workflowMode,
      execution: validateExecution(input.execution ?? defaultExecution),
      workPreset: workPreset ? structuredClone(workPreset) : undefined,
      researchCycle: workPreset?.manifest.id === "research-project" ? 1 : undefined,
      qualityCycle: 1,
      allowedAgentIds: [...new Set(input.allowedAgentIds)],
      modelOverrides: structuredClone(input.modelOverrides),
      goal,
      reviewPolicy: goal ? "adversarial-pair" : undefined,
      autonomy: goal || input.targetMinutes !== undefined ? autonomy : undefined,
      goalPreparation: goalMode === "ai",
      workUnits: goalMode === "ai" ? [goalPreparationUnit(goal!, "")] : createExecutionWorkflow({ workflowMode, workPreset }),
      runs: [],
      state: goalMode === "manual" ? "awaiting-input" : "queued",
      awaitingReason: goalMode === "manual" ? "goal" : undefined,
      output: "",
      createdAt: now,
      updatedAt: now
    };
    if (task.reviewPolicy && !task.goalPreparation) task.workUnits = pairUnits(task.workUnits);
    this.data.tasks.push(task);
    await this.persist();
    return structuredClone(task);
  }

  async update(id: string, patch: Partial<Omit<TaskRecord, "id" | "createdAt">>): Promise<TaskRecord> {
    const index = this.data.tasks.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`Task ${id} was not found.`);
    const updated: TaskRecord = {
      ...this.data.tasks[index],
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.data.tasks[index] = updated;
    await this.persist();
    return structuredClone(updated);
  }

  async insertRestart(task: TaskRecord): Promise<TaskRecord> {
    if (!task.restart || this.data.tasks.some(t => t.id === task.id)) throw new Error("やり直しタスクの登録が不正です。");
    this.data.tasks.push(structuredClone(task));
    await this.persist();
    return structuredClone(task);
  }

  /** Validate the whole batch first, then persist one task-file snapshot.
   * Callers own admission locks; no intermediate per-task disk state is saved. */
  async updateMany(updates: Array<{ id: string; patch: Partial<Omit<TaskRecord, "id" | "createdAt">> }>): Promise<void> {
    const ids = new Set(updates.map(update => update.id));
    if (ids.size !== updates.length || updates.some(update => !this.data.tasks.some(task => task.id === update.id)))
      throw new Error("更新対象のタスクを確認できません。設定を読み直してください。");
    if (!updates.length) return;
    const at = new Date().toISOString();
    this.data.tasks = this.data.tasks.map(task => {
      const update = updates.find(item => item.id === task.id);
      return update ? { ...task, ...structuredClone(update.patch), updatedAt: at } : task;
    });
    await this.persist();
  }

  async delete(id: string): Promise<TaskRecord> {
    const index = this.data.tasks.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`Task ${id} was not found.`);
    const [deleted] = this.data.tasks.splice(index, 1);
    await this.persist();
    return structuredClone(deleted);
  }

  private persist(): Promise<void> { return this.writer.write(this.data); }
}
