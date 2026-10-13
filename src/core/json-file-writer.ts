import { rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** One owner per store; snapshots are committed in request order. */
export class JsonFileWriter {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  write(value: unknown): Promise<void> {
    const content = JSON.stringify(value, null, 2) + "\n";
    const write = this.tail.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
    this.tail = write.catch(() => {}); // One failed save must not poison later saves.
    return write;
  }
}
