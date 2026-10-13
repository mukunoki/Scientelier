// Acquire upstream styles for this user's installation, not for redistribution.
// A pinned archive and selected regular entries avoid arbitrary ZIP extraction.
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, renameSync, lstatSync } = require('node:fs');
const { join, resolve, isAbsolute } = require('node:path');
const { homedir, tmpdir } = require('node:os');
const URL = 'https://www.ipsj.or.jp/journal/submit/9faeag0000001nsz-att/ipsj_v4-1.zip';
const SHA256 = '99a165ea4e7bccb0ab54a2b9c1f21d19d77744876a20708ee37ec954d00ebc59';
const FILES = ['ipsj.cls', 'ipsjtech.sty', 'ipsjpref.sty', 'ipsjsort.bst', 'ipsjunsrt.bst', 'ipsjsort-e.bst', 'ipsjunsrt-e.bst', 'bibsample.bib', 'tech-jsample.tex'];

function dataDirectory() {
  if (process.env.SCIENTELIER_DATA_DIR !== undefined) {
    if (!isAbsolute(process.env.SCIENTELIER_DATA_DIR)) throw new Error('SCIENTELIER_DATA_DIR は絶対パスで指定してください。');
    return resolve(process.env.SCIENTELIER_DATA_DIR);
  }
  return join(homedir(), 'Library', 'Application Support', 'agent-harness');
}

async function download() {
  const response = await fetch(URL, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!response.ok) throw new Error(`IPSJ公式配布の取得に失敗しました（HTTP ${response.status}）。--archive で公式ZIPを指定できます。`);
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 5 * 1024 * 1024) throw new Error('IPSJ配布ZIPが想定サイズを超えています。');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

function installArchive(buffer, data) {
  if (createHash('sha256').update(buffer).digest('hex') !== SHA256)
    throw new Error('IPSJ配布ZIPのSHA-256が一致しません。上流更新・破損の可能性があります。検証を無効にせず確認してください。');
  const parent = join(data, 'templates'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()) throw new Error('テンプレート保存先が通常のディレクトリではありません。');
  const stage = mkdtempSync(join(parent, '.ipsj-install-')), zip = join(stage, 'upstream.zip'), prepared = join(stage, 'ipsj');
  writeFileSync(zip, buffer, { mode: 0o600 }); mkdirSync(prepared, { mode: 0o700 });
  for (const file of FILES) {
    const bytes = execFileSync('/usr/bin/unzip', ['-p', zip, `ipsj_v4-1/UTF8/${file}`], { maxBuffer: 1024 * 1024 });
    if (!bytes.length) throw new Error(`IPSJテンプレートが空です: ${file}`);
    writeFileSync(join(prepared, file), bytes, { mode: 0o600 });
  }
  writeFileSync(join(prepared, 'SOURCE.json'), JSON.stringify({ url: URL, sha256: SHA256, files: FILES }, null, 2) + '\n', { mode: 0o600 });
  const target = join(parent, 'ipsj');
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) throw new Error('IPSJ保存先が通常のディレクトリではありません。上書きしません。');
    renameSync(target, join(stage, 'previous-ipsj')); // preserve user edits/recovery
  }
  renameSync(prepared, target);
  return target;
}

async function install(archive) {
  if (process.platform !== 'darwin') throw new Error('このインストーラはmacOS用です。');
  const data = dataDirectory();
  // Shared invariant with the running app; never put runtime data into code.
  const { runtimePaths } = require('../dist/core/runtime-paths.js');
  runtimePaths(join(homedir(), 'Library', 'Application Support'), join(homedir(), 'Documents'), resolve(__dirname, '..'), data);
  return installArchive(archive ? readFileSync(resolve(archive)) : await download(), data);
}

module.exports = { install, installArchive, URL, SHA256, FILES };
if (require.main === module) {
  const index = process.argv.indexOf('--archive');
  if (index >= 0 && !process.argv[index + 1]) { console.error('--archive の後に公式ZIPのパスを指定してください。'); process.exitCode = 1; }
  else install(index >= 0 ? process.argv[index + 1] : undefined).then(path => console.log(`IPSJテンプレートを個人データ領域へ保存しました: ${path}\nこのテンプレートを配布物や公開Gitへ追加しないでください。`), error => { console.error(error.message); process.exitCode = 1; });
}
