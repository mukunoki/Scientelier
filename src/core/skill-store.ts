// Also shipped to an already-connected SSH workspace. Node built-ins only.
import { lstat, readdir, readFile, writeFile, mkdir, rename, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type SkillStatus = "experimental" | "validated" | "retired";
export interface ManagedSkill {
  id: string; description: string; content: string; revision: string;
  status: SkillStatus; evidence: string; updatedAt: string; path: string; builtin: boolean;
}
export interface SkillEdit { id: string; revision: string; content: string; status: SkillStatus; evidence: string; }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function skillId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 48 || ["script-reuse","document-checks","related-research","writing-rules"].includes(id)) throw new Error("IDは48文字以内の小文字英数字・ハイフンです。予約IDは使えません。");
}
export function skillDescription(id: string, content: unknown): string {
  if (typeof content !== "string" || content.length > 12000 || content.includes("\0")) throw new Error("スキル本文は12,000文字以内です。");
  const header = content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]+)$/);
  if (!header || !header[2].trim()) throw new Error("SKILL.mdのname・descriptionと本文が必要です。");
  const name = header[1].match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim();
  const description = header[1].match(/^description:\s*([^\r\n]+)$/m)?.[1]?.trim();
  if (name !== id || !description || description.length > 1024 || /[<>]/.test(description)) throw new Error("nameはIDと一致させ、descriptionに適用条件を1行で記入してください。");
  return description;
}
async function textFile(path: string, limit = 100000): Promise<string | undefined> {
  try { const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink() || s.size > limit) throw new Error("通常ファイルではないか、サイズ上限を超えています。"); return await readFile(path,"utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
}
export class SkillStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string, private builtinRoot?: string) {}
  // root is derived by main from a saved workspace/userData, never renderer input.
  private async directory(parts: string[], create = false): Promise<string> {
    const parent = await realpath(join(this.root,".."));
    let path = parent;
    for (const part of [this.root.slice(this.root.lastIndexOf("/") + 1), ...parts]) {
      path = join(path, part);
      if (create) try { await mkdir(path,{mode:0o700}); } catch(e) { if ((e as NodeJS.ErrnoException).code!=="EEXIST") throw e; }
      try { const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("スキル保存先にリンク・通常ファイルがあります。"); }
      catch(e) { if (create || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return path;
  }
  private async builtin(id: string): Promise<string | undefined> { return this.builtinRoot ? textFile(join(this.builtinRoot,id,"SKILL.md")) : undefined; }
  async get(id: string): Promise<ManagedSkill | undefined> {
    skillId(id); const dir = await this.directory([id]);
    const base = await this.builtin(id);
    const local = await textFile(join(dir,"SKILL.md"));
    const content = local ?? base; if (content === undefined) return;
    const description = skillDescription(id, content);
    const raw = await textFile(join(dir,"harness-state.json"));
    let meta: any; try { meta = raw ? JSON.parse(raw) : undefined; } catch { throw new Error("スキル状態ファイルが不正です。"); }
    const valid = meta?.contentHash === hash(content) && ["experimental","validated","retired"].includes(meta.status);
    const status = valid ? meta.status : local === undefined && base !== undefined ? "validated" : "experimental";
    return { id, content, description, status, evidence: valid && typeof meta.evidence === "string" ? meta.evidence : "",
      updatedAt: valid && typeof meta.updatedAt === "string" ? meta.updatedAt : "", revision: hash(content + "\0" + (raw ?? "")),
      path: local === undefined && base !== undefined ? join(this.builtinRoot!,id,"SKILL.md") : join(dir,"SKILL.md"), builtin: base !== undefined };
  }
  async list(): Promise<{ skills: ManagedSkill[]; errors: string[] }> {
    await this.directory([]);
    const dirs = async (root: string) => readdir(root,{withFileTypes:true}).catch(e=>{if(e.code==="ENOENT") return []; throw e;});
    const entries = [...await dirs(this.root), ...this.builtinRoot ? await dirs(this.builtinRoot) : []];
    const ids = [...new Set(entries.filter(e=>e.isDirectory() || e.isSymbolicLink()).map(e=>e.name))];
    if (ids.length > 200) throw new Error("スキルは1保存先あたり200件までです。");
    const skills: ManagedSkill[] = [], errors: string[] = [];
    for (const id of ids.sort()) try { const s = await this.get(id); if(s) skills.push(s); } catch(e) { errors.push(`${id}: ${String(e)}`); }
    return {skills,errors};
  }
  save(input: SkillEdit): Promise<ManagedSkill> {
    const next = this.tail.catch(()=>{}).then(async()=>{
      if (!input || typeof input !== "object") throw new Error("スキル設定が不正です。");
      skillId(input.id); skillDescription(input.id,input.content);
      if (!["experimental","validated","retired"].includes(input.status) || typeof input.evidence !== "string" || input.evidence.length>8000) throw new Error("状態・検証証拠が不正です。");
      const old = await this.get(input.id);
      if ((old?.revision ?? "") !== input.revision) throw new Error("別の変更があります。入力を保持し、再読み込みして確認してください。");
      const changed = !old || old.content !== input.content;
      const status = input.status === "retired" ? "retired" : changed ? "experimental" : input.status;
      if (status === "validated" && !input.evidence.trim() && !(old?.builtin && old.status === "validated")) throw new Error("採用済みにするには検証証拠・試験結果を記入してください。");
      if (status === "validated" && !old?.builtin && (await this.list()).skills.filter(s=>!s.builtin && s.status==="validated" && s.id!==input.id).length>=6) throw new Error("追加スキルの採用は保存先ごとに6件までです。不要なものを試験中・廃止へ変更してください。");
      const dir = await this.directory([input.id],true);
      const versions = await this.directory([input.id,".harness-versions"],true);
      if (old) {
        const history = join(versions,`${old.revision}.json`);
        if (await textFile(history) === undefined) await writeFile(history,JSON.stringify(old),{flag:"wx",mode:0o600});
      }
      // Changed bytes cannot inherit a validated stamp. If interrupted between
      // the two writes, the old hash mismatches and get() returns experimental.
      const atomic = async(name:string, value:string) => {
        const tmp = join(dir,`${randomUUID()}.tmp`);
        try { await writeFile(tmp,value,{flag:"wx",mode:0o600}); await rename(tmp,join(dir,name)); }
        finally { await rm(tmp,{force:true}); }
      };
      await atomic("SKILL.md",input.content);
      await atomic("harness-state.json",JSON.stringify({contentHash:hash(input.content),status,evidence:input.evidence,updatedAt:new Date().toISOString()}));
      return (await this.get(input.id))!;
    }); this.tail = next; return next;
  }
  async history(id: string): Promise<ManagedSkill[]> {
    skillId(id); const dir = await this.directory([id,".harness-versions"]);
    const entries = await readdir(dir).catch(e=>{if(e.code==="ENOENT")return []; throw e;});
    const history: ManagedSkill[] = [];
    for(const file of entries.filter(s=>/^[a-f0-9]{64}\.json$/.test(s)).sort().slice(-200)) {
      const value = JSON.parse((await textFile(join(dir,file)))!);
      if(value.id===id && typeof value.revision==="string" && typeof value.content==="string") history.push(value);
    }
    return history.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
}

const remoteStores = new Map<string, SkillStore>();
export async function skillStoreOperation(root: string, action: string, value?: any): Promise<unknown> {
  let store = remoteStores.get(root); if (!store) { store = new SkillStore(root); remoteStores.set(root,store); }
  if (action === "list") return store.list();
  if (action === "get") return store.get(value);
  if (action === "history") return store.history(value);
  if (action === "save") return store.save(value);
  throw new Error("Unknown skill operation");
}
