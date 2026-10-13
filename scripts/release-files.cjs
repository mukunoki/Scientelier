// Publication is an allowlist, not a recursive copy of the developer's folder.
// Git-ignored data, untracked experiments and previous .app builds never enter it.
const { execFileSync } = require('node:child_process');
const { lstatSync, readFileSync, realpathSync, existsSync, readdirSync } = require('node:fs');
const { join, relative, isAbsolute } = require('node:path');
const { homedir } = require('node:os');

const rootFiles = new Set(['.gitattributes', '.gitignore', 'AGENTS.md', 'README.md', 'LICENSE',
  'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'tsconfig.renderer.json', '現行版を起動.command', 'インストール.command']);

function publicSourcePath(file) {
  if (!file || file.includes('\\') || isAbsolute(file) || file.split('/').some(p => p === '..' || p.startsWith('.') && p !== '.github')) {
    return rootFiles.has(file);
  }
  if (rootFiles.has(file)) return true;
  // IPSJ has no explicit redistribution grant in the downloaded archive. Keep
  // the source description and acquisition tool, not upstream binaries/styles.
  if (file === 'assets/ipsj-tech-report/SOURCE.txt') return true;
  if (/^(src|scripts)\//.test(file)) return /\.(ts|cjs|mjs|html|css)$/.test(file);
  if (/^docs\//.test(file)) return /\.(md|tex)$/.test(file);
  if (/^\.github\/workflows\//.test(file)) return /\.ya?ml$/.test(file);
  if (/^assets\/(work-presets|work-skills|finishing-skills|document-templates|opencode)\//.test(file)) {
    return /\.(md|json|tex|cjs|mjs|txt)$/.test(file) || /\/LICENSE$/.test(file) || file.endsWith('/latexmkrc');
  }
  return /^assets\/macos\/(app-icon\.png|icon\.m)$/.test(file);
}

function runtimeAssetPath(file) {
  return file.startsWith('assets/') && publicSourcePath(file);
}

function trackedFiles(project) {
  // A public snapshot has no .git. Also avoid accidentally using a parent's
  // private repository when installing a snapshot nested inside that checkout.
  let root;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: project, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim(); } catch { /* source ZIP */ }
  if (!root || realpathSync(root) !== realpathSync(project)) {
    const manifestPath = join(project, 'PUBLIC_SOURCE_MANIFEST.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.every(f => typeof f === 'string' && publicSourcePath(f)))
        throw new Error('公開用ソースのファイル一覧が不正です。');
      return manifest.files;
    }
    if (existsSync(join(project, '.git'))) throw new Error('このリポジトリのGit追跡一覧を確認できません。Gitを確認してください。');
    // GitHub's Download ZIP has neither .git nor our export manifest. Inspect
    // only the named source roots and the same allowlist, never the whole folder.
    const files = [];
    function visit(file) {
      if (!existsSync(join(project, file))) return;
      const info = lstatSync(join(project, file));
      if (info.isSymbolicLink()) throw new Error(`公開ソースのリンクは使用できません: ${file}`);
      if (info.isDirectory()) for (const name of readdirSync(join(project, file))) visit(`${file}/${name}`);
      else if (info.isFile() && publicSourcePath(file)) files.push(file);
    }
    for (const file of [...rootFiles, 'src', 'scripts', 'docs', 'assets', '.github']) visit(file);
    return files;
  }
  return execFileSync('git', ['ls-files', '-z'], { cwd: project }).toString('utf8').split('\0').filter(Boolean);
}

function checkedFile(project, file) {
  const path = join(project, file), info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`通常ファイル以外は配布できません: ${file}`);
  const rel = relative(realpathSync(project), realpathSync(path));
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error(`プロジェクト外のファイルです: ${file}`);
  return { path, info };
}

// High-confidence credential formats only. Never print matching secret text.
// This is a safety check, not a guarantee about arbitrary proprietary content.
function sensitiveFindings(buffer) {
  if (buffer.includes(0)) return [];
  const text = buffer.toString('utf8'), found = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text)) found.push('private-key');
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{40,}|AKIA[A-Z0-9]{16})\b/.test(text)) found.push('credential');
  if (text.includes(homedir() + '/') || /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/.test(text)) found.push('private-environment');
  return found;
}

function checkFiles(project, files) {
  const findings = [];
  for (const file of files) {
    const { path } = checkedFile(project, file);
    for (const kind of sensitiveFindings(readFileSync(path))) findings.push({ file, kind });
  }
  return findings;
}

module.exports = { publicSourcePath, runtimeAssetPath, trackedFiles, checkedFile, sensitiveFindings, checkFiles };
