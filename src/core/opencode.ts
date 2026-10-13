import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPolicy } from "./types";
import type { ClaudeLoginStatus } from "./claude-login";

export const ZAI_PROVIDER = "zai-coding-plan";
export const ZAI_CODING_URL = "https://api.z.ai/api/coding/paas/v4";
export type OpenCodePlan = "zai" | "ollama" | "ollama-app";
export const DEEPSEEK_OLLAMA_MODEL = "ollama/deepseek-v4.1-flash:cloud";
export const OPEN_CODE_PLANS = {
  zai: { provider: ZAI_PROVIDER, label: "Z.AI Coding Plan", url: ZAI_CODING_URL, pattern: /^zai-coding-plan\/glm-[a-z0-9][a-z0-9.-]{0,70}$/ },
  ollama: { provider: "ollama-cloud", label: "Ollama Cloud", url: "https://ollama.com/v1", pattern: /^ollama-cloud\/[a-z0-9][a-z0-9._:-]{0,127}$/ },
  "ollama-app": { provider: "ollama", label: "Ollama Cloud（Ollama経由）", url: "http://127.0.0.1:11434/v1", pattern: /^ollama\/[a-z0-9][a-z0-9._:-]{0,127}(?::cloud|-cloud)$/ }
} as const;

export function validateOpenCodePlan(value: unknown): OpenCodePlan {
  if (value !== "zai" && value !== "ollama" && value !== "ollama-app") throw new Error("OpenCodeの接続先が不正です。");
  return value;
}

export function validateOpenCodeModel(plan: OpenCodePlan, value: unknown): string {
  const profile = OPEN_CODE_PLANS[validateOpenCodePlan(plan)];
  if (typeof value !== "string" || !profile.pattern.test(value.trim())) throw new Error(`${profile.label}のモデルを指定してください（${profile.provider}/…）。別の接続先へ自動切替はしません。`);
  return value.trim();
}

export function openCodePolicy(current: AgentPolicy, plan: OpenCodePlan, model: unknown): AgentPolicy {
  const profile = OPEN_CODE_PLANS[validateOpenCodePlan(plan)];
  const selected = validateOpenCodeModel(plan, model);
  const models: NonNullable<AgentPolicy["openCodeModels"]> = {};
  for (const key of ["zai", "ollama", "ollama-app"] as const) {
    const saved = current.openCodeModels?.[key];
    if (saved !== undefined) models[key] = validateOpenCodeModel(key, saved);
  }
  if (current.codingPlan && current.defaultModel) models[current.codingPlan] = validateOpenCodeModel(current.codingPlan, current.defaultModel);
  models[plan] = selected;
  // The local proxy and direct API consume the same cloud account, not extra quota.
  // 接続先・モデルの適用とサービスの利用ON/OFFは独立した設定。
  return { ...current, codingPlan: plan, providerKey: plan === "ollama-app" ? "ollama-cloud" : profile.provider,
    providerLabel: profile.label, authMode: "subscription", defaultModel: selected, openCodeModels: models };
}

export function parseOpenCodeLoginStatus(output: string, plan: OpenCodePlan = "zai"): ClaudeLoginStatus {
  if (plan === "ollama-app") return { checkedAt: new Date().toISOString(), checkSupported: false, detail: "認証はOllama側で管理します。OpenCodeのAPIキー登録とは別です。" };
  const label = OPEN_CODE_PLANS[validateOpenCodePlan(plan)].label;
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const present = plain.split(/\r?\n/).some(line => line.match(/[●•]\s+(.+?)\s+api\s*$/)?.[1] === label);
  const listed = /\b\d+ credentials?\b/.test(plain);
  return { checkedAt: new Date().toISOString(), loggedIn: present ? true : listed ? false : undefined,
    authMethod: present ? "OpenCode保存済みAPIキー" : undefined,
    detail: present ? `${label}の認証情報がOpenCodeに登録されています。契約プラン・有効性・残量は未確認です。`
      : listed ? `${label}の認証情報が未登録です。${plan === "zai" ? "通常のZ.AIとは別に登録してください。" : "Pro契約のOllamaアカウントで発行したAPIキーを登録してください。"}`
      : "OpenCodeの認証状態を確認できません。CLIの版・接続・環境を確認してください。" };
}

