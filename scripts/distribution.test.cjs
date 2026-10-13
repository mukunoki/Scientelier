const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, cpSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { publicSourcePath, trackedFiles, sensitiveFindings } = require('./release-files.cjs');
const { exportSource } = require('./export-public-source.cjs');
const { productionPackages, payloadFiles, copyPayload } = require('./package-mac-app.cjs');
const { bootstrap } = require('./build-mac-app.cjs');
const { installArchive, FILES } = require('./install-ipsj.cjs');
const { runInNewContext } = require('node:vm');

function put(root, file, data = 'fixture') { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scientelier-release-test-'));
  execFileSync('git', ['init', '-q', root]);
  const files = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'src/main.ts', 'src/core/remote-bridge.ts',
    'src/core/sample.test.ts', 'src/renderer/index.html', 'assets/work-skills/reproducibility/SKILL.md',
    'assets/work-presets/coding/preset.json', 'assets/finishing-skills/de-ai-style/SKILL.md',
    'assets/finishing-skills/report-writing-academic/LICENSE', 'assets/ipsj-tech-report/SOURCE.txt',
    'assets/ipsj-tech-report/runtime/ipsj.cls', 'assets/ipsj-tech-report/original/upstream.zip',
    'settings.json', 'reports/paper.pdf', 'experiments/values.csv', '.env', 'logs/cli.log'];
  for (const file of files) put(root, file);
  put(root, 'package.json', JSON.stringify({ version: '0.1.0', dependencies: { library: '1' }, devDependencies: { development: '1' } }));
  execFileSync('git', ['add', '.'], { cwd: root });
  put(root, 'untracked-experiment.txt');
  return root;
}

