import type { QueueStatus } from "./types";

export interface QueuedTask {
  id: string;
}

/** キューからの起動待ちと直接実行中のタスクを、すべての通知経路で同じ形にする。 */
export function combinedQueueStatus(status: QueueStatus, executing: Iterable<string>): QueueStatus {
  const ids = [...new Set([...(status.activeTaskIds ?? []), ...executing])];
  return { ...status, activeTaskIds: ids, activeTaskId: ids[0] };
}

/** タスク単位の入場制御。タスク内部の並列エージェント数とは別の上限。 */
export class TaskQueue {
  private status: QueueStatus = { running: false, stopping: false };

  constructor(
    private readonly nextTask: (excluded: ReadonlySet<string>) => QueuedTask | undefined,
    private readonly execute: (taskId: string) => Promise<void>,
    private readonly onChange: (status: QueueStatus) => void,
    private readonly concurrency = 1
  ) {}

  getStatus(): QueueStatus {
    return structuredClone(this.status);
  }

  start(): QueueStatus {
    if (this.status.running) return this.getStatus();
    this.status = { running: true, stopping: false };
    this.notify();
    void this.drain();
    return this.getStatus();
  }

  stopAfterCurrent(): QueueStatus {
    if (this.status.running) {
      this.status.stopping = true;
      this.notify();
    }
    return this.getStatus();
  }

  private async drain(): Promise<void> {
    // 失敗しても同じ開始操作の中では再投入しない。再試行はユーザーの再開操作から。
    const attempted = new Set<string>();
    const active = new Map<string, Promise<string>>();
    try {
      while (true) {
        while (!this.status.stopping && active.size < Math.max(1, this.concurrency)) {
          const task = this.nextTask(attempted);
          if (!task || attempted.has(task.id)) break;
          attempted.add(task.id);
          // 失敗理由の記録はexecute側の責務。他タスクの空き枠補充は継続する。
          active.set(task.id, Promise.resolve().then(() => this.execute(task.id)).catch(() => {}).then(() => task.id));
          this.publishActiveTasks(active);
        }
        if (!active.size) break;
        const id = await Promise.race(active.values());
        active.delete(id);
        this.publishActiveTasks(active);
      }
    } finally {
      this.status = { running: false, stopping: false };
      this.notify();
    }
  }

  private notify(): void {
    this.onChange(this.getStatus());
  }

  private publishActiveTasks(active: ReadonlyMap<string, Promise<string>>): void {
    this.status.activeTaskIds = [...active.keys()];
    // 単一タスク時代の読み取り側との互換フィールド。実行制御には配列を使う。
    this.status.activeTaskId = this.status.activeTaskIds[0];
    this.notify();
  }
}
