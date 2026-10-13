// Run from a clone or public source snapshot. No accounts/CLIs are installed,
// no SSH is opened and no task runs as part of setup.
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) {
  console.error('macOSとNode.js 24以上が必要です。docs/installation.mdを参照してください。'); process.exitCode = 1;
} else {
  try {
    execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' });
    const project = resolve(__dirname, '..');
    execFileSync('npm', ['ci'], { cwd: project, stdio: 'inherit' });
    execFileSync(process.execPath, [resolve(__dirname, 'install-mac.cjs'), ...process.argv.slice(2)], { cwd: project, stdio: 'inherit' });
  } catch (error) {
    console.error('インストールを完了できませんでした。Node.js・Command Line Tools・ネット接続を確認してください。既存データは削除していません。');
    process.exitCode = error.status || 1;
  }
}
