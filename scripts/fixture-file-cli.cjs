// Offline Antigravity stand-in. Writes a scoped result, then a prose-only
// notification, so the remote workflow must actually collect the result file.
const { execFileSync } = require('node:child_process');
const { dirname, join } = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('antigravity-fixture 1.0'); process.exit(0); }
// Offline transport fixture: hold all work/results until the SAME native trust
// prompt used by Antigravity receives Enter over the real foreground PTY.
if (!process.stdin.isTTY) throw new Error('Expected an interactive fixture PTY');
process.stdin.setRawMode(true);
process.stdin.resume();
const cwd = require('node:fs').realpathSync(process.cwd());
process.stdout.write('\x1b[2J\x1b[HAccessing workspace:\r\n\r\n' + cwd +
  '\r\n\r\nDo you trust the contents of this project?\r\n\r\n' +
  'Antigravity CLI requires permission to read, edit, and execute files here.\r\n\r\n' +
  '> Yes, I trust this folder\r\n  No, exit\r\n\r\n  ↑/↓ Navigate · enter Confirm\r\n');
process.stdin.once('data', data => {
  if (data.toString() !== '\r') throw new Error('Unexpected fixture trust input');
  process.stdout.write('\x1b[2J\x1b[HFixture folder trusted. Starting work.\r\n');
  submit();
});

function submit() {
  const launchPrompt = args[args.indexOf('--prompt-interactive') + 1];
  const instructionPath = launchPrompt.match(/Instructions file: (.+)/);
  const prompt = instructionPath ? require('node:fs').readFileSync(JSON.parse(instructionPath[1]), 'utf8') : launchPrompt;
  if (!prompt.includes('# Result transport override (file-based CLI') || !prompt.includes('--submit')) throw new Error('No file result protocol');
  const path = prompt.match(/Notification file: ([^\n]+)/)[1];
  const token = prompt.match(/Completion token: ([^\n]+)/)[1];
  const draft = {objective:'遠隔ファイル通知を検証する',deliverables:['TeXとPDF'],criteria:[{id:'result',description:'保存した結果を回収する',verification:'ファイルを検証',required:true}],constraints:[],outOfScope:[],questions:[]};
  execFileSync(process.execPath,[join(dirname(path),'result-channel.js'),dirname(path),token,'--submit'],{
    input:'<goal-draft>'+JSON.stringify(draft)+'</goal-draft>',stdio:['pipe','pipe','pipe']
  });
  execFileSync(process.execPath,[join(dirname(path),'result-channel.js'),dirname(path),token,'--finish'],{
    input:'結果を提出しました。',stdio:['pipe','pipe','pipe']
  });
  process.stdout.write('File result submitted. Waiting for managed retirement.\r\n');
}
