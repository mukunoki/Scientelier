import { BrowserWindow, session } from "electron";
import { readFile } from "node:fs/promises";
import { JsonFileWriter } from "./json-file-writer";
import { extractOllamaUsagePage, isOllamaLoginNavigation, isOllamaUsagePage, OLLAMA_USAGE_URL, parseOllamaUsagePage } from "./ollama-usage";
import type { RateLimitObservation } from "./usage-tracker";

const PARTITION = "persist:ollama-usage";
export class OllamaUsageBrowser {
  private enabled = false;
  private login?: BrowserWindow;
  private probe?: BrowserWindow;
  private pending?: Promise<RateLimitObservation>;
  private readonly writer: JsonFileWriter;
  constructor(private readonly path: string) { this.writer = new JsonFileWriter(path); }
  async init(): Promise<void> {
    try { this.enabled = JSON.parse(await readFile(this.path, "utf8")).enabled === true; } catch { /* opt-in */ }
  }
  isEnabled(): boolean { return this.enabled; }
  private window(visible: boolean): BrowserWindow {
    const win = new BrowserWindow({ title: "Ollama Cloud · ログイン・Usage", width: 1050, height: 800, show: visible,
      webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false } });
    win.removeMenu();
    win.webContents.session.setPermissionRequestHandler((_w, _p, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    const allowed = (url: string) => visible ? isOllamaLoginNavigation(url) : isOllamaUsagePage(url);
    const navigate = (event: Electron.Event, url: string) => { if (!allowed(url)) event.preventDefault(); };
    win.webContents.on("will-navigate", navigate);
    win.webContents.on("will-redirect", navigate);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-attach-webview", event => event.preventDefault());
    // No preload, IPC bridge, credential extraction, external-app launches,
    // arbitrary navigation, certificate override, or automatic purchase clicks.
    return win;
  }
  async open(): Promise<void> {
    if (this.login && !this.login.isDestroyed()) { this.login.show(); this.login.focus(); return; }
    await this.writer.write({ enabled: true }); this.enabled = true;
    const win = this.window(true); this.login = win;
    win.on("closed", () => { if (this.login === win) this.login = undefined; });
    try { await win.loadURL(OLLAMA_USAGE_URL); }
    catch { if (!win.isDestroyed()) throw new Error("Ollamaのログイン・Usage画面を開けません。ネットワークを確認してください。"); }
  }
  read(): Promise<RateLimitObservation> {
    if (!this.enabled) return Promise.reject(new Error("残量表示のWeb連携は未連携です。CLIの認証・モデル実行には不要です。"));
    if (this.pending) return this.pending;
    this.pending = this.readOnce().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async readOnce(): Promise<RateLimitObservation> {
    // A separate background reader never reloads a login/password form being edited.
    const win = this.window(false); this.probe = win;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          try { await win.loadURL(OLLAMA_USAGE_URL); }
          catch { throw new Error("Ollama Usageに接続できないか、Webログインが必要です。ログイン・Usage画面を確認してください。"); }
          if (!isOllamaUsagePage(win.webContents.getURL())) throw new Error("Ollama UsageのWebログインが必要です。");
          const code = `(${extractOllamaUsagePage.toString()})()`;
          let last: unknown;
          for (let i = 0; i < 8; i++) {
            if (win.isDestroyed()) throw new Error("Ollama Usageの取得を中止しました。");
            if (!isOllamaUsagePage(win.webContents.getURL())) throw new Error("Ollama UsageのWebログインが必要です。");
            try { return parseOllamaUsagePage(await win.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code }])); }
            catch (error) { last = error; }
            await new Promise(resolve => setTimeout(resolve, 350));
          }
          throw last;
        })(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Ollama Usage取得がタイムアウトしました。後で再取得してください。")), 20000); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      if (this.probe === win) this.probe = undefined;
    }
  }
  async disconnect(): Promise<void> {
    this.enabled = false;
    this.close();
    // Wait out an in-flight read before clearing credentials and disabling polling.
    await this.pending?.catch(() => {});
    await session.fromPartition(PARTITION).clearStorageData();
    await session.fromPartition(PARTITION).clearCache();
    await this.writer.write({ enabled: false }); this.enabled = false;
  }
  close(): void {
    for (const win of [this.probe, this.login]) if (win && !win.isDestroyed()) win.destroy();
    this.probe = this.login = undefined;
  }
}
