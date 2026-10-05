import fs from 'node:fs';

const htmlPath = new URL('../SlopLobster.html', import.meta.url);
let html = fs.readFileSync(htmlPath, 'utf8').replace(/\r\n/g, '\n');
const companionPattern = /const COMPANION_SCRIPT = (?:`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*");/;
let companion = fs.readFileSync(new URL('../SlopLobster-companion.py', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const backendFeatures = ['companion-features.py','companion-services.py'].map(name => fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n')).join('\n');
const backendBlock = '# BEGIN GENERATED FEATURES\n' + backendFeatures + '\n# END GENERATED FEATURES\n';
const backendPattern = /# BEGIN GENERATED FEATURES[\s\S]*?# END GENERATED FEATURES\n/;
companion = backendPattern.test(companion) ? companion.replace(backendPattern, () => backendBlock) : companion.replace('class Handler(', () => backendBlock + '\nclass Handler(');
if (!process.argv.includes('--check')) fs.writeFileSync(new URL('../SlopLobster-companion.py', import.meta.url), companion);
else if (fs.readFileSync(new URL('../SlopLobster-companion.py', import.meta.url), 'utf8').replace(/\r\n/g,'\n') !== companion) throw new Error('Generated companion features are stale');
const escaped = companion.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/</g, '\\x3c');
html = html.replace(companionPattern, () => 'const COMPANION_SCRIPT = `' + escaped + '`;');
const runtimePath = new URL('../src/harness-runtime.js', import.meta.url);
if (fs.existsSync(runtimePath)) {
  const runtime = ['harness-runtime.js','companion-client.js','companion-pairing.js','features-core.js','swarm-core.js','features-ui.js'].map(name => fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')).join('\n');
  const block = '<!-- BEGIN GENERATED HARNESS RUNTIME -->\n<script>\n' + runtime + '\n</script>\n<!-- END GENERATED HARNESS RUNTIME -->';
  const pattern = /<!-- BEGIN GENERATED HARNESS RUNTIME -->[\s\S]*?<!-- END GENERATED HARNESS RUNTIME -->/;
  if (pattern.test(html)) html = html.replace(pattern, () => block);
  else {
    const index = html.lastIndexOf('  <script>', html.indexOf('const COMPANION_SCRIPT'));
    if (index < 0) throw new Error('Main script missing');
    html = html.slice(0, index) + block + '\n' + html.slice(index);
  }
}
html = html.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
if (process.argv.includes('--check')) {
  if (html !== fs.readFileSync(htmlPath, 'utf8')) throw new Error('Generated HTML is stale; run node scripts/build.mjs');
} else fs.writeFileSync(htmlPath, html);
