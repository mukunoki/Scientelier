const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { trackedFiles, publicSourcePath, checkFiles, sensitiveFindings } = require('./release-files.cjs');

function audit(project, history = false) {
  const files = trackedFiles(project), included = files.filter(publicSourcePath);
  const findings = checkFiles(project, included);
  const excluded = files.filter(f => !publicSourcePath(f));
  console.log(`公開対象 ${included.length}ファイル。除外対象 ${excluded.length}ファイル（IPSJ原配布を含む）。`);
  for (const f of findings) console.error(`${f.kind}: ${f.file}（値は非表示）`);
  let historyFindings = 0;
  if (history) {
    const objects = execFileSync('git', ['rev-list', '--objects', '--all'], { cwd: project, maxBuffer: 32 * 1024 * 1024 }).toString('utf8').trim().split('\n');
    // Batch-reading blobs audits all reachable branches without displaying
    // source/credentials or changing/refiltering the original Git history.
    const metadata = execFileSync('git', ['cat-file', '--batch-check'], { cwd: project, input: objects.map(x => x.split(' ')[0]).join('\n') + '\n', maxBuffer: 32 * 1024 * 1024 }).toString('utf8').trim().split('\n');
    const blobs = metadata.map((line, i) => ({ line: line.split(' '), name: objects[i].slice(objects[i].indexOf(' ') + 1) })).filter(x => x.line[1] === 'blob');
    for (const blob of blobs) {
      const buffer = execFileSync('git', ['cat-file', 'blob', blob.line[0]], { cwd: project, maxBuffer: 16 * 1024 * 1024 });
      const kinds = sensitiveFindings(buffer);
      if (!publicSourcePath(blob.name)) kinds.push('excluded-history');
      if (kinds.length) { historyFindings++; console.error(`履歴 ${blob.line[0].slice(0, 10)}: ${blob.name} [${kinds.join(', ')}]（値は非表示）`); }
    }
    console.log(`履歴の確認対象: ${blobs.length} blob。確認が必要: ${historyFindings}。コミット作者名・メールは別途確認してください。`);
  }
  return findings.length === 0 && historyFindings === 0;
}
module.exports = { audit };
if (require.main === module) {
  try { if (!audit(resolve(__dirname, '..'), process.argv.includes('--history'))) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
