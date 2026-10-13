import type { AgentId, AgentStatus, WorkUnitMode } from "./types";
import { pathToFileURL } from "node:url";
import { openCodeProviderConfig, type OpenCodePlan } from "./opencode";

export interface AgentProfile {
  id: AgentId;
  label: string;
  command: string;
}

export interface Invocation {
  command: string;
  args: string[];
  cwd: string;
}

export interface AgentInvocationRequest {
  codingPlan?: OpenCodePlan;
  hpc?: boolean;
  workspace?: boolean;
  research?: boolean;
  quality?: boolean;
  messages?: boolean;
  openCodePluginPath?: string;
  codexPermissions?: "sandbox" | "full-access";
  continueSession?: string;
  prompt: string;
  launchPrompt?: string;
  instructionsPath?: string;
  cwd: string;
  mode: WorkUnitMode;
  model?: string;
  additionalDirectories?: string[];
  completionCommand?: string[];
  resultCommand?: string[];
  statusCommand?: string[];
}

// Hook commands are shell-executed by Claude. Never interpolate unquoted paths.
export function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export const AGENT_PROFILES: AgentProfile[] = [
  { id: "codex", label: "Codex", command: "codex" },
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "antigravity", label: "Antigravity CLI", command: "agy" },
  { id: "opencode", label: "OpenCode", command: "opencode" }
];

/** A user-operated shell, not an assignment: no prompt, MCP, completion hook,
 * auto-approval or resume flag. Preserve the selected subscription and model. */
export function buildRecoveryShell(status: AgentStatus, cwd: string, model?: string, codingPlan?: OpenCodePlan): { shell: Invocation; command: string } {
  if (!status.executable) throw new Error("CLIが見つかりません。");
  const shell: Invocation={command:"/usr/bin/env",args:["HISTFILE=/dev/null","/bin/bash","--noprofile","--norc","-i"],cwd};
  if (status.id==="opencode" && codingPlan) {
    const config={share:"disabled",autoupdate:false,...openCodeProviderConfig(codingPlan,model)};
    shell.args.unshift(`OPENCODE_CONFIG_CONTENT=${JSON.stringify(config)}`);
  }
  return {shell,command:[status.executable,...(model?["--model",model]:[])].map(quoteShellArgument).join(" ")};
}

