import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const check = process.argv.includes('--check');
const write = (path, text) => {
  const url = new URL('../' + path, import.meta.url);
  if (check) {
    if (fs.readFileSync(url, 'utf8') !== text) throw new Error(path + ' is stale; run node scripts/build.mjs');
  } else fs.writeFileSync(url, text);
};
const replaceOnce = (text, marker, value) => {
  if (!text.includes(marker) || text.indexOf(marker) !== text.lastIndexOf(marker)) throw new Error('Missing or duplicate build marker: ' + marker);
  return text.replace(marker, () => value);
};
// Compile CSS during the build, including classes in dynamically rendered UI.
// With no output argument the CLI writes CSS to stdout, so --check stays read-only.
let tailwindCli;
try { tailwindCli = require.resolve('tailwindcss/lib/cli.js'); }
catch { throw new Error('Build dependency missing; run npm ci before building SlopLobster.'); }
const cssBuild = spawnSync(process.execPath, [tailwindCli, '--config', 'tailwind.config.cjs', '--input', 'src/tailwind.css', '--minify'], {
  cwd: root, encoding: 'utf8', windowsHide: true,
});
if (cssBuild.error || cssBuild.status !== 0) throw new Error('Tailwind build failed: ' + (cssBuild.error?.message || cssBuild.stderr));
write('vendor/tailwind.min.css', cssBuild.stdout.trim() + '\n');
let companion = read('SlopLobster-companion.py');
const features = ['companion-features.py', 'companion-services.py'].map(name => read('src/' + name)).join('\n');
const backendPattern = /# BEGIN GENERATED FEATURES[\s\S]*?# END GENERATED FEATURES\n/;
if (!backendPattern.test(companion)) throw new Error('Companion features marker missing');
companion = companion.replace(backendPattern, () => '# BEGIN GENERATED FEATURES\n' + features + '\n# END GENERATED FEATURES\n');
write('SlopLobster-companion.py', companion);
const modules = ['backend-core.js', 'harness-core.js', 'mutation-core.js', 'harness-runtime.js', 'run-state.js', 'model-stream.js', 'verification-core.js', 'journal-core.js', 'companion-client.js', 'companion-pairing.js', 'features-core.js', 'swarm-core.js', 'features-ui.js', 'journal-ui.js', 'verification-ui.js', 'harness-services.js', 'shell-services.js', 'model-client.js', 'agent-loop.js'];
const benchmark = JSON.stringify(JSON.parse(read('tests/fixtures/coding-benchmark.json')), null, 2).replace(/</g, '\\u003c');
const runtime = modules.map(name => {
  const source = read('src/' + name);
  return name === 'features-ui.js' ? replaceOnce(source, 'const HARNESS_DEFAULT_BENCHMARK = {}; // Embedded by scripts/build.mjs.', 'const HARNESS_DEFAULT_BENCHMARK = ' + benchmark + ';') : source;
}).join('\n');
if (/<\/script/i.test(runtime)) throw new Error('Runtime contains an unsafe closing script tag');
const escaped = companion.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/</g, '\\x3c');
const app = replaceOnce(read('src/app.js'), 'const COMPANION_SCRIPT = ""; // Embedded by scripts/build.mjs.', 'const COMPANION_SCRIPT = `' + escaped + '`;');
let html = replaceOnce(read('src/ui.html'), '<!-- GENERATED HARNESS RUNTIME -->', '<!-- BEGIN GENERATED HARNESS RUNTIME -->\n<script>\n' + runtime + '\n</script>\n<!-- END GENERATED HARNESS RUNTIME -->');
html = replaceOnce(html, '/* GENERATED APP */', app);
write('SlopLobster.html', html.replace(/\n/g, '\r\n'));
