const { mkdirSync, copyFileSync, chmodSync, writeFileSync, mkdtempSync } = require('node:fs');
const { resolve, join, dirname } = require('node:path');
const { publicSourcePath, trackedFiles, checkedFile, checkFiles } = require('./release-files.cjs');

function exportSource(project = resolve(__dirname, '..'), destination) {
  const tracked = trackedFiles(project), files = tracked.filter(publicSourcePath);
  const findings = checkFiles(project, files);
  if (findings.length) throw new Error(`公開前に確認が必要です（値は非表示）:\n${findings.map(f => `${f.kind}: ${f.file}`).join('\n')}`);
  // mkdir without recursive/existing permission: never merge into a dirty tree
  // or overwrite someone else's source/data directory.
  let output;
  if (destination) { output = resolve(destination); mkdirSync(output); }
  else { const releases = join(project, 'release'); mkdirSync(releases, { recursive: true }); output = mkdtempSync(join(releases, 'source-')); }
  for (const file of files) {
    const { path, info } = checkedFile(project, file), target = join(output, file);
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(path, target);
    chmodSync(target, info.mode & 0o111 ? 0o755 : 0o644);
  }
  writeFileSync(join(output, 'PUBLIC_SOURCE_MANIFEST.json'), JSON.stringify({ format: 1,
    description: 'Source snapshot without Git history or local runtime data. Review before publication.',
    files, excludedCount: tracked.filter(f => !publicSourcePath(f)).length }, null, 2) + '\n');
  return output;
}

module.exports = { exportSource };
if (require.main === module) {
  try { console.log(`公開用ソースを書き出しました: ${exportSource(undefined, process.argv[2])}\n公開・Git初期化・アップロードは行っていません。`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
