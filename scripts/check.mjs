import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
async function run(command, args, timeout = 180000) {
  console.log('Checking:', command, ...args);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, timeout,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('Check failed: ' + (signal || code))));
  });
}
await run(process.execPath, ['scripts/build.mjs', '--check']);
await run(process.execPath, ['scripts/verify-html.mjs']);
const tests = fs.readdirSync(new URL('../tests/', import.meta.url)).filter(n => n.endsWith('.test.cjs')).sort();
await run(process.execPath, ['--test', ...tests.map(n => 'tests/' + n)]);
if (!process.argv.includes('--skip-python')) await run(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test*.py', '-v']);
if (process.argv.includes('--browser')) await run(process.execPath, ['tests/browser-smoke.mjs']);
