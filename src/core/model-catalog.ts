import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { stripVTControlCharacters } from "node:util";
import { ACTIVE_AGENT_IDS, type AgentId, type OrchestrationSettings } from "./types";

export interface ModelChoice { id: string; label: string; }
export interface ModelCatalog { models: ModelChoice[]; source: "cli" | "aliases"; note: string; }

// Stable aliases, not a claim about account entitlements or fixed model versions.
export const CLAUDE_MODEL_ALIASES: ModelChoice[] = [
  { id: "best", label: "Best · 利用可能な最上位" },
  { id: "fable", label: "Fable" }, { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" },
  { id: "opusplan", label: "Opusで計画 → Sonnetで実行" }
];

export function parseAntigravityModels(text: string): ModelChoice[] {
  const choices = new Map<string, ModelChoice>();
  for (const line of stripVTControlCharacters(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z0-9]+(?:[._-][a-z0-9]+)+)\s{1,}(.+?)\s*$/);
    if (match) choices.set(match[1], { id: match[1], label: match[2] });
  }
  return [...choices.values()];
}

export async function readAntigravityModels(executable: string, cwd: string): Promise<ModelChoice[]> {
  try {
    const { stdout } = await promisify(execFile)(executable, ["models"], { cwd, timeout: 30000, maxBuffer: 256000 });
    const result = parseAntigravityModels(stdout);
    if (result.length) return result;
  } catch { /* Do not display raw stderr: authentication URLs may be present. */ }
  throw new Error("Antigravityのモデル一覧を取得できません。ログイン・接続を確認してください。現在の選択は保持します。");
}

// Independent of the usage endpoint: API-key accounts can list models too.
export function readCodexModels(executable: string, cwd: string, timeoutMs = 25000,
  launch = (command: string, args: string[], directory: string) => spawn(command, args, { cwd: directory, env: process.env, stdio: ["pipe", "pipe", "pipe"] })) : Promise<ModelChoice[]> {
  return new Promise((resolve, reject) => {
    const child = launch(executable, ["app-server", "--stdio"], cwd);
    let settled = false, buffer = "", requestId = 2, initialized = false;
    const models = new Map<string, ModelChoice>(), cursors = new Set<string>();
    const fail = () => new Error("Codexのモデル一覧を取得できません。ログイン・接続を確認してください。現在の選択は保持します。");
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill("SIGTERM");
      if (error) reject(error); else resolve([...models.values()]);
    };
    const timer = setTimeout(() => finish(fail()), timeoutMs);
    const send = (value: unknown) => { if (!settled) child.stdin.write(`${JSON.stringify(value)}\n`); };
    const list = (cursor?: string) => send({ id: requestId, method: "model/list", params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    child.stdin.on("error", () => finish(fail()));
    child.stderr.on("data", () => {});
    child.on("error", () => finish(fail()));
    child.on("close", () => { if (!settled) finish(fail()); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1024 * 1024) { finish(fail()); return; }
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (settled) return;
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.id === 1 && !initialized) {
          if (message.error) { finish(fail()); return; }
          initialized = true; send({ method: "initialized", params: {} }); list();
        } else if (initialized && message?.id === requestId) {
          if (message.error || !Array.isArray(message.result?.data)) { finish(fail()); return; }
          for (const model of message.result.data) {
            if (model?.hidden === true || typeof model?.model !== "string" || !model.model) continue;
            models.set(model.model, { id: model.model, label: typeof model.displayName === "string" ? model.displayName : model.model });
          }
          const cursor = message.result.nextCursor;
          if (typeof cursor === "string" && cursor) {
            if (cursors.has(cursor) || cursors.size >= 20) { finish(fail()); return; }
            cursors.add(cursor); requestId++; list(cursor);
          } else finish(models.size ? undefined : fail());
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-harness-models", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } } });
  });
}

export function withModelDefaults(settings: OrchestrationSettings, value: unknown, enabled: unknown = {}): OrchestrationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("モデル設定が不正です。");
  const entries = Object.entries(value);
  for (const [id, model] of entries) {
    if (!(ACTIVE_AGENT_IDS as readonly string[]).includes(id) || typeof model !== "string" || model.length > 250 || /[\r\n\x00-\x1f]/.test(model)) throw new Error("モデル設定が不正です。");
  }
  const updates = new Map(entries as [AgentId, string][]);
  if (!enabled || typeof enabled !== "object" || Array.isArray(enabled)) throw new Error("サービスの利用設定が不正です。");
  for (const [id, value] of Object.entries(enabled)) {
    if (!(ACTIVE_AGENT_IDS as readonly string[]).includes(id) || typeof value !== "boolean") throw new Error("サービスの利用設定が不正です。");
  }
  const switches = new Map(Object.entries(enabled) as [AgentId, boolean][]);
  return { ...settings, agentPolicies: settings.agentPolicies.map(p => ({ ...p,
    ...(updates.has(p.agentId) ? { defaultModel: updates.get(p.agentId)!.trim() || undefined } : {}),
    ...(switches.has(p.agentId) ? { enabled: switches.get(p.agentId)! } : {})
  })) };
}
