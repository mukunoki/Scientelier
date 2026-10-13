import type { TaskState } from "./types";

// A state label is not a process lock: callers must ALSO check activeTaskIds,
// live terminals or pending edits when deciding whether mutation is safe.
const ACTIVE_STATES: readonly TaskState[] = ["planning", "running", "reviewing", "reporting"];

export function isActiveTaskState(state: TaskState): boolean {
  return ACTIVE_STATES.includes(state);
}
