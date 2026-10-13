import type { AgentId } from "./types";

type OutputStream = "stdout" | "stderr" | "status";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function clipped(value: string, maximum = 8_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n… output clipped in readable view`;
}

function readableToolResult(value: string): string {
  const cleanedLines = value.split(/\r?\n/).filter((line) =>
    line.trim()
    && !/^REMINDER:/i.test(line.trim())
    && !/^Links:\s*\[\s*\{/i.test(line.trim())
  );
  const cleaned = [...new Set(cleanedLines)].join("\n");
  const structured = /^\s*[\[{]\s*["{]/.test(value) || /Links:\s*\[\s*\{/i.test(value);
  if (structured) return "✓ Tool returned structured data · open Raw for details";
  return `✓ Tool completed${cleaned ? `\n${clipped(cleaned, 1_200)}` : ""}`;
}

function commandFrom(value: Record<string, unknown>): string | undefined {
  return stringValue(value.command)
    ?? stringValue(value.cmd)
    ?? stringValue(record(value.input)?.command)
    ?? stringValue(record(value.parameters)?.command);
}

function pathFrom(value: Record<string, unknown>): string | undefined {
  return stringValue(value.path)
    ?? stringValue(value.file_path)
    ?? stringValue(record(value.input)?.file_path)
    ?? stringValue(record(value.parameters)?.file_path);
}

function detailFrom(value: Record<string, unknown>): string | undefined {
  const input = record(value.input) ?? record(value.parameters);
  return commandFrom(value)
    ?? pathFrom(value)
    ?? stringValue(input?.description)
    ?? stringValue(input?.query);
}

function rateWindowEntries(value: unknown): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const window = record(item);
      if (!window) return [];
      const id = stringValue(window.id) ?? stringValue(window.name) ?? stringValue(window.type) ?? `window-${index + 1}`;
      return [[id, window] as [string, Record<string, unknown>]];
    });
  }
  const windows = record(value);
  return windows ? Object.entries(windows).flatMap(([id, item]) => {
    const window = record(item);
    return window ? [[id, window] as [string, Record<string, unknown>]] : [];
  }) : [];
}

function readableRateWindowName(value: string): string {
  const normalized = value.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  const labels: Record<string, string> = {
    five_hour: "5 hour",
    five_hours: "5 hours",
    five_day: "5 day",
    five_days: "5 days",
    seven_day: "7 day",
    seven_days: "7 days",
    seven_day_overage_included: "7 day overage",
    seven_day_sonnet: "7 day Sonnet",
    daily: "daily",
    weekly: "weekly",
    monthly: "monthly"
  };
  return labels[normalized] ?? value.replaceAll("_", "-");
}

function textFromContent(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content.trim()] : [];
  if (!Array.isArray(content)) return [];
  const lines: string[] = [];
  for (const blockValue of content) {
    const block = record(blockValue);
    if (!block) continue;
    const type = stringValue(block.type) ?? "content";
    const text = stringValue(block.text) ?? stringValue(block.content);
    if (type === "tool_use") {
      const name = stringValue(block.name) ?? "tool";
      const detail = detailFrom(block);
      lines.push(`› ${name}${detail ? `: ${detail}` : ""}`);
    } else if (type === "tool_result") {
      const result = stringValue(block.content) ?? stringValue(block.output);
      lines.push(result ? readableToolResult(result) : "✓ Tool completed");
    } else if (text) lines.push(text);
  }
  return lines;
}

function usageLine(value: Record<string, unknown>): string | undefined {
  const usage = record(value.usage) ?? record(value.stats) ?? value;
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  const cached = usage.cached_input_tokens ?? usage.cachedInputTokens;
  const values = [
    typeof input === "number" ? `${input.toLocaleString()} input` : "",
    typeof cached === "number" ? `${cached.toLocaleString()} cached` : "",
    typeof output === "number" ? `${output.toLocaleString()} output` : ""
  ].filter(Boolean);
  return values.length ? `◔ ${values.join(" · ")} tokens` : undefined;
}

function fallbackText(value: Record<string, unknown>): string | undefined {
  for (const key of ["text", "content", "output", "result", "message", "error"]) {
    const direct = stringValue(value[key]);
    if (direct) return clipped(direct);
    const nested = record(value[key]);
    const nestedText = nested && (stringValue(nested.text) ?? stringValue(nested.content));
    if (nestedText) return clipped(nestedText);
  }
  return undefined;
}

export class AgentOutputFormatter {
  private stdoutBuffer = "";
  private readonly startedItems = new Set<string>();

  constructor(private readonly agentId: AgentId) {}

  push(stream: OutputStream, chunk: string): string {
    if (stream === "status") return `● ${chunk.trim()}\n`;
    if (stream === "stderr") {
      return chunk.split(/\r?\n/).filter((line) => line.trim()).map((line) => `⚠ ${line}\n`).join("");
    }
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    return lines.map((line) => this.formatLine(line)).join("");
  }

  flush(): string {
    if (!this.stdoutBuffer) return "";
    const value = this.formatLine(this.stdoutBuffer);
    this.stdoutBuffer = "";
    return value;
  }

  private formatLine(line: string): string {
    if (!line.trim()) return "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return `${line}\n`;
    }
    const value = record(parsed);
    if (!value) return `${line}\n`;
    const formatted = this.agentId === "codex"
      ? this.codex(value)
      : this.agentId === "claude"
        ? this.claude(value)
        : this.agentId === "gemini"
          ? this.gemini(value)
          : this.openCode(value);
    if (formatted === "") return "";
    const type = stringValue(value.type) ?? "event";
    return `${formatted ?? fallbackText(value) ?? `· ${type}`}\n`;
  }

  private codex(value: Record<string, unknown>): string | undefined {
    const type = stringValue(value.type);
    if (type === "thread.started") return "● Codex session started";
    if (type === "turn.started") return "◆ Thinking and inspecting…";
    if (type === "turn.completed") return usageLine(value) ?? "✓ Turn completed";
    if (type === "error") return `✕ ${fallbackText(value) ?? "Codex error"}`;
    const item = record(value.item);
    if (!item) return undefined;
    const itemType = stringValue(item.type);
    const itemId = stringValue(item.id);
    if (type === "item.started") {
      if (itemId) this.startedItems.add(itemId);
      if (itemType === "command_execution") return `› ${commandFrom(item) ?? "Running command"}`;
      if (itemType === "mcp_tool_call") return `› ${stringValue(item.tool) ?? stringValue(item.name) ?? "Using tool"}`;
      if (itemType === "web_search") return `⌕ ${stringValue(item.query) ?? "Searching"}`;
      return itemType ? `› ${itemType.replaceAll("_", " ")}` : undefined;
    }
    if (type === "item.completed") {
      if (itemType === "agent_message") return stringValue(item.text) ?? fallbackText(item);
      if (itemType === "command_execution") {
        const output = stringValue(item.aggregated_output) ?? stringValue(item.output);
        const exitCode = item.exit_code;
        const command = commandFrom(item);
        const prefix = itemId && this.startedItems.has(itemId) ? "" : command ? `› ${command}\n` : "";
        return `${prefix}${output ? `${clipped(output)}\n` : ""}${exitCode === 0 ? "✓ Command completed" : `✕ Command exited ${String(exitCode ?? "with an error")}`}`;
      }
      if (itemType === "file_change") {
        const changes = Array.isArray(item.changes) ? item.changes.length : undefined;
        return `✎ Updated files${changes ? ` · ${changes} changes` : ""}`;
      }
      return fallbackText(item) ?? (itemType ? `✓ ${itemType.replaceAll("_", " ")}` : undefined);
    }
    return undefined;
  }

  private claude(value: Record<string, unknown>): string | undefined {
    const type = stringValue(value.type);
    if (type === "system") {
      const subtype = stringValue(value.subtype);
      if (subtype === "thinking_tokens") return "";
      if (subtype === "task_started") {
        return `↳ Subagent started${stringValue(value.description) ? `: ${stringValue(value.description)}` : ""}`;
      }
      if (subtype === "task_progress") {
        return `↳ ${stringValue(value.description) ?? "Subagent working…"}`;
      }
      if (subtype && subtype !== "init") return `· ${subtype.replaceAll("_", " ")}`;
      const model = stringValue(value.model);
      return `● Claude session started${model ? ` · ${model}` : ""}`;
    }
    if (type === "assistant" || type === "user") {
      const message = record(value.message) ?? value;
      const parts = textFromContent(message.content);
      const subagent = stringValue(value.parent_tool_use_id) ? "↳ Subagent\n" : "";
      return parts.length ? `${subagent}${parts.join("\n")}` : "";
    }
    if (type === "rate_limit_event") {
      const info = record(value.rate_limit_info);
      const windows = rateWindowEntries(info?.unifiedWindows ?? info?.windows ?? info?.rateLimits);
      const values = windows.map(([name, window]) => {
        const utilization = record(window)?.utilization
          ?? record(window)?.usedPercent
          ?? record(window)?.used_percentage;
        return typeof utilization === "number"
          ? `${readableRateWindowName(name)} ${Math.round(utilization * (utilization <= 1 ? 100 : 1))}%`
          : "";
      }).filter(Boolean);
      return values.length ? `◔ ${values.join(" · ")}` : "";
    }
    if (type === "result") {
      const cost = typeof value.total_cost_usd === "number" ? ` · $${value.total_cost_usd.toFixed(4)}` : "";
      const usage = usageLine(value);
      return [`✓ ${value.is_error ? "Completed with error" : "Completed"}${cost}`, usage].filter(Boolean).join("\n");
    }
    if (type === "tool_progress") return `… ${stringValue(value.tool_name) ?? "Tool running"}`;
    return undefined;
  }

  private gemini(value: Record<string, unknown>): string | undefined {
    const type = stringValue(value.type);
    if (type === "init") return `● Gemini session started${stringValue(value.model) ? ` · ${stringValue(value.model)}` : ""}`;
    if (type === "message") {
      if (value.role === "user") return undefined;
      return stringValue(value.content) ?? fallbackText(value);
    }
    if (type === "tool_use") {
      const name = stringValue(value.tool_name) ?? stringValue(value.name) ?? "tool";
      return `› ${name}${detailFrom(value) ? `: ${detailFrom(value)}` : ""}`;
    }
    if (type === "tool_result") {
      const output = stringValue(value.output);
      return value.status === "success"
        ? output ? readableToolResult(output) : "✓ Tool completed"
        : `✕ ${clipped(output ?? "Tool failed", 1_200)}`;
    }
    if (type === "result") return usageLine(value) ?? `✓ ${stringValue(value.status) ?? "Completed"}`;
    return undefined;
  }

  private openCode(value: Record<string, unknown>): string | undefined {
    const type = stringValue(value.type);
    const part = record(value.part);
    if (type === "text") return stringValue(part?.text) ?? stringValue(value.text);
    if (type === "step_start") return "◆ Working…";
    if (type === "step_finish") return usageLine(part ?? value) ?? "✓ Step completed";
    if (type === "tool_use" || part?.type === "tool") {
      const source = part ?? value;
      return `› ${stringValue(source.tool) ?? stringValue(source.name) ?? "tool"}${commandFrom(source) ? `: ${commandFrom(source)}` : ""}`;
    }
    return undefined;
  }
}

export function extractAgentFailure(stdout: string, stderr: string): string | undefined {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      const value = record(JSON.parse(line));
      if (!value) continue;
      if (Array.isArray(value.errors)) {
        const messages = value.errors.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
        if (messages.length) return messages.join("; ");
      }
      const error = stringValue(value.error) ?? stringValue(record(value.error)?.message);
      if (error) return error;
      if (value.is_error && stringValue(value.result)) return stringValue(value.result);
    } catch {
      // Continue to stderr, which is usually clearer for CLI argument errors.
    }
  }
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const explicit = lines.find((line) => /(?:^error:|failed|invalid|not found|denied)/i.test(line));
  return clipped(explicit ?? lines.at(-1) ?? "", 600) || undefined;
}
