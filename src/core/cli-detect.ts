import { access } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { AGENT_PROFILES } from "./adapters";
import type { AgentProfile } from "./adapters";
import type { AgentStatus } from "./types";

const execFileAsync = promisify(execFile);

async function executableInPath(command: string): Promise<string | undefined> {
  const searchPaths = new Set([
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
    join(homedir(), ".opencode", "bin"),
    dirname(process.execPath)
  ]);

  for (const directory of searchPaths) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching.
    }
  }

  try {
    const { stdout } = await execFileAsync("/bin/zsh", [
      "-lic",
      `command -v ${command}`
    ], { timeout: 3000 });
    const resolved = stdout.trim().split("\n").at(-1);
    return resolved || undefined;
  } catch {
    return undefined;
  }
}

async function detectOne(profile: AgentProfile): Promise<AgentStatus> {
  const executable = await executableInPath(profile.command);
  if (!executable) {
    return {
      ...profile,
      installed: false,
      error: "Not found"
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      timeout: 5000
    });
    const version = `${stdout}\n${stderr}`.trim().split("\n")[0];
    return { ...profile, executable, installed: true, version: version || "Detected" };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      ...profile,
      executable,
      installed: false,
      error: `Found but unusable: ${message}`
    };
  }
}

export async function detectAgents(): Promise<AgentStatus[]> {
  return Promise.all(AGENT_PROFILES.map(detectOne));
}
