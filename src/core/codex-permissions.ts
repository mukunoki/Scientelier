import type { TaskRecord } from "./types";

export type CodexPermissions = "sandbox" | "full-access";

// A remote profile must never grant Full access to a local fallback/report run.
// Old local tasks remain sandboxed until the user explicitly changes this field.
export function taskCodexPermissions(task: Pick<TaskRecord, "remote" | "localCodexPermissions">, local = !task.remote): CodexPermissions {
  return (local ? task.localCodexPermissions : task.remote?.codexPermissions) === "full-access" ? "full-access" : "sandbox";
}

export function codexPermissionPatch(task: TaskRecord, value: unknown, confirmed: unknown): Partial<TaskRecord> {
  if (value !== "sandbox" && value !== "full-access") throw new Error("Codexの権限設定が不正です。");
  if (value === "full-access" && confirmed !== true) throw new Error("Full accessのリスク確認が必要です。");
  return task.remote ? { remote: { ...task.remote, codexPermissions: value } } : { localCodexPermissions: value };
}
