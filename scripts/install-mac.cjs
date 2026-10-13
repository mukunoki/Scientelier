const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, realpathSync, lstatSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');
const { build } = require('./package-mac-app.cjs');
const { generatedApp } = require('./build-mac-app.cjs');

function installBundle(bundle, target, project, replace = false) {
  if (lstatSync(bundle).isSymbolicLink()) throw new Error('アプリのリンクはインストールできません。');
  const parent = resolve(target, '..'); mkdirSync(parent, { recursive: true });
  const running = execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n');
  const executable = join(target, 'Contents/MacOS/Electron');
  if (running.some(command => command === executable || command.startsWith(executable + ' ')))
    throw new Error('インストール先のScientelierが起動中です。作業と入力を保存し、通常の終了操作後に再実行してください。');
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error('インストール先がリンクです。上書きしません。');
    const plist = readFileSync(join(target, 'Contents/Info.plist'), 'utf8');
    const owned = generatedApp(target, project) || /<key>ScientelierDistribution<\/key>\s*<true\s*\/>/.test(plist)
      && /<string>local\.agent-harness\.desktop<\/string>/.test(plist);
    if (!owned) throw new Error('同名の別アプリがあります。上書きしません。');
    if (!replace) throw new Error('Scientelierが既にあります。更新する場合は --replace を指定してください。旧アプリは退避します。');
  }
  const stage = mkdtempSync(join(parent, '.scientelier-install-')), staged = join(stage, 'Scientelier.app');
  execFileSync('/usr/bin/ditto', [bundle, staged]);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
  if (existsSync(target)) renameSync(target, join(stage, 'previous-Scientelier.app'));
  try { renameSync(staged, target); }
  catch (error) {
    const previous = join(stage, 'previous-Scientelier.app');
    if (existsSync(previous) && !existsSync(target)) renameSync(previous, target);
    throw error;
  }
  return realpathSync(target);
}

async function install() {
  if (process.platform !== 'darwin') throw new Error('macOS上で実行してください。');
  const project = resolve(__dirname, '..');
  execFileSync('npm', ['run', 'build'], { cwd: project, stdio: 'inherit' });
  if (!process.argv.includes('--skip-ipsj')) {
    const archiveAt = process.argv.indexOf('--ipsj-archive');
    if (archiveAt >= 0 && !process.argv[archiveAt + 1]) throw new Error('--ipsj-archive に公式ZIPのパスを指定してください。');
    await require('./install-ipsj.cjs').install(archiveAt >= 0 ? process.argv[archiveAt + 1] : undefined);
  }
  const { bundle } = build(project);
  const target = installBundle(bundle, join(homedir(), 'Applications', 'Scientelier.app'), project, process.argv.includes('--replace'));
  console.log(`インストールしました: ${target}\nFinderでダブルクリックしてください。ソースフォルダは起動に不要です。\nCLI・TeXは別途用意してください。保存済みデータは移動・削除していません。`);
}
module.exports = { installBundle, install };
if (require.main === module) install().catch(error => { console.error(error.message); process.exitCode = 1; });
