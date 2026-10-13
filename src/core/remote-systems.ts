import { mkdir, readFile, writeFile, rename, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { RemoteSystem } from "./types";

export function validateRemoteSystem(input: unknown): RemoteSystem {
  const p = input as RemoteSystem;
  if (!p || typeof p !== "object") throw new Error("接続先の設定が必要です。");
  if (p.codexPermissions !== undefined && !["sandbox", "full-access"].includes(p.codexPermissions)) throw new Error("Codexの権限設定が不正です。");
  for (const key of ["id", "name", "host", "cwd", "nodeCommand", "startup", "instructions", "texCommand"] as const) {
    if (typeof p[key] !== "string" || p[key].includes("\0") || p[key].length > (key === "instructions" ? 32000 : 4096)) throw new Error(`接続先の ${key} が不正です。`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(p.id)) throw new Error("接続先IDは英数字・ハイフン・下線で指定してください。");
  const host = p.host.trim();
  const parts = host.split("@");
  const address = parts.at(-1)!;
  if (!p.name.trim() || parts.length > 2 || (parts.length === 2 && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(parts[0]))
    || !(isIP(address) || /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,253}$/.test(address))) throw new Error("接続先にIPアドレス、サーバ名、またはSSH configのHost名を入力してください。");
  if (p.username !== undefined && (typeof p.username !== "string" || (p.username.trim() && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p.username.trim())))) throw new Error("ログインユーザ名が不正です。");
  if (parts.length === 2 && p.username?.trim()) throw new Error("ユーザ名を別欄に入力する場合、接続先から user@ を取り除いてください。");
  if (p.port !== undefined && (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) throw new Error("SSHポートは1〜65535で指定してください。通常は空欄です。");
  if (p.connectionMode !== undefined && !["direct", "prepared"].includes(p.connectionMode)) throw new Error("接続方式が不正です。");
  if (p.terminalBackend !== undefined && !["auto", "tmux", "direct"].includes(p.terminalBackend)) throw new Error("端末の保持方式が不正です。");
  if (p.pythonCommand !== undefined && (typeof p.pythonCommand !== "string" || !p.pythonCommand.trim() || /[\r\n\0]/.test(p.pythonCommand) || p.pythonCommand.length > 512)) throw new Error("Python 3の実行コマンドが不正です。");
  const cwd = p.cwd.trim() || "agent-harness";
  if (/^\/+$/.test(cwd) || cwd.split("/").some(s => s === ".." || s === ".") || /[\r\n\0]/.test(cwd) || (cwd.startsWith("~") && cwd !== "~" && !cwd.startsWith("~/"))) throw new Error("作業フォルダは projects/test、~/projects/test、または絶対パスで指定してください。.. や ~他のユーザ は使えません。");
  if (![p.nodeCommand, p.texCommand].every(s => s.trim() && !/[\r\n]/.test(s))) throw new Error("Node・TeXの実行ファイル名を指定してください（引数なし）。");
  return { id: p.id, name: p.name.trim(), host, cwd: cwd.replace(/\/+$/, ""), nodeCommand: p.nodeCommand.trim(), startup: p.startup, instructions: p.instructions, texCommand: p.texCommand.trim(),
    ...(p.codexPermissions ? { codexPermissions: p.codexPermissions } : {}),
    ...(p.connectionMode ? { connectionMode: p.connectionMode } : {}), ...(p.terminalBackend ? { terminalBackend: p.terminalBackend } : {}), ...(p.pythonCommand ? { pythonCommand: p.pythonCommand.trim() } : {}),
    ...(p.username?.trim() ? { username: p.username.trim() } : {}), ...(p.port !== undefined ? { port: p.port } : {}) };
}

// Resolve before the IPC risk confirmation as well as inside the serialized save.
// New profiles opt out of Codex's sandbox; omission in legacy profiles must not
// silently grant more permissions when an unrelated field is edited.
export function remoteSystemForSave(system: RemoteSystem, existing?: RemoteSystem): RemoteSystem {
  return { ...system, codexPermissions: system.codexPermissions ?? existing?.codexPermissions ?? (existing ? "sandbox" : "full-access") };
}

// One editable plain-text instruction file per system; no scheduler plug-ins.
export class RemoteSystemStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  async list(): Promise<RemoteSystem[]> {
    let items: RemoteSystem[];
    try {
      items = JSON.parse(await readFile(join(this.directory, "systems.json"), "utf8")) as RemoteSystem[];
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    if (!Array.isArray(items) || items.length > 100) throw new Error("接続先一覧が不正です。");
    return Promise.all(items.map(async item => {
        const p = validateRemoteSystem(item);
        const file = join(this.directory, `${p.id}.txt`);
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128000) throw new Error("利用手順には通常のテキストファイルを使用してください。");
        return validateRemoteSystem({ ...p, instructions: await readFile(file, "utf8") });
    }));
  }
  save(input: unknown): Promise<RemoteSystem[]> {
    const validated = validateRemoteSystem(input);
    const work = this.tail.then(async () => {
      const items = await this.list();
      const p = remoteSystemForSave(validated, items.find(item => item.id === validated.id));
      const next = [...items.filter(item => item.id !== p.id), p];
      await mkdir(this.directory, { recursive: true });
      const tmp = join(this.directory, `${randomUUID()}.tmp`);
      await writeFile(tmp, p.instructions, { mode: 0o600, flag: "wx" });
      await rename(tmp, join(this.directory, `${p.id}.txt`));
      const manifest = join(this.directory, `${randomUUID()}.tmp`);
      await writeFile(manifest, JSON.stringify(next.map(item => ({ ...item, instructions: "" })), null, 2), { mode: 0o600, flag: "wx" });
      await rename(manifest, join(this.directory, "systems.json"));
      return this.list();
    });
    this.tail = work.catch(() => {}); return work;
  }
}
