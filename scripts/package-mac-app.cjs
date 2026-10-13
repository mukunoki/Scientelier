// Standalone distribution. Do not use a whole-checkout copy, git archive, or
// electron-packager's default directory glob: private files can live nearby.
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync, lstatSync, existsSync, realpathSync, chmodSync } = require('node:fs');
const { join, resolve, dirname, relative, isAbsolute } = require('node:path');
const { createHash } = require('node:crypto');
const { trackedFiles, publicSourcePath, runtimeAssetPath, checkedFile, checkFiles } = require('./release-files.cjs');
const { appPlist, bootstrap } = require('./build-mac-app.cjs');

function compatible(value, current) {
  return !value || (!value.includes('!' + current) && (value.every(x => x.startsWith('!')) || value.includes(current) || value.includes('any')));
}

function productionPackages(project) {
  project = realpathSync(project);
  const found = new Map();
  function visit(name, from, optional = false) {
    const search = require('node:module').createRequire(join(from, 'package.json')).resolve.paths(name) || [];
    const directory = search.map(p => join(p, name)).find(p => existsSync(join(p, 'package.json')));
    if (!directory) { if (optional) return; throw new Error(`実行依存ライブラリがありません: ${name}。npm ci を実行してください。`); }
    const actual = realpathSync(directory), location = relative(project, actual);
    if (isAbsolute(location) || location.startsWith('..') || !location.startsWith('node_modules/')) throw new Error(`プロジェクト外の依存は同梱できません: ${name}`);
    if (found.has(actual)) return;
    const manifest = JSON.parse(readFileSync(join(actual, 'package.json'), 'utf8'));
    if (!compatible(manifest.os, process.platform) || !compatible(manifest.cpu, process.arch)) return;
    found.set(actual, { directory: actual, location, manifest });
    for (const dependency of Object.keys(manifest.dependencies || {})) visit(dependency, actual, Object.hasOwn(manifest.optionalDependencies || {}, dependency));
    for (const dependency of Object.keys(manifest.optionalDependencies || {})) visit(dependency, actual, true);
  }
  for (const name of Object.keys(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).dependencies)) visit(name, project);
  return [...found.values()];
}

function copyPackage(source, target, subpath = '') {
  const info = lstatSync(source);
  if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error(`依存ライブラリに通常ファイル以外があります: ${subpath}`);
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      if (name.startsWith('.') || ['node_modules', 'test', 'tests', 'coverage'].includes(name)) continue;
      if (subpath === 'prebuilds' && name !== `${process.platform}-${process.arch}`) continue;
      copyPackage(join(source, name), join(target, name), subpath ? `${subpath}/${name}` : name);
    }
  } else {
    if (/\.(log|tsbuildinfo)$/.test(source)) return;
    copyFileSync(source, target); chmodSync(target, info.mode & 0o111 ? 0o755 : 0o644);
  }
}

function payloadFiles(project) {
  const tracked = trackedFiles(project);
  const sources = tracked.filter(f => runtimeAssetPath(f) || /^src\/renderer\/[^/]+\.(html|css|mjs)$/.test(f)
    || f.startsWith('docs/') && publicSourcePath(f) || f === 'scripts/antigravity-status.cjs'
    || ['LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'README.md'].includes(f));
  // Derive compiled filenames from actual tracked source, excluding tests and
  // stale tsc output. Remote helpers are included even when imported dynamically.
  const compiled = tracked.filter(f => /^src\//.test(f) && f.endsWith('.ts') && !/\.(test|d)\.ts$/.test(f))
    .map(f => f.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'));
  return [...new Set([...sources, ...compiled])];
}

function copyPayload(project, entry) {
  const files = payloadFiles(project), findings = checkFiles(project, files);
  if (findings.length) throw new Error(`配布ファイルに確認が必要です: ${findings.map(f => `${f.kind}: ${f.file}`).join(', ')}（値は非表示）`);
  for (const file of files) {
    const { path } = checkedFile(project, file), target = join(entry, file);
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(path, target);
  }
  const dependencies = productionPackages(project);
  for (const pkg of dependencies) copyPackage(pkg.directory, join(entry, pkg.location));
  const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  writeFileSync(join(entry, 'package.json'), JSON.stringify({ name: 'agent-harness', productName: 'Scientelier', version: pkg.version, main: 'bootstrap.cjs' }, null, 2));
  // Relative path only: the bundle must run after the original checkout moves.
  writeFileSync(join(entry, 'bootstrap.cjs'), bootstrap(undefined, true));
  writeFileSync(join(entry, 'DEPENDENCY_NOTICES.json'), JSON.stringify(dependencies.map(p => ({ name: p.manifest.name, version: p.manifest.version, license: p.manifest.license })), null, 2) + '\n');
  const hashes = files.map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(entry, file))).digest('hex') }));
  writeFileSync(join(entry, 'DISTRIBUTION_MANIFEST.json'), JSON.stringify({ format: 1, version: pkg.version, platform: process.platform, arch: process.arch, files: hashes }, null, 2) + '\n');
  return files;
}

function build(project = resolve(__dirname, '..')) {
  if (process.platform !== 'darwin') throw new Error('macOS上でビルドしてください。');
  const output = join(project, 'release'); mkdirSync(output, { recursive: true });
  const stage = mkdtempSync(join(output, 'mac-')), bundle = join(stage, 'Scientelier.app'), contents = join(bundle, 'Contents');
  execFileSync('/usr/bin/ditto', [join(project, 'node_modules/electron/dist/Electron.app'), bundle]);
  const entry = join(contents, 'Resources', 'app'); mkdirSync(entry);
  copyPayload(project, entry);
  const version = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version;
  // Reuse native Electron startup keys but never encode the developer's path.
  const plist = appPlist('', version, readFileSync(join(contents, 'Info.plist'), 'utf8'))
    .replace(/<key>AgentHarnessProjectPath<\/key><string>[^<]*<\/string>\s*/, '')
    .replace('</dict></plist>', '<key>ScientelierDistribution</key><true/>\n</dict></plist>');
  writeFileSync(join(contents, 'Info.plist'), plist);
  const tool = join(stage, 'make-icon'), iconset = join(stage, 'Scientelier.iconset'); mkdirSync(iconset);
  execFileSync('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', join(project, 'assets/macos/icon.m'), '-o', tool]);
  execFileSync(tool, [iconset]);
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(contents, 'Resources', 'Scientelier.icns')]);
  execFileSync('/usr/bin/plutil', ['-lint', join(contents, 'Info.plist')]);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', bundle], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  const zip = join(stage, `Scientelier-${version}-mac-${process.arch}.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip]);
  console.log(`単独起動できる配布版: ${bundle}\nZIP: ${zip}\n個人設定・タスク・実験・履歴は同梱していません。署名は開発用（未公証）です。`);
  return { bundle, zip };
}

module.exports = { productionPackages, payloadFiles, copyPayload, build };
if (require.main === module) { try { build(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
