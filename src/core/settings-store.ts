import { mkdir, readFile } from "node:fs/promises";
import { JsonFileWriter } from "./json-file-writer";
import { dirname } from "node:path";
import type { ExecutionPolicy, OrchestrationSettings, ReportSettings } from "./types";
import { defaultNewExecution, validateExecution } from "./execution-policy";
import { openCodePolicy, validateOpenCodeModel, validateOpenCodePlan } from "./opencode";

interface SettingsFile {
  serviceAccounts?: Record<string, string>;
  version: 3;
  reports: ReportSettings;
  orchestration: OrchestrationSettings;
  execution?: ExecutionPolicy;
}

export class JsonSettingsStore {
  private data: SettingsFile;
  private readonly writer: JsonFileWriter;

  constructor(
    private readonly filePath: string,
    reportDefaults: ReportSettings,
    orchestrationDefaults: OrchestrationSettings
  ) {
    this.writer = new JsonFileWriter(filePath);
    this.data = {
      version: 3,
      reports: { ...structuredClone(reportDefaults), remoteExecution: "remote" },
      orchestration: { ...structuredClone(orchestrationDefaults), agentPolicies: structuredClone(orchestrationDefaults.agentPolicies.filter(p => p.agentId !== "gemini")) }
    };
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SettingsFile> & { version?: number };
      if (parsed.reports) {
        this.data.reports = { ...this.data.reports, ...parsed.reports, remoteExecution: "remote" };
      }
      if (parsed.version !== 3
        && /(?:^|\/)latexmk$/.test(this.data.reports.texCommand)
        && this.data.reports.texArgs.includes("-lualatex")) {
        this.data.reports.texArgs = [
          ...this.data.reports.texArgs.filter((value) => value !== "-lualatex"),
          "-pdfdvi"
        ];
      }
      if (parsed.orchestration) {
        this.data.orchestration = {
          ...this.data.orchestration,
          ...parsed.orchestration,
          agentPolicies: this.mergePolicies(parsed.orchestration.agentPolicies ?? [])
        };
      }
      if (parsed.execution) this.data.execution = validateExecution(parsed.execution);
      if (parsed.serviceAccounts && typeof parsed.serviceAccounts === "object" && !Array.isArray(parsed.serviceAccounts)) {
        this.data.serviceAccounts = Object.fromEntries(Object.entries(parsed.serviceAccounts).filter(([key, value]) =>
          key.length <= 240 && typeof value === "string" && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value)));
      }
      // Report generation follows the task workspace, including saved tasks.
      // Preserve tool commands and every unrelated setting during migration.
      if (parsed.version !== 3 || parsed.reports?.remoteExecution !== "remote") await this.persist();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  getReports(): ReportSettings {
    return structuredClone(this.data.reports);
  }

  getOrchestration(): OrchestrationSettings {
    return structuredClone(this.data.orchestration);
  }

  getExecution(): ExecutionPolicy { return structuredClone(this.data.execution ?? defaultNewExecution); }

  getServiceAccounts(): Record<string, string> { return structuredClone(this.data.serviceAccounts ?? {}); }
  async setServiceAccount(key: string, value: unknown): Promise<void> {
    if (typeof value !== "string" || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("アカウント表示名は80文字以内で指定してください。");
    const next = { ...this.data.serviceAccounts };
    if (value.trim()) next[key] = value.trim(); else delete next[key];
    this.data.serviceAccounts = next;
    await this.persist();
  }

  async updateExecution(value: unknown): Promise<ExecutionPolicy> {
    this.data.execution = validateExecution(value);
    await this.persist();
    return this.getExecution();
  }

  async updateReports(settings: ReportSettings): Promise<ReportSettings> {
    if (settings.remoteExecution !== undefined && !["local", "remote"].includes(settings.remoteExecution)) throw new Error("レポート実行場所が不正です。");
    if (!settings.texCommand.trim()) throw new Error("TeX command is required.");
    if (!settings.plotCommand.trim()) throw new Error("Plot command is required.");
    if (!settings.outputDirectory.trim()) throw new Error("Report directory is required.");
    this.data.reports = {
      remoteExecution: "remote",
      texCommand: settings.texCommand.trim(),
      texArgs: settings.texArgs.map((value) => value.trim()).filter(Boolean),
      plotCommand: settings.plotCommand.trim(),
      plotCheckArgs: settings.plotCheckArgs.map((value) => value.trim()).filter(Boolean),
      outputDirectory: settings.outputDirectory.trim()
    };
    await this.persist();
    return this.getReports();
  }

  async updateOrchestration(settings: OrchestrationSettings): Promise<OrchestrationSettings> {
    for (const policy of settings.agentPolicies) {
      if (policy.usageLimitPercent !== undefined && (!Number.isFinite(policy.usageLimitPercent) || policy.usageLimitPercent < 1 || policy.usageLimitPercent > 100)) throw new Error("サービスの使用率目安は1〜100％で指定してください。");
      if (policy.codingPlan !== undefined) {
        validateOpenCodePlan(policy.codingPlan);
        if (policy.agentId !== "opencode") throw new Error("OpenCode接続先の設定が不正です。");
        validateOpenCodeModel(policy.codingPlan, policy.defaultModel);
      }
    }
    if (!Number.isFinite(settings.warningPercent) || settings.warningPercent < 1 || settings.warningPercent > 100) {
      throw new Error("Warning threshold must be between 1 and 100.");
    }
    if (!Number.isFinite(settings.drainPercent) || settings.drainPercent < settings.warningPercent || settings.drainPercent > 100) {
      throw new Error("Drain threshold must be at least the warning threshold and at most 100.");
    }
    if (settings.agentPolicies.some(policy => !Number.isFinite(policy.priority)
      || (policy.softTokenBudget !== undefined && !Number.isFinite(policy.softTokenBudget)))) throw new Error("Agent priority and token budget must be finite numbers.");
    this.data.orchestration = {
      warningPercent: settings.warningPercent,
      drainPercent: settings.drainPercent,
      agentPolicies: this.mergePolicies(settings.agentPolicies).map((policy) => ({
        ...policy,
        providerKey: policy.providerKey.trim() || policy.agentId,
        providerLabel: policy.providerLabel.trim() || policy.providerKey.trim() || policy.agentId,
        defaultModel: policy.defaultModel?.trim() || undefined,
        priority: Math.max(1, Math.min(100, Math.round(policy.priority))),
        softTokenBudget: policy.usageLimitPercent === undefined && policy.softTokenBudget && policy.softTokenBudget > 0
          ? Math.round(policy.softTokenBudget)
          : undefined
      })).map(policy => policy.codingPlan ? openCodePolicy(policy, policy.codingPlan, policy.defaultModel) : policy)
    };
    await this.persist();
    return this.getOrchestration();
  }

  private mergePolicies(incoming: OrchestrationSettings["agentPolicies"]): OrchestrationSettings["agentPolicies"] {
    const current = new Map(this.data.orchestration.agentPolicies.map((policy) => [policy.agentId, policy]));
    for (const policy of incoming) {
      if (current.has(policy.agentId)) {
        current.set(policy.agentId, { ...current.get(policy.agentId)!, ...policy });
      }
    }
    return [...current.values()];
  }

  private persist(): Promise<void> { return this.writer.write(this.data); }
}
