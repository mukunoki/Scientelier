// Browser equivalent of core/task-state (the renderer has no Node imports).
// A parity test keeps both runtimes aligned; pending queue ownership also
// counts as active here, before the task's saved state reaches the renderer.
function taskStateIsActive(taskState: TaskState): boolean {
  return ["planning", "running", "reviewing", "reporting"].includes(taskState);
}

function taskIsActive(task: TaskRecord): boolean {
  return Boolean(state.queue.activeTaskIds?.includes(task.id)) || taskStateIsActive(task.state);
}

function taskPartialClosure(task: TaskRecord) {
  const c = task.workClosure;
  return c?.round === (task.roundNumber ?? 1) && c.cycle === (task.autonomyCycle ?? 1) && c.goalRevision === task.goal?.revision ? c : undefined;
}

/** One read-only status for every current-task view. A finished process is not
 * acceptance, and a stale closure cannot override resumed work or a new goal. */
function taskDisplayStatus(task: TaskRecord): { label: string; tone: string } {
  if (taskIsActive(task)) return { label: task.state === "paused" ? "一時停止の処理中" : "実行中", tone: "running" };
  if (task.goal?.status === "draft") return { label: "ゴールの承認待ち", tone: "awaiting-input" };
  if (task.state === "paused") return { label: "一時停止", tone: "paused" };
  if (!task.resumeFromUnitId && !task.error?.startsWith("ユーザ確認が必要です。")
    && (task.state === "completed" || task.state === "awaiting-input" && task.awaitingReason === "result")
    && taskPartialClosure(task)?.finishedAt) return { label: "作業終了・残課題あり", tone: "needs-work" };
  if (!task.resumeFromUnitId && (task.state === "completed" || task.state === "awaiting-input" && task.awaitingReason === "result")) {
    if (task.autonomyState === "satisfied") return { label: "達成確認済み", tone: "completed" };
    if (task.workUnits.length && task.workUnits.every(u => u.state === "completed") && !task.error?.startsWith("ユーザ確認が必要です。"))
      return { label: "作業終了・達成未確認", tone: "needs-work" };
  }
  if (task.state === "awaiting-input" && task.awaitingReason === "plan") return { label: "計画の承認待ち", tone: "awaiting-input" };
  if (task.error?.startsWith("ユーザ確認が必要です。")) return { label: "回答が必要", tone: "awaiting-input" };
  if (["failed", "blocked", "awaiting-input"].includes(task.state)) return { label: "対応が必要", tone: "blocked" };
  return { label: task.state === "queued" ? "実行待ち" : task.state === "cancelled" ? "中断" : "作業終了・達成未確認", tone: task.state };
}

function taskStopGuidance(task: TaskRecord): { reason: string; next: string; action?: "answer" | "services" | "execution" } {
  const error = task.error ?? "";
  if (task.state === "paused") return { reason: "ユーザー操作による一時停止です。成果とログは保持しています。", next: "上の再開ボタンで元の工程を続けられます。追加の回答は不要です。" };
  if (task.error?.startsWith("ユーザ確認が必要です。")) return { reason: "作業方針への回答が必要です。", next: "下の回答欄に方針を記入してください。回答だけで合格条件や権限は変更しません。", action: "answer" };
  if (/^残作業の差戻し回数上限です。/.test(error) && taskPartialClosure(task) && !taskPartialClosure(task)!.finishedAt) return {
    reason: "仕上げへの引き継ぎが同じ担当への再試行になっていたため停止しました。未達条件と成果は保持しています。",
    next: "上の「残課題を記録して仕上げへ」で、自己確認を繰り返さずPDF確認と独立レビューへ進みます。全体合格の判定は省略しません。"
  };
  if (/修正サイクルの上限|達成条件の改善が続けて/.test(error)) return {
    reason: "改善の反復を区切りました。未達項目は合格に変更していません。",
    next: "「成果・検証」で残課題を確認し、下の追加指示に次に取り組む内容を記入して「続ける」を押してください。", action: "answer"
  };
  if (/前の担当の停止を確認できない|実行ロック|旧CLI/.test(error)) return { reason: "前のCLIの終了を確認できず、安全のため次の担当を待機させています。", next: "「実行」で対象端末の「CLIを復旧…」を使い、旧CLIの停止を確認してから再開してください。", action: "execution" };
  if (/UNAUTHENTICATED|invalid authentication|認証.*(?:拒否|期限切れ)|\b401\b/.test(error)) return { reason: "担当CLIの認証に失敗しました。保存済みの成果は保持しています。", next: task.resumeFromUnitId
    ? "「サービス」で対象CLIのログインを確認し、上の再開ボタンで同じ工程を再試行してください。"
    : "「サービス」で対象CLIのログインを確認し、下の追加指示で復旧したことを伝えて続けてください。", action: "services" };
  return { reason: "", next: task.resumeFromUnitId
    ? "成果とログは保持しています。原因を解消したら、上の再開ボタンで中断した工程を続けられます。"
    : "成果とログは保持しています。次の作業方針を下の追加指示へ入力して「続ける」を押してください。", action: task.resumeFromUnitId ? undefined : "answer" };
}
