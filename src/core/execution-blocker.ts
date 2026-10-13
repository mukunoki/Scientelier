import type { AgentId, TaskRecord, WorkUnit } from "./types";
import { readWorkCheckEnvelope } from "./work-check-format";

export interface ExecutionFailure {
  kind: "permission" | "tool" | "hardware" | "connection";
  summary: string;
  recovery: string;
  /** A minimal failed check, not a command to execute or a claim of acceptance. */
  check?: string;
}
export interface ExecutionBlocker extends ExecutionFailure {
  unitId: string;
  runId?: string;
  round: number;
  cycle: number;
  goalRevision?: number;
  at: string;
}
export class ExecutionEnvironmentError extends Error {
  constructor(readonly failure: ExecutionFailure) { super(failure.summary); }
}

export function executionFailure(value: unknown): ExecutionFailure | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (!["permission", "tool", "hardware", "connection"].includes(String(v.kind))
    || [v.summary, v.recovery].some(s => typeof s !== "string" || !s.trim() || s.length > 600)
    || v.check !== undefined && (typeof v.check !== "string" || !v.check.trim() || v.check.length > 1200)) return;
  return {kind:v.kind as ExecutionFailure["kind"],summary:(v.summary as string).trim(),recovery:(v.recovery as string).trim(),
    ...(v.check !== undefined ? {check:(v.check as string).trim()} : {})};
}

/** Only explicit, scoped negative results block execution. Terminal text and
 * stale successful reports must not accidentally veto a new run. */
export function reportedExecutionFailure(output: string): ExecutionFailure | undefined {
  const blocks = [...output.matchAll(/<work-check>([\s\S]*?)<\/work-check>/g)];
  if (blocks.length !== 1) return;
  try { return executionFailureFromCheck(readWorkCheckEnvelope(blocks[0][1])); } catch { return; }
}
export function executionFailureFromCheck(value: unknown): ExecutionFailure | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (v.status === "environment-blocked") return executionFailure(v.blocker);
  // Backward compatibility is deliberately narrow: these are concrete CLI
  // setup denials, not ordinary test defects or optional device failures.
  if (["needs-work", "ask-user"].includes(String(v.status)) && typeof v.summary === "string"
    && v.summary.split("\n").some(line => /bwrap:\s*(?:setting up uid map|loopback: Failed RTM_NEWADDR|Creating new namespace)[^\n]{0,160}(?:Permission denied|Operation not permitted)/i.test(line)
      && !/(?:以前|過去|解決済|修復済|復旧済|resolved|previous|historical|already fixed)/i.test(line)))
    return {kind:"permission",summary:"CLIのサンドボックス初期化が拒否され、必須のコマンドを実行できません。",
      recovery:"タスクの実行権限と接続先の制限を確認し、復旧後に「中断した工程から再開」を押してください。",check:v.summary.slice(0,1200)};
}

export function currentExecutionBlocker(task: TaskRecord): ExecutionBlocker | undefined {
  const b = task.executionBlocker;
  return b && b.round === (task.roundNumber ?? 1) && b.cycle === (task.autonomyCycle ?? 1)
    && b.goalRevision === task.goal?.revision && task.workUnits.some(u => u.id === b.unitId) ? b : undefined;
}
export function executionBlockerPatch(task: TaskRecord, unitId: string, failure: ExecutionFailure, runId?: string): Partial<TaskRecord> {
  // The first failure owns the resume point. Parallel siblings may finish, but
  // cannot clear it or send the task into reporting/replanning.
  const blocker = currentExecutionBlocker(task) ?? {...failure,unitId,runId,round:task.roundNumber ?? 1,
    cycle:task.autonomyCycle ?? 1,goalRevision:task.goal?.revision,at:new Date().toISOString()};
  return {executionBlocker:blocker,state:"blocked",error:blocker.summary,resumeFromUnitId:blocker.unitId,
    workUnits:task.workUnits.map(u => u.id === unitId ? {...u,state:"blocked",launchBlocked:true,error:failure.summary} : u)};
}

/** Mandatory Git recording cannot be fulfilled by a local Codex writer whose
 * sandbox protects .git. Isolated packages need no commit, unless their only
 * possible integration owner is already known to have the same blocker. */
export function localPermissionFailure(task: TaskRecord, unit: WorkUnit, agentId: AgentId, remoteExecution: boolean, permissions: string): ExecutionFailure | undefined {
  if (remoteExecution || agentId !== "codex" || permissions === "full-access" || task.goalPreparation
    || unit.planPhase || unit.orchestrator || unit.mode !== "write") return;
  const owner = task.assignments?.worker;
  const codexOnlyOwner = task.allowedAgentIds?.length === 1 && task.allowedAgentIds[0] === "codex"
    || owner?.agentId === "codex" && !owner.allowFallback;
  if (unit.subtask?.kind === "isolated-work" && !codexOnlyOwner) return;
  return {kind:"permission",summary:"このCodexのサンドボックス設定では、必須のGit記録を行えません。実作業は開始していません。",
    recovery:"上の作業場所・実行設定で、このタスクのCodex権限をFull accessに変更し、「中断した工程から再開」を押してください。権限を広げない場合は担当CLIを変更してください。",
    check:"local Codex: sandbox; .git is protected; mandatory task-owned commits cannot be recorded"};
}

export function executionEnvironmentGuidance(): string {
  return `\n\n# 必須実行条件の早期確認・停止
計画には、対象環境での必須ツール・権限・ハードウェア利用の最小確認を最初に含めてください。実作業担当は自身のCLIセッションで、長い調査・実装・測定の前に確認します。同じ環境・権限で有効な既存証拠は再利用できます。読み取り担当は確認でも書き込みや実験を行わず、担当外の機能を試しません。
必須機能が使えず、限定的な通常修復1回でも直らない場合は直ちに environment-blocked を提出して終了します。GPU取得nil、必須ツール不在、権限拒否等を、CPUのみの評価や原稿仕上げで代替して完了扱いにしません。任意機能の失敗・通常のコード不具合・担当外の後続作業は既存の修正経路を使います。CLIサービス側の認証・使用枠・API障害は別CLIへの引継ぎ対象であり、作業環境自体の障害とは区別します。権限拡大・制約解除は自己判断で行いません。
全担当で通常の結果の代わりに次のwork-checkを既存の結果提出経路で提出できます。原因と復旧操作は短い日本語1文ずつ、checkは実際の最小確認とエラー、remainingWorkは未実施事項です。証拠が作れなければ空配列で構いません。
<work-check>{"status":"environment-blocked","summary":"原因","remainingWork":"未実施事項","estimatedRemainingMinutes":0,"evidence":[],"blocker":{"kind":"permission","summary":"原因","recovery":"復旧操作","check":"確認とエラー"}}</work-check>
kindはpermission/tool/hardware/connectionのいずれかです。提出後は追加作業せず、短い説明と通常の完了通知で終了します。環境復旧まで再作業・レポート・レビューの起動を止めます。これは合格や要件緩和ではありません。`;
}
