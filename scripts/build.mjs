import fs from 'node:fs';
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
let companion = read('SlopLobster-companion.py');
const features = ['companion-features.py', 'companion-services.py'].map(name => read('src/' + name)).join('\n');
const backendPattern = /# BEGIN GENERATED FEATURES[\s\S]*?# END GENERATED FEATURES\n/;
if (!backendPattern.test(companion)) throw new Error('Companion features marker missing');
companion = companion.replace(backendPattern, () => '# BEGIN GENERATED FEATURES\n' + features + '\n# END GENERATED FEATURES\n');
write('SlopLobster-companion.py', companion);
const modules = ['harness-runtime.js', 'run-state.js', 'model-stream.js', 'verification-core.js', 'journal-core.js', 'companion-client.js', 'companion-pairing.js', 'features-core.js', 'swarm-core.js', 'features-ui.js', 'journal-ui.js', 'verification-ui.js', 'model-client.js', 'agent-loop.js'];
const runtime = modules.map(name => read('src/' + name)).join('\n');
if (/<\/script/i.test(runtime)) throw new Error('Runtime contains an unsafe closing script tag');
const escaped = companion.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/</g, '\\x3c');
const app = replaceOnce(read('src/app.js'), 'const COMPANION_SCRIPT = ""; // Embedded by scripts/build.mjs.', 'const COMPANION_SCRIPT = `' + escaped + '`;');
let html = replaceOnce(read('src/ui.html'), '<!-- GENERATED HARNESS RUNTIME -->', '<!-- BEGIN GENERATED HARNESS RUNTIME -->\n<script>\n' + runtime + '\n</script>\n<!-- END GENERATED HARNESS RUNTIME -->');
html = replaceOnce(html, '/* GENERATED APP */', app);
write('SlopLobster.html', html.replace(/\n/g, '\r\n'));
