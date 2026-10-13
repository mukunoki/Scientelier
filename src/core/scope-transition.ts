import { randomUUID } from "node:crypto";
import { validateGoalDraft } from "./goals";
import { validateFollowup } from "./iterations";
import type { FollowupInput, TaskRecord, WorkPresetSnapshot } from "./types";

// A scope change is a new goal DRAFT, never an implicit approval or OS privilege change.
export function implementationTransitionPatch(task: TaskRecord, input: FollowupInput, preset: WorkPresetSnapshot): Partial<TaskRecord> {
  const validated = validateFollowup(input, task);
  if (!validated.implementation || preset.manifest.focus !== "implementation") throw new Error("実装用プリセットを選んでください。");
  if (validated.instruction.length > 8000) throw new Error("実装・実験への追加指示は8,000文字以内に整理してください。");
  const old = task.goal!;
  const draft = validateGoalDraft({ ...old, objective: validated.instruction,
    deliverables: [...new Set([...old.deliverables, "追加指示の範囲での実装コード・実験手順・実測結果・技術レポートTeX/PDF"])],
    criteria: [...old.criteria, { id: `implementation_${randomUUID()}`, description: "追加指示で指定された実装・実験を行い、実際の結果と限界を示す。",
      verification: "対象・実行条件・比較基準・成功条件を具体化し、コードと再現手順・実測結果を照合する。未実施や失敗を成功扱いしない。", required: true }]
  });
  const now = new Date().toISOString();
  return {
    workPreset: structuredClone(preset),
    scopeTransition: { fromPreset: structuredClone(task.workPreset!), requestedAt: now, round: (task.roundNumber ?? 1) + 1, instruction: validated.instruction },
    goal: { ...draft, revision: old.revision + 1, status: "draft", updatedAt: now },
    goalHistory: [...(task.goalHistory ?? []), structuredClone(old)], goalRevisionPending: true,
    state: "awaiting-input", awaitingReason: "goal", goalPreparation: false, workUnits: [],
    error: undefined, reviewPolicy: "adversarial-pair"
  };
}

// The confirmation lists exact removals. No natural-language guessing, blanket
// unlocking, or implicit removal of unrelated restrictions (e.g. FP64).
export function approvedScopeChangePatch(task: TaskRecord, input: FollowupInput, implementationPreset?: WorkPresetSnapshot): Partial<TaskRecord> {
  const validated = validateFollowup(input, task), change = validated.scopeChange;
  if (!change) throw new Error("作業範囲の変更内容を確認して承認してください。");
  const old = task.goal!;
  const switchMode = change.implementation && !["implementation", "research"].includes(task.workPreset?.manifest.focus ?? "");
  if (switchMode && implementationPreset?.manifest.focus !== "implementation") throw new Error("実装用の作業ルールを読み込めません。");
  const criteria = structuredClone(old.criteria);
  for (const edit of change.criterionEdits ?? []) {
    const criterion = criteria.find(c => c.id === edit.id)!;
    criterion.description = edit.description.trim(); criterion.verification = edit.verification.trim();
  }
  if (change.implementation && !criteria.some(c => c.id.startsWith("implementation_"))) criteria.push({ id: `implementation_${randomUUID()}`, description: "追加承認した範囲で実装・精度検証・性能実験を実施し、結果と限界を報告する。", verification: "追加指示の対象環境・実験条件・比較基準とコード・再現手順・実測結果を照合する。未実施を成功扱いしない。", required: true });
  const draft = validateGoalDraft({ ...old, objective: change.criterionEdits?.length ? old.objective : validated.instruction, criteria,
    deliverables: [...new Set([...old.deliverables, ...(change.implementation ? ["承認した実装コード・実験手順・実測結果・技術レポートTeX/PDF"] : [])])],
    constraints: old.constraints.filter(c => !change.removeConstraints.includes(c)),
    outOfScope: old.outOfScope.filter(c => !change.removeOutOfScope.includes(c))
  }, true);
  const now = new Date().toISOString();
  return { ...(switchMode ? { workPreset: structuredClone(implementationPreset) } : {}),
    goal: { ...draft, revision: old.revision + 1, status: "approved", approvedAt: now, updatedAt: now },
    goalHistory: [...(task.goalHistory ?? []), structuredClone(old)], goalRevisionPending: undefined,
    scopeTransition: { fromPreset: structuredClone(task.workPreset), requestedAt: now, round: (task.roundNumber ?? 1) + 1,
      instruction: validated.instruction, removedConstraints: [...change.removeConstraints], removedOutOfScope: [...change.removeOutOfScope] },
    reviewPolicy: "adversarial-pair"
  };
}
