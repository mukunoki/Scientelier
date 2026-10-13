// A small remote foreground supervisor, not a daemon. The child inherits the
// SSH PTY, including its native screen, keyboard input and window resize.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hostname } from "node:os";

export async function runRemoteSession(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const { command, args, cwd, lock, token, handoff, exitPath } = config;
  // Helpers can be updated on disk while the desktop still runs its old code.
  // New desktop launches explicitly opt into the stop/ack handshake; the old
  // desktop waits for lock release before even reading a handoff.
  const retirementHandshake = config.retirementProtocol === 1;
  if (config.tmuxGate) {
    if (config.tmuxGate !== join(dirname(configPath), "tmux-ready.json")) throw new Error("Invalid tmux startup gate");
    const deadline = Date.now() + 10000;
    while (true) {
      try { if (JSON.parse(await readFile(config.tmuxGate, "utf8")).token === token) break; } catch { /* Pipe setup is still pending. */ }
      if (Date.now() > deadline) throw new Error("tmuxのログ準備を確認できず、CLIを起動していません。");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // No child was spawned. Persist that fact even when a different run owns
    // the shared lock; its lock must neither be removed nor mistaken for ours.
    await writeFile(exitPath, JSON.stringify({token,code:75,signal:null,notStarted:true,host:hostname(),endedAt:new Date().toISOString()}), {mode:0o600});
    throw new Error(`同じタスクの遠隔CLIが動作中、または終了を確認できません。二重起動を防いでいます。接続先で ${lock}/owner.json のPIDとホストを確認してください。残存CLIがないことを確認した場合に限り、このロックを手動で取り除いてください。`);
  }
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: (await import("node:os")).hostname(), token, startedAt: new Date().toISOString(), configPath }), { flag: "wx", mode: 0o600 });
  let released = false; let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (released) return Promise.resolve();
    return releasing ??= (async () => {
      const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
      if (owner.token !== token) throw new Error("Remote session lock changed owner");
      await unlink(join(lock, "owner.json")); await rmdir(lock); released = true;
    })();
  };
  let child: ChildProcess;
  try { child = spawn(command, args, { cwd, stdio: "inherit" }); }
  catch (error) {
    // E2BIG is synchronous: no ChildProcess exists and no 'error'/'exit'
    // event will arrive. Record non-start and release only our own lock.
    try {
      await writeFile(exitPath, JSON.stringify({token,code:75,signal:null,notStarted:true,host:hostname(),spawnError:(error as NodeJS.ErrnoException).code,endedAt:new Date().toISOString()}), {mode:0o600});
    } finally { await release(); }
    throw error;
  }
  // Keep a child receipt as well as the supervisor PID for post-disconnect recovery.
  const processReceipt = child.pid ? writeFile(join(dirname(configPath),"process.json"),JSON.stringify({token,pid:child.pid,host:hostname()}),{mode:0o600}).catch(()=>{}) : Promise.resolve();
  const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
  const interrupt = () => forward("SIGINT"), terminate = () => forward("SIGTERM"), hangup = () => forward("SIGHUP");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate); process.on("SIGHUP", hangup);
  let checking = false;
  let stopping = false;
  const poll = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      try {
        const stop = JSON.parse(await readFile(join(dirname(configPath), retirementHandshake ? "stop.json" : "quota-stop.json"), "utf8"));
        if (stop.token === token && !stopping) {
          stopping = true;
          // Stop only the failed CLI, not SSH or submitted batch jobs.
          child.kill("SIGTERM");
        }
      } catch { /* No authenticated stop request for this run. */ }
      if (stopping || released) return;
      const value = JSON.parse(await readFile(handoff, "utf8"));
      if (value.token === token && ["completed", "rate-limited", "blocked"].includes(value.status) && typeof value.summary === "string" && value.summary.trim()) {
        if (!retirementHandshake) { await release(); return; } // Legacy desktop, until its next restart.
        // A final/error reply can leave the interactive CLI awaiting input.
        // Releasing its lock here allowed authentication to restart an old writer.
        await writeFile(join(dirname(configPath), "retired.json"), JSON.stringify({token}), {mode:0o600});
        // The Mac first receives the result, then requests a token-bound stop.
        // Keep the lock until that handshake and actual child exit; otherwise
        // PTY exit can race ahead of delivery of the completion notification.
      }
    } catch { /* Completion or exit must be confirmed; never expire the lock by time. */ }
    finally { checking = false; }
  }, 250);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null; notStarted?: boolean; spawnError?: string }>((resolve) => {
      // Failed spawn also proves there is no live CLI. Persist that receipt so
      // recovery need not wait forever for an exit event that cannot occur.
      child.on("error", error => resolve({code:127,signal:null,notStarted:!child.pid,spawnError:(error as NodeJS.ErrnoException).code})); child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    await processReceipt;
    await writeFile(exitPath, JSON.stringify({ token, ...result, host:hostname(), endedAt: new Date().toISOString() }), { mode: 0o600 });
    process.exitCode = result.code ?? 1;
  } finally {
    clearInterval(poll); await release();
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup);
  }
}
if (require.main === module) void runRemoteSession(process.argv[2]).catch(e => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 75; });
