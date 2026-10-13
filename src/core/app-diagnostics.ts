import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { redactSecrets } from "./redact";
import type { BrowserWindow } from "electron";

// Diagnostic metadata only: never pass prompts, CLI streams, settings or login input here.
// Redaction is a second line of defence, not a guarantee for arbitrary user content.
export function diagnosticText(value: unknown): string {
  const raw = typeof value === "string" ? value : inspect(value, { depth: 3, maxArrayLength: 30, maxStringLength: 8000, customInspect: false, getters: false });
  return redactSecrets(raw)
    .replace(/((?:["']?)(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie)(?:["']?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[REDACTED]");
}

export class AppDiagnostics {
  readonly session = randomUUID();
  readonly file: string;
  private marker: string;
  private failed = false;
  private finished = false;
  private fatal = false;
  private burstSecond = 0;
  private burstCount = 0;
  private suppressed = 0;
  private readonly fallback = process.stderr.write.bind(process.stderr);

  constructor(readonly directory: string, private maxBytes = 2 * 1024 * 1024, private backups = 4) {
    this.file = join(directory, "application.log");
    this.marker = join(directory, "session.json");
    this.safely(() => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      if (existsSync(this.marker)) {
        try {
          const previous = JSON.parse(readFileSync(this.marker, "utf8"));
          if (previous.clean !== true) this.log("warn", "previous-session-unclosed", { session: previous.session, pid: previous.pid, lastSeen: previous.at });
        } catch { this.log("warn", "previous-session-marker-unreadable"); }
      }
    });
    this.log("info", "session-start", { pid: process.pid, ppid: process.ppid, platform: process.platform, versions: process.versions });
    this.checkpoint();
  }

  private safely(action: () => void): void {
    try { action(); } catch {
      // A full/unwritable disk must not recursively call the wrapped console or crash work.
      if (!this.failed) { this.failed = true; try { this.fallback("Scientelier: diagnostic log could not be saved.\n"); } catch { /* stderr may also be closed */ } }
    }
  }

  log(level: string, event: string, detail?: unknown): void {
    this.safely(() => {
      // Broken renderers can emit thousands of errors per second. Bound synchronous
      // logging overhead as well as disk usage; never drop fatal/exit records.
      const second = Math.floor(Date.now() / 1000);
      if (second !== this.burstSecond) {
        this.burstSecond = second; this.burstCount = 0;
        const skipped = this.suppressed; this.suppressed = 0;
        if (skipped) this.log("warn", "log-burst-suppressed", { count: skipped });
      }
      if (++this.burstCount > 100 && level !== "fatal" && event !== "process-exit") { this.suppressed++; return; }
      const prefix = `${new Date().toISOString()} ${level.toUpperCase()} [${this.session}] ${event} `;
      let content = diagnosticText(detail ?? "").replace(/[\r\n]+/g, " ");
      const limit = Math.min(16 * 1024, Math.floor(this.maxBytes / 2));
      while (Buffer.byteLength(prefix + content + "\n") > limit && content.length) content = content.slice(0, Math.floor(content.length * 0.75));
      const line = prefix + content + "\n";
      if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > this.maxBytes) {
        const oldest = `${this.file}.${this.backups}`;
        if (existsSync(oldest)) unlinkSync(oldest);
        for (let i = this.backups - 1; i >= 1; i--) if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
        renameSync(this.file, `${this.file}.1`);
      }
      appendFileSync(this.file, line, { mode: 0o600 });
      chmodSync(this.file, 0o600);
    });
  }

  checkpoint(detail?: unknown): void {
    if (this.finished) return;
    this.log("info", "heartbeat", detail);
    this.saveMarker(false);
  }

  private saveMarker(clean: boolean): void {
    this.safely(() => {
      const temp = `${this.marker}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ session: this.session, pid: process.pid, at: new Date().toISOString(), clean }), { mode: 0o600 });
      renameSync(temp, this.marker);
    });
  }

  recordFatal(error: unknown, origin: string): void {
    this.fatal = true;
    this.log("fatal", origin, error);
    this.flush();
  }

  finish(code: number): void {
    this.finished = true;
    this.log("info", "process-exit", { code, fatal: this.fatal });
    this.saveMarker(code === 0 && !this.fatal);
    this.flush();
  }

  private flush(): void {
    this.safely(() => { const fd = openSync(this.file, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } });
  }
}

export function installProcessDiagnostics(log: AppDiagnostics): () => void {
  // Observe fatal exceptions without swallowing them or continuing in a corrupt state.
  // Node's default unhandled-rejection=throw also reaches this monitor.
  const fatal = (error: Error, origin: string) => log.recordFatal(error, origin);
  const warning = (error: Error) => log.log("warn", "process-warning", error);
  const exit = (code: number) => log.finish(code);
  process.on("uncaughtExceptionMonitor", fatal);
  process.on("warning", warning);
  process.on("exit", exit);
  const originals = { warn: console.warn, error: console.error };
  for (const key of ["warn", "error"] as const) console[key] = (...args: unknown[]) => {
    log.log(key, `main-console-${key}`, args); originals[key](...args);
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const handlers = signals.map(signal => {
    const handler = () => {
      log.recordFatal({ signal }, "process-signal");
      process.removeListener(signal, handler);
      // Re-raise to preserve normal signal termination; do not pretend work completed.
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
    return handler;
  });
  return () => {
    process.removeListener("uncaughtExceptionMonitor", fatal);
    process.removeListener("warning", warning);
    process.removeListener("exit", exit);
    signals.forEach((signal, i) => process.removeListener(signal, handlers[i]));
    console.warn = originals.warn; console.error = originals.error;
  };
}

export function attachWindowDiagnostics(window: BrowserWindow, log: AppDiagnostics): void {
  window.webContents.on("render-process-gone", (_event, details) => log.log("error", "renderer-process-gone", details));
  window.webContents.on("preload-error", (_event, _path, error) => log.log("error", "preload-error", error));
  window.webContents.on("console-message", details => {
    if (details.level === "warning" || details.level === "error") log.log(details.level, "renderer-console", { message: details.message, line: details.lineNumber });
  });
  window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => log.log("error", "page-load-failed", { code, description, isMainFrame }));
  window.on("unresponsive", () => log.log("warn", "window-unresponsive"));
  window.on("responsive", () => log.log("info", "window-responsive"));
  window.on("closed", () => log.log("info", "window-closed"));
}