test('public export keeps presets/rules/notices and excludes tracked data, styles and all Git history', () => {
  const root = fixture(), target = join(root, 'export');
  try {
    exportSource(root, target);
    for (const file of ['assets/work-presets/coding/preset.json', 'assets/finishing-skills/de-ai-style/SKILL.md', 'LICENSE']) assert.ok(existsSync(join(target, file)));
    for (const file of ['.git', '.env', 'settings.json', 'reports', 'experiments', 'logs', 'untracked-experiment.txt', 'assets/ipsj-tech-report/runtime']) assert.equal(existsSync(join(target, file)), false, file);
    assert.throws(() => exportSource(root, target), { code: 'EEXIST' });
    assert.deepEqual(trackedFiles(target), JSON.parse(readFileSync(join(target, 'PUBLIC_SOURCE_MANIFEST.json'))).files, 'snapshot installation cannot inherit the parent private Git tree');
    rmSync(join(target, 'PUBLIC_SOURCE_MANIFEST.json'));
    put(target, 'settings.json', 'local settings');
    assert.ok(trackedFiles(target).includes('src/main.ts'), 'GitHub source ZIP installs without an export manifest');
    assert.equal(trackedFiles(target).includes('settings.json'), false);
    for (const file of ['../README.md', '/etc/passwd', 'src/../settings.ts', 'node_modules/x/a.js', '.ssh/id_rsa', 'data.json']) assert.equal(publicSourcePath(file), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publication refuses symlinks and real key formats without revealing matched values', () => {
  const root = fixture();
  try {
    const secret = 'ghp_' + 'a'.repeat(40); put(root, 'src/main.ts', secret);
    const target = join(root, 'blocked');
    assert.throws(() => exportSource(root, target), error => /credential/.test(error.message) && !error.message.includes(secret));
    assert.equal(existsSync(target), false);
    assert.deepEqual(sensitiveFindings(Buffer.from(secret)), ['credential']);
    rmSync(join(root, 'src/main.ts')); symlinkSync(join(root, 'README.md'), join(root, 'src/main.ts'));
    assert.throws(() => exportSource(root, target), /通常ファイル/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime payload is source-derived, includes dynamic remote helpers, and omits dev dependencies/stale tests', () => {
  const root = fixture();
  try {
    put(root, 'dist/main.js'); put(root, 'dist/core/remote-bridge.js'); put(root, 'dist/core/sample.test.js'); put(root, 'dist/core/obsolete.js');
    put(root, 'node_modules/library/package.json', JSON.stringify({ name: 'library', version: '1', license: 'MIT', dependencies: { child: '1' } }));
    put(root, 'node_modules/library/lib/index.js'); put(root, 'node_modules/library/LICENSE'); put(root, 'node_modules/library/.env', 'private');
    put(root, 'node_modules/child/package.json', JSON.stringify({ name: 'child', version: '1', license: 'MIT' }));
    put(root, 'node_modules/development/package.json', JSON.stringify({ name: 'development', version: '1' }));
    const files = payloadFiles(root);
    assert.ok(files.includes('dist/core/remote-bridge.js'));
    assert.equal(files.includes('dist/core/obsolete.js'), false); assert.equal(files.includes('dist/core/sample.test.js'), false);
    assert.deepEqual(productionPackages(root).map(p => p.manifest.name), ['library', 'child']);
    const payload = join(root, 'payload'); mkdirSync(payload); copyPayload(root, payload);
    assert.ok(existsSync(join(payload, 'node_modules/library/LICENSE')));
    assert.equal(existsSync(join(payload, 'node_modules/library/.env')), false);
    assert.equal(existsSync(join(payload, 'node_modules/development')), false);
    assert.equal(existsSync(join(payload, 'assets/ipsj-tech-report/runtime')), false);
    assert.match(readFileSync(join(payload, 'bootstrap.cjs'), 'utf8'), /const project=__dirname/);
    assert.equal(readFileSync(join(payload, 'bootstrap.cjs'), 'utf8').includes(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('standalone bootstrap has no developer path and remains valid JavaScript', () => {
  const code = bootstrap(undefined, true);
  assert.doesNotThrow(() => new Function(code));
  assert.match(code, /const project=__dirname/);
  assert.match(code, /agent-harness/);
});

test('installer blocks running/unrelated apps and requires explicit recoverable replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'scientelier-install-test-'));
  try {
    const bundle = join(root, 'bundle.app'), target = join(root, 'Applications/Scientelier.app');
    const plist = '<plist><dict><key>CFBundleIdentifier</key><string>local.agent-harness.desktop</string><key>ScientelierDistribution</key><true/></dict></plist>';
    put(bundle, 'Contents/Info.plist', plist); put(bundle, 'Contents/new-marker', 'new app');
    const exported = { exports: {} }; let running = '';
    // Filesystem behaviour is real, signing and ps are deterministic fixtures;
    // never inspect/quit a user's app or install into their Applications folder.
    runInNewContext(readFileSync(join(__dirname, 'install-mac.cjs'), 'utf8'), { __dirname, module: exported, process,
      console, require: id => id === 'node:child_process' ? { execFileSync(command, args) {
        if (command === '/bin/ps') return running;
        if (command === '/usr/bin/ditto') { cpSync(args[0], args[1], { recursive: true }); return ''; }
        if (command === '/usr/bin/codesign') return '';
        throw new Error('unexpected command');
      } } : require(id) });
    const install = exported.exports.installBundle;
    running = join(target, 'Contents/MacOS/Electron');
    assert.throws(() => install(bundle, target, root), /起動中/); assert.equal(existsSync(target), false);
    running = ''; install(bundle, target, root);
    put(target, 'Contents/old-marker', 'old app');
    assert.throws(() => install(bundle, target, root), /--replace/);
    assert.ok(existsSync(join(target, 'Contents/old-marker')));
    install(bundle, target, root, true);
    assert.equal(existsSync(join(target, 'Contents/old-marker')), false);
    const backups = readdirSync(join(root, 'Applications')).filter(f => f.startsWith('.scientelier-install-'));
    assert.ok(backups.some(f => existsSync(join(root, 'Applications', f, 'previous-Scientelier.app/Contents/old-marker'))));
    put(target, 'Contents/Info.plist', '<plist><dict>unrelated app</dict></plist>');
    assert.throws(() => install(bundle, target, root, true), /同名の別アプリ/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('IPSJ acquisition rejects changed archives before touching a user profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'scientelier-ipsj-reject-'));
  try { assert.throws(() => installArchive(Buffer.from('wrong archive'), join(root, 'profile')), /SHA-256/); assert.deepEqual(readdirSync(root), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

const original = join(__dirname, '../assets/ipsj-tech-report/original/ipsj_v4-1.zip');
test('pinned official archive installs outside code and preserves previous template edits', { skip: !existsSync(original) }, () => {
  const root = mkdtempSync(join(tmpdir(), 'scientelier-ipsj-test-'));
  try {
    const target = installArchive(readFileSync(original), root);
    assert.deepEqual(readdirSync(target).sort(), [...FILES, 'SOURCE.json'].sort());
    put(target, 'user-edit.txt', 'preserve'); installArchive(readFileSync(original), root);
    const stages = readdirSync(join(root, 'templates')).filter(f => f.startsWith('.ipsj-install-'));
    assert.ok(stages.some(f => existsSync(join(root, 'templates', f, 'previous-ipsj/user-edit.txt'))));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
