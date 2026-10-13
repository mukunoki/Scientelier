// Real Electron event payloads, isolated from user tasks, accounts and application data.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { AppDiagnostics, attachWindowDiagnostics } = require('../dist/core/app-diagnostics');
const directory = mkdtempSync(join(tmpdir(), 'harness-log-smoke-'));
app.setPath('userData', join(directory, 'profile'));
app.whenReady().then(async () => {
  const log = new AppDiagnostics(join(directory, 'logs'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false } });
  attachWindowDiagnostics(window, log);
  await window.loadURL('data:text/html,<title>Diagnostic smoke</title>');
  await window.webContents.executeJavaScript("console.error('renderer-smoke-example password=private-value'); setTimeout(()=>{throw new Error('renderer-uncaught-example')},0);setTimeout(()=>Promise.reject(new Error('renderer-rejection-example')),0)");
  const deadline = Date.now() + 5000;
  let text;
  do { await new Promise(resolve => setTimeout(resolve, 50)); text = readFileSync(log.file, 'utf8'); }
  while ((!text.includes('renderer-uncaught-example') || !text.includes('renderer-rejection-example')) && Date.now() < deadline);
  assert.match(text, /renderer-console.*renderer-smoke-example/);
  assert.match(text, /renderer-uncaught-example/);
  assert.match(text, /renderer-rejection-example/);
  assert.ok(!text.includes('private-value'));
  window.destroy();
  assert.match(readFileSync(log.file, 'utf8'), /window-closed/);
  log.finish(0);
  console.log('PASS: real renderer console, uncaught exception, rejected promise, redaction and window closure');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  rmSync(directory, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
