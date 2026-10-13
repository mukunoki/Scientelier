import { buildWorkUnitPrompt } from "./orchestration";
import { localReportUnit } from "./local-report";
import { researchInstructions } from "./research-cycle";
import { qualityInstructions } from "./quality";
import { qualitySpecs } from "./quality-profiles";
import { currentReviewAdjustment } from "./review-timing";
import type { FinishingSkillSnapshot, ReportSettings, TaskRecord } from "./types";

/** A read-only compilation of saved instructions, not a new plan or a run. */
export function instructionDocument(task: TaskRecord, reports: ReportSettings, writing: FinishingSkillSnapshot, at = new Date().toISOString()): string {
  const sections: string[] = [];
  const section = (name: string, body: string) => sections.push(`===== ${name} =====\n${body}`);
  const list = (values: string[]) => values.length ? values.map((v, i) => `${i + 1}. ${v}`).join("\n") : "指定なし";
  section("指示書の保存状態", `タスク：${task.title}\nタスクID：${task.id}\n表示取得日時：${at}\nタスク更新日時：${task.updatedAt}\nラウンド：${task.roundNumber ?? 1}\n状態：${task.state}\nゴール：${task.goal?.status === "approved" ? `承認済み・第${task.goal.revision}版` : "未承認（下書き）"}\n\n保存済みのゴール・ルール・計画・工程指示を全文掲載しています。画面上の未保存の編集は含みません。担当別の指示本文は、この取得時点の保存状態から組み立てたものです。過去のCLIへ送信した内容の完全な複製ではありません。CLI自身のシステムプロンプト、認証情報、一時的な通信・完了通知用の制御情報は対象外です。`);
  section("元の依頼", task.prompt);
  section("現在の追加指示", task.instruction ?? "追加指示なし");
  if (task.researchCycle) section("証拠付き研究サイクル（起動時の追加ルール）", researchInstructions);
  if(task.qualityCycle)section("共通品質管理とモード別の検査",`${qualityInstructions}\n\n${JSON.stringify([...qualitySpecs(task,"work"),...qualitySpecs(task,"report")],null,2)}`);
  if (task.scopeTransition) section("作業範囲の変更", `${task.scopeTransition.fromPreset?.manifest.name ?? "指定なし"} → ${task.workPreset?.manifest.name ?? "指定なし"}\n追加指示：${task.scopeTransition.instruction}\n変更要求日時：${task.scopeTransition.requestedAt}\n解除した制約：\n${list(task.scopeTransition.removedConstraints ?? [])}\n解除した対象外：\n${list(task.scopeTransition.removedOutOfScope ?? [])}\n${task.goalRevisionPending ? "新しいゴールは未承認。実装・実験はまだ開始しません。" : "現在の承認済みゴールに従います。OS権限・接続先・予算は変更しません。"}`);
  if (task.history?.length) section("これまでに実行した追加指示", task.history.map(h => `ラウンド${h.number}（${h.kind}）\n${h.instruction}`).join("\n\n"));
  if (task.restart) section("やり直し時の方針", `方法：${task.restart.mode === "fresh" ? "同じゴールで最初から" : "成果物と経緯を引き継ぐ"}\n${task.restart.handoff ?? ""}`);
  if (task.goal) {
    const g = task.goal;
    section(`ゴール・${g.status === "approved" ? "承認済み" : "未承認の下書き"}`, `目的\n${g.objective}\n\n成果物\n${list(g.deliverables)}\n\n達成条件\n${g.criteria.map(c => `[${c.required ? "必須" : "追加改善"}] ${c.description}\n条件ID：${c.id}\n検証方法：${c.verification}`).join("\n\n")}\n\n制約・変更禁止事項\n${list(g.constraints)}\n\n対象外\n${list(g.outOfScope)}\n\n未解決の確認事項\n${list(g.questions)}`);
  }
  if (task.workPreset) {
    section(`作業プリセット：${task.workPreset.manifest.name}（タスク保存版 ${task.workPreset.revision}）`, task.workPreset.rules);
    section("全モード共通の作業原則（タスク保存版）", task.workPreset.commonRules);
    for (const [i,p] of (task.workPreset.stages ?? []).entries()) section(`研究工程 ${i+1}：${p.manifest.name}（保存版 ${p.revision}）`, `${p.rules}\n\nゴールの初期候補\n${JSON.stringify(p.manifest.goal,null,2)}`);
  }
  section("実行方針・割り当て", `方式：${task.workflowMode ?? "staged"}\n戦略：${task.strategy}\n利用CLI：${task.allowedAgentIds.join(" / ")}\nモデル指定：${Object.entries(task.modelOverrides).map(([k, v]) => `${k}: ${v}`).join(" / ") || "CLIの既定モデル"}\n役割別指定：${Object.entries(task.assignments ?? {}).map(([k, v]) => `${k}: ${v?.agentId ?? "自動"} ${v?.model ?? ""}`).join(" / ") || "自動割り当て"}\n自律反復：${task.autonomy?.enabled ? "有効" : "無効"}\n最大修正サイクル：${task.autonomy?.maxCycles ?? "未指定"}\n作業目安時間：${task.autonomy?.targetMinutes ?? "未指定"} 分（強制終了なし）\n最大同時実行数：${task.execution?.maxParallel ?? "既定"}\n最大分担数：${task.execution?.maxSubtasks ?? "既定"}\nトークン予算目安：${task.execution?.tokenBudget ?? "未指定"}\n会話切替の文脈量目安：${task.execution?.contextTokens ?? "未指定（文脈量による会話切替なし）"}\n会話引き継ぎ：${task.execution?.reuseContext ?? "既定"}\n分担：${task.execution?.decompose ?? "既定"}\nレビュー方式：${task.execution?.reviewMode === "parallel" ? "並列独立レビュー → 1担当の統括・根拠確認" : task.execution?.reviewMode === "cross-service" ? "全サービスの独立レビュー・クロス検証" : "異なるCLIで2回連続レビュー"}\n計画後の承認待ち：${task.pauseAfterPlan ? "有効" : "無効"}`);
  const plan = [...(task.executionPlans ?? [])].reverse().find(p => p.round === (task.roundNumber ?? 1) && p.goalRevision === task.goal?.revision);
  if (plan?.coordination) section("分担・作業効率の戦略", `完了までの依存関係：${plan.coordination.criticalPath}\n並列化の効果：${plan.coordination.parallelBenefit}\n文脈・引き継ぎ：${plan.coordination.contextPlan}\nサービス・予算配分：${plan.coordination.resourcePlan}`);
  if (plan) section(`現在の実行計画・第${plan.revision}版${task.awaitingReason === "plan" ? "（ユーザー確認待ち・未実行）" : "（保存済み）"}`, `方針：${plan.summary}\n理由：${plan.reason}\n主担当の作業：${plan.primaryWork}\n完了条件：${plan.acceptance}\n対象条件：${plan.criterionIds.join(" / ")}\n主担当の見積り：${plan.estimatedTokens} tokens / ${plan.estimatedMinutes} 分\nユーザー確認が必要な条件：${plan.escalation}\n\n${plan.tasks.map(t => `分担：${t.title}\n実行方式：${t.kind === "primary-work" ? "主担当の実作業・単独実行" : "読み取り専用の調査・検証"}\n${t.instructions}\n成果物：${t.deliverable}\n検証：${t.acceptance}\n対象条件：${t.criterionIds.join(" / ")}\n前提：${t.dependsOn.join(" / ") || "なし"}\n見積り：${t.estimatedTokens} tokens`).join("\n\n")}`);
  section("実行環境・TeX・作図設定（取得時点）", `作業フォルダ：${task.remote ? task.remote.resolvedCwd ?? task.remote.cwd : task.cwd}\nレポート生成：${task.remote ? "タスクの遠隔作業環境（Macはプレビュー用）" : "このMac"}\nTeXコマンド：${task.remote?.texCommand ?? reports.texCommand}\nTeX引数：${reports.texArgs.join(" ")}\n作図コマンド：${reports.plotCommand}\n作図確認引数：${reports.plotCheckArgs.join(" ")}\nローカル保存先：${reports.outputDirectory}\nレポート原稿：${task.report?.texPath ?? "未作成"}\nPDF：${task.report?.pdfPath ?? "未作成"}`);
  if (task.remote) section("遠隔システムの登録済み利用手順", `${task.remote.name}\n接続先：${task.remote.host}\n接続方式：${task.remote.connectionMode ?? "direct"}\n作業先：${task.remote.preparedTarget?.cwd ?? task.remote.cwd}\nNodeコマンド：${task.remote.nodeCommand}\nTeXコマンド：${task.remote.texCommand}\n起動時設定：${task.remote.startup}\nCodex操作権限：${task.remote.codexPermissions ?? "sandbox"}\n\n${task.remote.instructions}`);
  const versions = new Map<string, { snapshot: FinishingSkillSnapshot; units: string[] }>();
  for (const unit of task.workUnits) {
    const run = [...task.runs].reverse().find(r => r.workUnitId === unit.id && r.finishingSkill);
    if (run?.finishingSkill) {
      const value = versions.get(run.finishingSkill.revision) ?? { snapshot: run.finishingSkill, units: [] };
      value.units.push(unit.title); versions.set(run.finishingSkill.revision, value);
    }
  }
  for (const [revision, value] of versions) section(`レポート執筆ルール・工程保存版 ${revision}`, `適用工程：${value.units.join(" / ")}\n取得日時：${value.snapshot.capturedAt}\n\n${value.snapshot.rules}`);
  section(`レポート執筆ルール・現在の設定版 ${writing.revision}`, `次に起動する執筆工程へ適用する設定です。既存の実行に保存された版とは異なる場合があります。\n\n${writing.rules}`);
  for (const [i, unit] of task.workUnits.entries()) {
    // Remote supporting files are not copied into the local report workspace.
    const promptTask = localReportUnit(task,unit,reports) && task.managedSkills
      ? {...task,managedSkills:task.managedSkills.filter(s=>!s.id.startsWith("project-"))} : task;
    section(`工程 ${String(i + 1).padStart(2, "0")}：${unit.title}`, `工程ID：${unit.id}\n役割：${unit.role}\n状態：${unit.state}\n担当：${unit.assignedAgentId ?? "起動時に割り当て"}\n操作範囲：${unit.mode}\n依存工程：${unit.dependsOn.join(" / ") || "なし"}\n\n保存済みの工程指示（全文）\n${unit.instructions}\n\n担当別の指示本文（取得時点の構成）\n${buildWorkUnitPrompt(promptTask, unit)}${unit.reviewFormatFeedback ? `\n\nレビュー形式の再提出指示\n${unit.reviewFormatFeedback}` : ""}`);
  }
  if (task.pendingFollowup) section("未実行の追加指示（確定済みの実行指示とは別）", `${task.pendingFollowup.instruction}${task.pendingFollowup.implementation ? "\n実装・実験への移行を要求（未適用。開始時にゴールを見直し、別途承認）。" : ""}${task.pendingFollowup.scopeChange ? `\n作業範囲の変更案（未適用）：\n解除する制約：${list(task.pendingFollowup.scopeChange.removeConstraints)}\n解除する対象外：${list(task.pendingFollowup.scopeChange.removeOutOfScope)}\n実装・実験：${task.pendingFollowup.scopeChange.implementation ? "含める" : "追加指示と既存モードの範囲"}` : ""}`);
  section("並列割り当て・クロスレビュー", `割り当て：${task.execution?.scheduling === "throughput" ? "効率重視・複数サービスを混合（同一サービスの複数起動も可）" : "通常の負荷・文脈バランス"}\nレビュー：${task.execution?.reviewMode === "parallel" ? "別サービスで並列独立判定 → 全判定を1担当が統合・根拠確認。少数の未解決事項も保持して主担当へ戻す。" : task.execution?.reviewMode === "cross-service" ? "利用可能な全サービスで独立判定 → 他サービスの判定を新規会話でクロス検証。全員の判定と証拠を検証し、未解決事項は差し戻す。" : "異なるCLIによる2回連続レビュー"}\nプランナーが必要な分担と依存関係を決める。並列数を埋めるための無意味な作業は作らない。`);
  section("時間目安に応じたレビューの調整", currentReviewAdjustment(task)?.reason ?? "上記は通常のレビュー方式です。作業目安時間がある場合、最終レビュー開始前に残り時間を見積もり、独立レビュー2回または1回へ軽量化できます。省略したレビューは未実施として記録し、開始済み工程は打ち切りません。必須条件・証拠・文献照合などの検証水準は変更しません。");
  if (task.orchestratorDecisions?.length) section("統括役の指示補足・追加配分・判断履歴", task.orchestratorDecisions.map(d => `第${d.round}回 / 計画${d.planRevision} / ${d.status}\n${d.reason}\n追加工程：${d.addedUnitIds.join(", ") || "なし"}\n指示補足：${d.refinements?.map(r => `${r.unitId}: ${r.note}`).join("\n") || "なし"}`).join("\n\n"));
  return sections.join("\n\n") + "\n";
}

export function instructionFilename(title: string): string {
  const name = title.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 80) || "task";
  return `${name}-指示書.txt`;
}
