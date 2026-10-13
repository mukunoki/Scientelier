// Runs in memory in the FINAL shell, over the user's existing nested SSH PTY.
// No listening TCP port, ssh-agent forwarding, daemon or remote package install.
import { createInterface } from "node:readline";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { hostname, userInfo, homedir } from "node:os";
import { remoteOperation } from "./remote-bridge";
import { PREPARED_PTY_SOURCE } from "./prepared-pty";

export async function servePrepared(token: string, python: string): Promise<void> {
  const prefix = `AH_${token}:`;
  const send = (value: unknown) => process.stdout.write(prefix + JSON.stringify(value) + "\n");
  const sessions = new Map<string, ChildProcessWithoutNullStreams>();
  const root = await realpath(process.cwd());
  if (root === "/") throw new Error("作業フォルダを cd で選んでください（ルートは使用できません）。");
  if (Number(process.versions.node.split(".")[0]) < 18) throw new Error("最終マシンにはNode.js 18以上が必要です。");
  await promisify(execFile)(python, ["-c", "import sys,pty,fcntl,termios; assert sys.version_info >= (3,6); print('ok')"], { timeout: 10000 });
  const cleanup = () => { for (const child of sessions.values()) child.stdin.end(); };
  const quit = () => { cleanup(); process.exit(1); };
  process.on("SIGHUP", quit); process.on("SIGTERM", quit);
  const probe = await remoteOperation(root, { op: "probe" });
  send({ event: "ready", probe: { ...(probe as object), username: userInfo().username, home: homedir(), hostname: hostname(), nodeExecutable: process.execPath } });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const handle = async (r: any): Promise<unknown> => {
    if (r.op === "terminal:start") {
      const spec = r.spec;
      if (typeof r.session !== "string" || !/^[0-9a-f-]{36}$/.test(r.session) || sessions.has(r.session) || sessions.size >= 32) throw new Error("Invalid or duplicate terminal");
      if (!spec || typeof spec.command !== "string" || !spec.command || spec.command.includes("\0") || !Array.isArray(spec.args)
        || spec.args.some((a: unknown) => typeof a !== "string" || a.includes("\0")) || JSON.stringify(spec).length > 5 * 1024 * 1024 || spec.cwd !== root) throw new Error("Invalid terminal invocation or workspace");
      const child = spawn(python, ["-u", "-c", PREPARED_PTY_SOURCE, JSON.stringify(spec)], { stdio: ["pipe", "pipe", "pipe"] });
      sessions.set(r.session, child);
      let ended = false;
      const finish = (code: number) => { if (!ended) { ended = true; sessions.delete(r.session); send({ event: "exit", session: r.session, exitCode: code }); } };
      createInterface({ input: child.stdout }).on("line", line => {
        try { const value = JSON.parse(line); if (typeof value.data === "string") send({ event: "data", session: r.session, data: value.data }); else if (Number.isInteger(value.exitCode)) finish(value.exitCode); }
        catch { /* Nonprotocol helper output cannot complete a task. */ }
      });
      child.stderr.on("data", data => send({ event: "data", session: r.session, data: Buffer.from(data).toString("base64") }));
      child.on("error", e => { send({ event: "data", session: r.session, data: Buffer.from(String(e)).toString("base64") }); finish(255); });
      // A closing PTY must not turn an input/EPIPE race into a bridge crash.
      child.stdin.on("error", () => finish(255));
      // Wait for pipes to drain so the final screen output isn't discarded.
      child.on("close", code => finish(code ?? 255));
      return true;
    }
    if (["terminal:input", "terminal:resize", "terminal:kill"].includes(r.op)) {
      const child = sessions.get(r.session); if (!child) throw new Error("Terminal exited");
      if (r.op === "terminal:input") {
        if (typeof r.data !== "string" || r.data.length > 90000) throw new Error("Input too large");
        child.stdin.write(JSON.stringify({ op: "input", data: r.data }) + "\n");
      } else if (r.op === "terminal:resize") {
        if (!Number.isInteger(r.cols) || !Number.isInteger(r.rows) || r.cols < 2 || r.cols > 500 || r.rows < 2 || r.rows > 300) throw new Error("Invalid terminal size");
        child.stdin.write(JSON.stringify({ op: "resize", cols: r.cols, rows: r.rows }) + "\n");
      } else {
        if (!["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"].includes(r.signal)) throw new Error("Invalid signal");
        child.stdin.write(JSON.stringify({ op: "kill", signal: r.signal }) + "\n");
      }
      return true;
    }
    return remoteOperation(root, r);
  };
  try {
    for await (const line of lines) {
      if (!line.startsWith(prefix)) continue;
      let r: any;
      try {
        if (line.length > 40 * 1024 * 1024) throw new Error("Request too large");
        r = JSON.parse(line.slice(prefix.length));
        // Slow read-only probes must not stall keystrokes/resize or task handoffs.
        if (["service-capacity", "login-status"].includes(r.op)) {
          const id = r.id;
          void handle(r).then(result => send({ id, result }), e => send({ id, error: String(e) }));
        } else send({ id: r.id, result: await handle(r) });
      } catch (e) { send({ id: r?.id, error: String(e), code: (e as NodeJS.ErrnoException).code }); }
    }
  } finally { cleanup(); process.off("SIGHUP", quit); process.off("SIGTERM", quit); }
}
