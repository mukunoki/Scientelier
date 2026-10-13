import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { WritingRulesStore, WRITING_RULE_SECTIONS, type WritingRuleSection } from "./finishing-skill";

interface RuleUpdate { section: WritingRuleSection; before: string; after: string }

/** Explicit, reviewed configuration update, never an automatic reset at startup.
 * Both old and proposed revisions must match the inspected plan. Back up every
 * source before the first save; pinned task/run snapshots are not touched. */
export async function applyWritingRulesUpdate(builtinDirectory: string, userDirectory: string, plan: RuleUpdate[]) {
  if (!Array.isArray(plan) || !plan.length || plan.length > WRITING_RULE_SECTIONS.length
    || new Set(plan.map(p => p.section)).size !== plan.length
    || plan.some(p => !WRITING_RULE_SECTIONS.includes(p.section) || !/^[a-f0-9]{64}$/.test(p.before) || !/^[a-f0-9]{64}$/.test(p.after))) {
    throw new Error("執筆ルールの更新計画が不正です。");
  }
  const root = await lstat(userDirectory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("執筆ルールの保存先は通常のディレクトリである必要があります。");
  // A separately customized supplement needs semantic review, not silent removal.
  for (const legacy of ["academic", "expression"]) {
    try { await lstat(join(userDirectory, `report-writing-${legacy}`, "SKILL.md")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw new Error(`旧${legacy}のカスタム指示があります。内容を統合してから更新してください。`);
  }
  const current = new WritingRulesStore(builtinDirectory, userDirectory);
  const items = await Promise.all(plan.map(async entry => {
    const old = await current.get(entry.section);
    // Hash the actual proposed text, not the aggregate snapshot.
    const proposedRevision = createHash("sha256").update(old.defaultRules).digest("hex");
    if (old.current.revision !== entry.before || proposedRevision !== entry.after) throw new Error("執筆ルールが確認後に変更されています。上書きせず、再確認してください。");
    return { ...entry, old: old.current, rules: old.defaultRules };
  }));
  const backupDirectory = await mkdtemp(join(userDirectory, "before-consolidation-"));
  await writeFile(join(backupDirectory, "rules.json"), JSON.stringify({ capturedAt: new Date().toISOString(), items }, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  for (const item of items) {
    await writeFile(join(backupDirectory, `${item.section}.SKILL.md`), item.old.rules, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  // save rechecks the old revision. On partial failure, all originals remain in
  // the backup; do not roll back over a concurrent user's subsequent edits.
  const saved: WritingRuleSection[] = [];
  try {
    for (const item of items) {
      await current.save(item.before, item.rules, item.section);
      saved.push(item.section);
    }
  } catch (error) {
    throw new Error(`執筆ルール更新を停止しました。保存済み: ${saved.join(", ") || "なし"}。元の内容: ${backupDirectory}。${String(error)}`);
  }
  return { saved, backupDirectory };
}