export function buildInvocation(status: AgentStatus, request: AgentInvocationRequest): Invocation {
  if (!status.executable) {
    throw new Error(`${status.label} is not installed.`);
  }
  if (request.continueSession && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.continueSession) || !["codex", "claude"].includes(status.id) || request.mode !== "write")) throw new Error("この会話は安全に引き継げません。");

  switch (status.id) {
    case "codex":
      {
        const fullAccess = request.codexPermissions === "full-access";
        const args = [...(request.continueSession ? ["fork", request.continueSession] : []), "--ask-for-approval", "never", "--sandbox", fullAccess ? "danger-full-access" : request.mode === "write" ? "workspace-write" : "read-only", "--search"];
        // Trust only this launch's user-selected root, without changing global
        // config or the separate read/write sandbox policy. Quote the TOML key.
        args.push("-c", `projects.${JSON.stringify(request.cwd)}.trust_level="trusted"`);
        if (request.mode === "write") {
          if (!fullAccess) args.push("-c", "sandbox_workspace_write.network_access=true");
          for (const directory of request.additionalDirectories ?? []) args.push("--add-dir", directory);
        }
        if (request.completionCommand) args.push("-c", `notify=${JSON.stringify(request.completionCommand)}`);
        if (request.resultCommand) {
          args.push("-c", `mcp_servers.agent_harness.command=${JSON.stringify(request.resultCommand[0])}`,
            "-c", `mcp_servers.agent_harness.args=${JSON.stringify(request.resultCommand.slice(1))}`,
            "-c", 'mcp_servers.agent_harness.enabled=true', "-c", 'mcp_servers.agent_harness.required=true',
            "-c", `mcp_servers.agent_harness.enabled_tools=${JSON.stringify(["get_instructions", "get_progress", "get_run_evidence", "get_skill", "submit_result", ...(request.messages ? ["send_message","read_messages"] : []), ...(request.hpc ? ["hpc_manage"] : []), ...(request.workspace ? ["workspace_manage"] : []), ...(request.research ? ["research_manage"] : []), ...(request.quality ? ["quality_manage"] : [])])}`,
            "-c", 'mcp_servers.agent_harness.tools.submit_result.approval_mode="approve"');
          if (request.hpc) args.push("-c", 'mcp_servers.agent_harness.tools.hpc_manage.approval_mode="approve"');
          if (request.workspace) args.push("-c", 'mcp_servers.agent_harness.tools.workspace_manage.approval_mode="approve"');
          if (request.research) args.push("-c", 'mcp_servers.agent_harness.tools.research_manage.approval_mode="approve"');
          if (request.quality) args.push("-c", 'mcp_servers.agent_harness.tools.quality_manage.approval_mode="approve"');
          if (request.messages) for(const tool of ["send_message","read_messages"]) args.push("-c",`mcp_servers.agent_harness.tools.${tool}.approval_mode="approve"`);
        }
        if (request.model) args.push("--model", request.model);
        args.push(request.launchPrompt ?? request.prompt);
        return { command: status.executable, args, cwd: request.cwd };
      }
    case "claude":
      {
        const args = [
          request.launchPrompt ?? request.prompt,
          "--permission-mode",
          // Harness-owned sessions run unattended by user choice. Role-level
          // read-only instructions are not an OS/filesystem boundary in this mode.
          "bypassPermissions"
        ];
        if (request.continueSession) args.push("--resume", request.continueSession, "--fork-session");
        for (const directory of request.additionalDirectories ?? []) args.push("--add-dir", directory);
        const settings: Record<string, unknown> = {};
        if (request.completionCommand) {
          const hook = { type: "command", command: request.completionCommand.map(quoteShellArgument).join(" "), timeout: 10 };
          settings.hooks = { Stop: [{ hooks: [hook] }], StopFailure: [{ hooks: [hook] }] };
        }
        if (request.statusCommand) settings.statusLine = { type: "command", command: request.statusCommand.map(quoteShellArgument).join(" ") };
        if (request.resultCommand) {
          args.push("--mcp-config", JSON.stringify({ mcpServers: { agent_harness: { type: "stdio", command: request.resultCommand[0], args: request.resultCommand.slice(1) } } }));
          settings.permissions = { allow: ["mcp__agent_harness__get_instructions", "mcp__agent_harness__get_progress", "mcp__agent_harness__get_run_evidence", "mcp__agent_harness__get_skill", "mcp__agent_harness__submit_result", ...(request.messages ? ["mcp__agent_harness__send_message","mcp__agent_harness__read_messages"] : []), ...(request.hpc ? ["mcp__agent_harness__hpc_manage"] : []), ...(request.workspace ? ["mcp__agent_harness__workspace_manage"] : []), ...(request.research ? ["mcp__agent_harness__research_manage"] : []), ...(request.quality ? ["mcp__agent_harness__quality_manage"] : [])] };
          settings.hooks = { ...(settings.hooks as Record<string, unknown> ?? {}), PreToolUse: [{
            matcher: "^mcp__agent_harness__submit_result$",
            hooks: [{ type: "command", command: [...request.resultCommand, "--permission-hook"].map(quoteShellArgument).join(" "), timeout: 10 }]
          }] };
        }
        if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
        if (request.model) args.push("--model", request.model);
        return { command: status.executable, args, cwd: request.cwd };
      }
    case "antigravity":
      {
        // Native TUI, never --prompt (agy treats that as headless --print).
        // As with Claude, role restrictions are instructions, not an OS sandbox.
        const prompt = request.instructionsPath
          ? `Scientelierの担当工程です。まず次のUTF-8ファイルをツールで全文読み、そこに記載された今回の作業指示・権限・結果提出方法に従ってください。長い場合は分割して末尾まで読んでください。読めない場合は作業を開始せず理由を報告してください。\nInstructions file: ${JSON.stringify(request.instructionsPath)}`
          : request.launchPrompt ?? request.prompt;
        const args = ["--prompt-interactive", prompt, "--mode", "accept-edits", "--dangerously-skip-permissions"];
        if (request.model) args.push("--model", request.model);
        for (const directory of request.additionalDirectories ?? []) args.push("--add-dir", directory);
        return { command: status.executable, args, cwd: request.cwd };
      }
    case "gemini":
      throw new Error("Gemini CLIは廃止しました。担当CLIをAntigravityへ変更してください。過去の履歴は保持されています。");
    case "opencode":
      {
        const args = ["--prompt", request.launchPrompt ?? request.prompt, "--auto", "--agent", "agent_harness"];
        const config: Record<string, unknown> = {
          share: "disabled", autoupdate: false,
          agent: { agent_harness: { mode: "primary", description: "Scientelierの担当工程", permission: {
            edit: request.mode === "read" ? "deny" : "allow", task: "deny", question: "deny", "agent_harness_*": "allow"
          } } }
        };
        if (request.codingPlan) {
          Object.assign(config, openCodeProviderConfig(request.codingPlan, request.model));
        }
        if (request.resultCommand) config.mcp = { agent_harness: { type: "local", command: request.resultCommand, enabled: true } };
        if (request.openCodePluginPath) config.plugin = [pathToFileURL(request.openCodePluginPath).href];
        if (request.model) args.push("--model", request.model);
        // Process-local overlay: never overwrite OpenCode's auth/config files.
        return { command: "/usr/bin/env", args: [`OPENCODE_CONFIG_CONTENT=${JSON.stringify(config)}`, status.executable, ...args], cwd: request.cwd };
      }
  }
}
