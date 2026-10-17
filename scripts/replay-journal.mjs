import fs from 'node:fs';
import Journal from '../src/journal-core.js';
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/replay-journal.mjs exported-journal.json');
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
if (data.version !== 1 || !Array.isArray(data.events)) throw new Error('Unsupported journal export');
console.log(JSON.stringify(Journal.replay(data.events), null, 2));
