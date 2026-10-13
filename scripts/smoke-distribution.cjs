// Native Electron smoke using ONLY the packaged runtime. Fresh profile, no real
// CLI discovery/login, model calls, SSH, template download or user task access.
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdtempSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
if (!process.argv[2]) throw new Error('npm run test:distribution-ui -- /absolute/path/Scientelier.app を指定してください。');
const bundle = resolve(process.argv[2]), entry = join(bundle, 'Contents/Resources/app');
const directory = mkdtempSync(join(tmpdir(), 'scientelier-standalone-smoke-'));
process.env.SCIENTELIER_DATA_DIR = join(directory, 'profile');
global.fetch = async () => { throw new Error('network disabled in distribution smoke'); };
require(join(entry, 'dist/core/cli-detect.js')).detectAgents = async () => [];
require(join(entry, 'dist/core/report-service.js')).checkReportEnvironment = async () => ({ tex: { ok: false }, plot: { ok: false }, checkedAt: new Date().toISOString() });
require(join(entry, 'dist/core/benchmark-store.js')).BenchmarkStore.prototype.refresh = async function () { return this.snapshot(); };
const handlers = new Map(), handle = ipcMain.handle.bind(ipcMain), errors = [];
ipcMain.handle = (name, fn) => { handlers.set(name, fn); handle(name, fn); };
app.on('browser-window-created', (_event, window) => {
  window.hide();
  window.webContents.on('console-message', (_e, ...args) => {
    const level = typeof args[0] === 'object' ? args[0].level : args[0];
    const message = typeof args[0] === 'object' ? args[0].message : args[1];
    if (level === 'error' || level === 3) errors.push(message);
  });
});
function fixturePdf() {
  const stream = 'BT /F1 12 Tf 20 70 Td (Standalone PDF preview) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(x => String(x).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return [...Buffer.from(pdf)];
}
async function until(fn, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function verify() {
  await until(() => handlers.has('app:snapshot') && BrowserWindow.getAllWindows()[0]?.webContents.getURL(), 'packaged main startup');
  const window = BrowserWindow.getAllWindows()[0];
  await until(() => window.webContents.executeJavaScript(`!!window.harness && !!document.querySelector('#task-list')`), 'packaged preload and renderer');
  const snapshot = await window.webContents.executeJavaScript('window.harness.getSnapshot()');
  assert.equal(snapshot.tasks.length, 0); assert.equal(snapshot.remoteSystems.length, 0); assert.equal(snapshot.agents.length, 0);
  assert.ok(snapshot.workPresets.presets.length >= 8);
  assert.deepEqual(snapshot.workPresets.errors, []);
  assert.equal(app.getPath('userData'), process.env.SCIENTELIER_DATA_DIR);
  assert.equal(snapshot.reportSettings.outputDirectory, join(process.env.SCIENTELIER_DATA_DIR, 'reports'));
  assert.equal(decodeURIComponent(window.webContents.getURL()).includes(entry), true);
  assert.equal(existsSync(join(entry, 'assets/ipsj-tech-report/runtime')), false);
  const runner = new (require(join(entry, 'dist/core/terminal-runner.js')).TerminalRunner)();
  const result = await runner.run('packaged-pty', { command: '/bin/sh', args: ['-c', 'printf standalone-pty-ok'], cwd: directory }, () => {});
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /standalone-pty-ok/); runner.shutdown();
  const preload = join(directory, 'pdf-preload.cjs');
  writeFileSync(preload, `require('electron').contextBridge.exposeInMainWorld('harness',{readReportPdf:async()=>new Uint8Array(${JSON.stringify(fixturePdf())})});`);
  const pdfWindow = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await pdfWindow.loadFile(join(entry, 'src/renderer/pdf-viewer.html'), { query: { task: 'fixture' } });
  await until(() => pdfWindow.webContents.executeJavaScript(`document.querySelector('#total')?.textContent === '1' && !!document.querySelector('.page canvas')`), 'packaged PDF.js rendering');
  pdfWindow.destroy();
  assert.deepEqual(errors, [], 'no packaged preload/renderer/PDF dependency errors');
  const manifest = JSON.parse(readFileSync(join(entry, 'DISTRIBUTION_MANIFEST.json')));
  assert.ok(manifest.files.every(f => !/\.test\.js$|ipsj-tech-report\/(runtime|original)|settings\.json|tasks\.json/.test(f.file)));
  console.log('Standalone smoke passed: fresh profile, presets/rules, packaged main/preload/UI, native PTY and PDF rendering. No user data or accounts used.');
  app.quit();
}
const deadline = setTimeout(() => { console.error('Distribution smoke timeout'); app.exit(1); }, 45_000);
app.on('will-quit', () => clearTimeout(deadline));
require(join(entry, 'bootstrap.cjs'));
verify().catch(error => { console.error(error.stack); app.exit(1); });
