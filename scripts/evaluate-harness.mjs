/* Deterministic fault evaluations. No local model or network connection is needed. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const started = performance.now();
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/reliability.test.cjs', 'tests/verification-journal.test.cjs', 'tests/harness.test.cjs', 'tests/conversations.test.cjs'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', windowsHide: true, timeout: 60000
});
if (result.error) throw result.error;
const lines = result.stdout.split(/\r?\n/), cases = [];
for (let i = 0; i < lines.length; i++) {
  const match = /^(not ok|ok) \d+ - (.+)$/.exec(lines[i]);
  if (!match) continue;
  const duration = /duration_ms: ([\d.]+)/.exec(lines.slice(i + 1, i + 5).join('\n'));
  cases.push({ scenario: match[2], verified: match[1] === 'ok', elapsedMs: Number(duration?.[1]) || 0 });
}
const report = { version: 1, kind: 'deterministic_harness_faults', created: new Date().toISOString(),
  verified: result.status === 0 && cases.length > 0, verifiedRate: cases.length ? cases.filter(c => c.verified).length / cases.length : 0,
  elapsedMs: performance.now() - started, cases };
const index = process.argv.indexOf('--output');
if (index >= 0) {
  if (!process.argv[index + 1]) throw new Error('--output requires a JSON file path');
  fs.writeFileSync(process.argv[index + 1], JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
if (!report.verified) { process.stderr.write(result.stderr); process.stderr.write(result.stdout); process.exitCode = 1; }