export async function readOpenCodeLoginStatus(executable: string, cwd: string, plan: OpenCodePlan = "zai", request: typeof fetch = fetch): Promise<ClaudeLoginStatus> {
  validateOpenCodePlan(plan);
  if (plan === "ollama-app") {
    try {
      const response = await request("http://127.0.0.1:11434/api/version", { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error("Ollama unavailable");
      return { checkedAt: new Date().toISOString(), checkSupported: false, runtimeReady: true, detail: "このMacのOllamaに接続できました。既存のOllamaログインを利用します。クラウド認証の有効性はモデル実行時に確認されます。残量表示のWeb連携は任意で、作業には不要です。" };
    } catch { return { checkedAt: new Date().toISOString(), checkSupported: false, runtimeReady: false, detail: "このMacのOllamaに接続できません。Ollamaアプリを起動してください。残量表示のWebログインでは接続を復旧できません。" }; }
  }
  try {
    const result = await promisify(execFile)(executable, ["auth", "list"], { cwd, timeout: 15000, maxBuffer: 128000 });
    return parseOpenCodeLoginStatus(`${result.stdout}\n${result.stderr}`, plan);
  } catch { return parseOpenCodeLoginStatus("", plan); }
}

export function parseOpenCodeModels(output: string, plan: OpenCodePlan): string[] {
  const pattern = OPEN_CODE_PLANS[validateOpenCodePlan(plan)].pattern;
  return [...new Set(output.split(/\r?\n/).map(line => line.trim()).filter(line => pattern.test(line)))].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}

export async function readOpenCodeModels(executable: string, cwd: string, plan: OpenCodePlan): Promise<string[]> {
  const profile = OPEN_CODE_PLANS[validateOpenCodePlan(plan)];
  if (plan === "ollama-app") return readOllamaAppModels(cwd);
  try {
    const result = await promisify(execFile)(executable, ["models", profile.provider, "--refresh"], { cwd, timeout: 15000, maxBuffer: 128000 });
    return parseOpenCodeModels(result.stdout, plan);
  } catch { return []; }
}

export function ollamaProviderConfig(model: string): Record<string, unknown> {
  validateOpenCodeModel("ollama-app", model);
  const id = model.slice("ollama/".length);
  return { npm: "@ai-sdk/openai-compatible", name: "Ollama", options: { baseURL: OPEN_CODE_PLANS["ollama-app"].url },
    models: { [id]: { name: id, tool_call: true,
      // Conservative generation cap; context/vision for this model are confirmed by /api/show.
      limit: { context: model === DEEPSEEK_OLLAMA_MODEL ? 1048576 : 65536, output: 16384 },
      ...(model === DEEPSEEK_OLLAMA_MODEL ? { reasoning: true, modalities: { input: ["text", "image"], output: ["text"] } } : {})
    } } };
}

/** Process-local configuration shared by task and user-operated terminals.
 * Never replace the user's saved provider credentials or OpenCode settings. */
export function openCodeProviderConfig(plan: OpenCodePlan, model: unknown): Record<string, unknown> {
  const selected = validateOpenCodeModel(plan, model), profile = OPEN_CODE_PLANS[plan];
  return { enabled_providers: [profile.provider], model: selected, small_model: selected,
    provider: { [profile.provider]: plan === "ollama-app" ? ollamaProviderConfig(selected) : { options: { baseURL: profile.url } } } };
}

/** Ordinary interactive CLI: no task prompt, MCP, hooks or auto-approval. */
export function openCodeTerminal(executable: string, cwd: string, plan: OpenCodePlan, model: unknown) {
  return { command: "/usr/bin/env", cwd,
    args: [`OPENCODE_CONFIG_CONTENT=${JSON.stringify({ share: "disabled", autoupdate: false, ...openCodeProviderConfig(plan, model) })}`, executable] };
}

export async function readOllamaAppModels(homeDirectory: string, includeServer = true): Promise<string[]> {
  const read = async (path: string) => {
    try { if ((await stat(path)).size > 1024 * 1024) return {}; return JSON.parse(await readFile(path, "utf8")); }
    catch { return {}; }
  };
  const [launch, state] = await Promise.all([read(join(homeDirectory, ".ollama", "config.json")), read(join(homeDirectory, ".local", "state", "opencode", "model.json"))]);
  const saved = launch?.integrations?.opencode?.models;
  const recent = Array.isArray(state?.recent) ? state.recent.filter((v: any) => v?.providerID === "ollama").map((v: any) => v.modelID) : [];
  let installed: unknown[] = [];
  if (includeServer) {
    try {
      const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (response.ok) { const value = await response.json() as any; if (Array.isArray(value?.models)) installed = value.models.map((v: any) => v?.name); }
    } catch { /* Saved cloud models are useful even when the local service is stopped. */ }
  }
  const names = [...(Array.isArray(saved) ? saved : []), ...recent, ...installed].filter((v): v is string => typeof v === "string" && OPEN_CODE_PLANS["ollama-app"].pattern.test(`ollama/${v}`));
  return parseOpenCodeModels(names.map(name => `ollama/${name}`).join("\n"), "ollama-app");
}
