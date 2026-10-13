// Test transport only: never contacts a network host or reads SSH credentials.
const { spawn } = require('node:child_process');
if (process.argv.includes('-O')) process.exit(0);
if (process.argv.includes('-M')) { setInterval(() => {}, 1000); }
else {
  const child = spawn('/bin/sh', ['-c', process.argv.at(-1)], { stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.on('SIGTERM', () => { child.kill(); });
}
