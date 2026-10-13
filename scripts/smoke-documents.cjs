// Build the bundled drafts only; never run a user task or call an LLM.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync, copyFileSync, readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
for (const id of ['paper', 'poster']) {
  const directory = join(__dirname, '..', 'output', 'pdf', `${id}-template-smoke`);
  mkdirSync(directory, { recursive: true });
  copyFileSync(join(__dirname, '..', 'assets', 'document-templates', id, 'main.tex'), join(directory, 'main.tex'));
  copyFileSync(join(__dirname, '..', 'assets', 'document-templates', 'latexmkrc'), join(directory, '.latexmkrc'));
  execFileSync('/Library/TeX/texbin/latexmk', ['-g', '-lualatex', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: directory, env: { ...process.env, PATH: `/Library/TeX/texbin:${process.env.PATH}` }, stdio: 'pipe' });
  const info = execFileSync('pdfinfo', [join(directory, 'main.pdf')], { encoding: 'utf8' });
  assert.match(info, /Pages:\s+1\b/);
  const [, width, height] = info.match(/Page size:\s+([\d.]+) x ([\d.]+)/);
  const expected = id === 'paper' ? [210, 297] : [841, 1189];
  assert.ok(Math.abs(Number(width) * 25.4 / 72 - expected[0]) < 1);
  assert.ok(Math.abs(Number(height) * 25.4 / 72 - expected[1]) < 1);
  assert.doesNotMatch(readFileSync(join(directory, 'main.log'), 'utf8'), /Overfull|Missing character|undefined references/);
  execFileSync('pdftoppm', ['-scale-to', '1600', '-png', '-singlefile', join(directory, 'main.pdf'), join(directory, 'preview')]);
  console.log(`${id}: one page, ${expected.join(' x ')} mm, no overflow or missing characters`);
}
