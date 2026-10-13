#!/usr/bin/env node
// Structural checks only: these do not certify meaning, citations or readability.
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.cwd());
const seen = new Set(), ids = new Set(), problems = [];
let frames = 0;
function read(file) {
  const full = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(root, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('TeX include is outside the lesson directory');
  if (seen.has(full)) return;
  seen.add(full);
  if (seen.size > 500 || fs.statSync(full).size > 2 * 1024 * 1024) throw new Error('TeX input exceeds checker limit');
  const text = fs.readFileSync(full, 'utf8');
  for (const match of text.matchAll(/^\s*%\s*lesson-frame:\s*([A-Za-z0-9_-]+)/gm)) {
    if (ids.has(match[1])) problems.push(`Duplicate frame ID: ${match[1]}`);
    ids.add(match[1]);
  }
  const body = text.replace(/(?<!\\)%[^\n]*/g, '');
  frames += [...body.matchAll(/\\begin\{frame\}|\\frame\s*\{/g)].length;
  for (const match of body.matchAll(/\\(?:input|include)\{([^{}]+)\}/g)) {
    if (/[\\#$]/.test(match[1])) { problems.push(`Dynamic include requires manual inspection: ${match[1]}`); continue; }
    let p = path.resolve(path.dirname(full), match[1]);
    if (!path.extname(p)) p += '.tex';
    read(p);
  }
}
try {
  read(process.argv[2] || 'report.tex');
  if (!frames) problems.push('No explicit Beamer frames found');
  if (frames !== ids.size) problems.push(`Frame count ${frames} differs from stable ID count ${ids.size}; inspect generated/macro frames manually`);
  const log = path.resolve(root, (process.argv[2] || 'report.tex').replace(/\.tex$/, '.log'));
  if (fs.existsSync(log)) {
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) if (/Overfull \\[hv]box|Missing character|undefined references|LaTeX Warning: (Reference|Citation).*undefined/.test(line)) problems.push(line.trim());
  } else problems.push('Build log missing: compile first');
  console.log(JSON.stringify({frames, stableIds: ids.size, files: seen.size, problems, limits: 'Structural checks only; original sources, terms, numbers and ALL rendered pages still require review.'}, null, 2));
  process.exitCode = problems.length ? 1 : 0;
} catch (e) { console.error(String(e)); process.exitCode = 1; }
