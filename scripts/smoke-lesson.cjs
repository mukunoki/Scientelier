// Build and render only the bundled scaffold; no user task or model invocation.
const {execFileSync} = require('node:child_process');
const {join} = require('node:path');
const {mkdirSync, copyFileSync, readFileSync} = require('node:fs');
const assert = require('node:assert/strict');
const root = join(__dirname, '..', 'output', 'pdf', 'lesson-template-smoke');
mkdirSync(root, {recursive: true});
const cache = join(root, 'tex-cache'); mkdirSync(cache, {recursive:true});
for (const [from, to] of [['main.tex','report.tex'],['check-lesson.cjs','check-lesson.cjs']]) copyFileSync(join(__dirname,'..','assets/document-templates/beamer',from),join(root,to));
try { execFileSync('/Library/TeX/texbin/latexmk',['-g','-lualatex','-interaction=nonstopmode','-halt-on-error','report.tex'],{cwd:root,env:{...process.env,TEXMFCACHE:cache,TEXMFVAR:cache,PATH:`/Library/TeX/texbin:${process.env.PATH}`},stdio:'pipe'}); }
catch (e) { console.error(e.stdout?.toString(),e.stderr?.toString()); throw e; }
const info = execFileSync('pdfinfo',[join(root,'report.pdf')],{encoding:'utf8'});
assert.match(info,/Pages:\s+3\b/);
const [,w,h] = info.match(/Page size:\s+([\d.]+) x ([\d.]+)/);
assert.ok(Math.abs(Number(w)/Number(h)-16/9)<0.01);
assert.doesNotMatch(readFileSync(join(root,'report.log'),'utf8'),/Overfull|Missing character|undefined references/);
execFileSync(process.execPath,['check-lesson.cjs','report.tex'],{cwd:root,stdio:'inherit'});
execFileSync('pdftoppm',['-scale-to','1300','-png',join(root,'report.pdf'),join(root,'preview')]);
console.log('Beamer: 3 pages, 16:9, structural checks passed, all pages rendered.');
