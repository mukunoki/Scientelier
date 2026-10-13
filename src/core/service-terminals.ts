import { randomUUID } from "node:crypto";
import type { AgentId } from "./types";
import type { OpenCodePlan } from "./opencode";
import type { RemoteConnection } from "./remote-client";
import type { ProcessSpec, TerminalRunner } from "./terminal-runner";

export function serviceTerminalArgs(agent: AgentId, mode: "cli" | "login", plan?: OpenCodePlan): string[] {
  if (mode === "cli" || agent === "antigravity") return [];
  if (agent === "codex") return ["login", "--device-auth"];
  if (agent === "claude") return ["auth", "login"];
  if (agent === "opencode") return ["auth", "login", "--provider", plan === "zai" ? "zai-coding-plan" : "ollama-cloud"];
  throw new Error("未対応のCLIです。");
}

// Authentication terminals are not task runs. Hiding their UI never retires a
// worker or disconnects SSH, and their output is never written to task logs.
export class ServiceTerminals {
  private sessions = new Map<string, { id: string; client: RemoteConnection; agentId: AgentId; configuration?: OpenCodePlan }>();
  constructor(private runner: TerminalRunner, private launch: (id: string, client: RemoteConnection, spec: ProcessSpec) => Promise<unknown>,
    private ended: (environmentId: string, agentId: AgentId) => void) {}
  start(client: RemoteConnection, agentId: AgentId, mode: "cli" | "login", configuration?: OpenCodePlan): string {
    if (!client.connected || !client.resolvedCwd) throw new Error("先にSSH接続と作業環境の確定を行ってください。");
    const executable = client.agents.find(a => a.id === agentId && a.installed)?.executable;
    if (!executable || agentId === "gemini") throw new Error("この環境でCLIが見つかりません。");
    const key = JSON.stringify([client.system.id, agentId]);
    const old = this.sessions.get(key);
    if (old && this.runner.snapshot(old.id)?.alive) {
      if (old.client !== client || old.configuration !== configuration) throw new Error("別の接続・設定の端末が残っています。終了を確認してから開き直してください。");
      return old.id;
    }
    if (old) this.runner.forget(old.id);
    const id = `service:${randomUUID()}`;
    // Ollama daemon authentication belongs to that host, not OpenCode's API-key store.
    const ollamaLogin = agentId === "opencode" && mode === "login" && configuration === "ollama-app";
    const spec = { command: ollamaLogin ? "ollama" : executable,
      args: ollamaLogin ? ["signin"] : serviceTerminalArgs(agentId, mode, configuration), cwd: client.resolvedCwd };
    this.sessions.set(key, { id, client, agentId, configuration });
    try {
      void this.launch(id, client, spec).then(() => this.ended(client.system.id, agentId), () => this.ended(client.system.id, agentId));
    } catch (e) { this.sessions.delete(key); throw e; }
    return id;
  }
  private require(id: string) {
    const entry = [...this.sessions.values()].find(s => s.id === id);
    if (!entry) throw new Error("認証端末がありません。");
    return entry;
  }
  snapshot(id: string) { this.require(id); return this.runner.snapshot(id); }
  input(id: string, data: string) { const s = this.require(id); if (!s.client.connected) throw new Error("SSHが切断されています。"); this.runner.write(id, data); }
  resize(id: string, cols: number, rows: number) { this.require(id); this.runner.resize(id, cols, rows); }
  stop(id: string) { this.require(id); return this.runner.cancel(id); }
  active(environmentId: string, agentId?: AgentId) {
    return [...this.sessions.values()].filter(s => s.client.system.id === environmentId && (!agentId || s.agentId === agentId) && this.runner.snapshot(s.id)?.alive);
  }
}
