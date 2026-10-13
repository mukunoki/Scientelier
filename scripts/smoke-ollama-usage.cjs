// Isolated native Chromium test: no real account, cookies, or network requests.
const { app, session, BrowserWindow } = require('electron');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { OllamaUsageBrowser } = require('../dist/core/ollama-usage-browser');
const directory = mkdtempSync(join(tmpdir(), 'harness-ollama-web-smoke-'));
app.setPath('userData', directory);
const settings = join(directory, 'ollama-usage.json');
writeFileSync(settings, JSON.stringify({enabled: true}));
let reader;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const partition = session.fromPartition('persist:ollama-usage');
  let fixture = `<html><body><main>
    <h1>Settings</h1><form><input value="SECRET"><p>Private email: private@example.test</p></form>
    <section><div><h2>Session usage</h2><span>0% used</span></div><p>Resets in 2 hours</p><time datetime="2026-09-16T12:00:00Z"></time></section>
    <section><div><h2>Weekly usage</h2><span>12.5% used</span></div><p>Resets in 3 days</p><time datetime="2026-09-19T00:00:00Z"></time></section>
  </main></body></html>`;
  partition.protocol.handle('https', () => new Response(fixture, {headers:{'Content-Type':'text/html'}}));
  app.on('browser-window-created', (_e, win) => {
    const prefs = win.webContents.getLastWebPreferences();
    assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true); assert.equal(prefs.webSecurity, true); assert.ok(!prefs.preload);
    assert.equal(win.isVisible(), false);
  });
  reader = new OllamaUsageBrowser(settings); await reader.init();
  const first = await reader.read();
  assert.deepEqual(first.windows.map(w => w.usedPercent), [0,12.5]);
  assert.equal(first.windows[0].resetAt,'2026-09-16T12:00:00.000Z');
  assert.equal(first.windows[0].resetText,'Resets in 2 hours');
  assert.doesNotMatch(JSON.stringify(first),/SECRET|private@example/);
  fixture = `<html><body><main><section><h2>Monthly usage</h2><p>$15 / $60</p><p>Resets October 1</p></section><section><h2>Extra balance</h2><p>$5.00</p></section></main></body></html>`;
  const monthly = await reader.read();
  assert.equal(monthly.usedPercent, 25); assert.equal(monthly.creditBalance, 'extra balance: $5.00');
  fixture = '<html><body><h1>Sign in</h1><input type="password" value="SECRET"></body></html>';
  await assert.rejects(reader.read(), /読み取れません/);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  await reader.disconnect(); assert.equal(reader.isEnabled(), false);
  await assert.rejects(reader.read(), /未連携/);
  console.log('Ollama isolated web usage: legacy/monthly quotas, reset dates, privacy, sandbox and logout passed. No real network/account access.');
}).catch(error => { console.error(error); process.exitCode=1; }).finally(() => {
  reader?.close(); rmSync(directory, {recursive:true,force:true}); app.exit(process.exitCode || 0);
});
