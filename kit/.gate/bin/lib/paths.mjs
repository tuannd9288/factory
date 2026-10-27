// Sorts changed paths, one per line on stdin, into "test", "source" or "other", one "<kind>\t<path>" line each.
// Tests are .gate/handin.json's "tests" patterns; source is GATE_SOURCE (a regex) minus tests and the kit's own files.
import { readFileSync } from 'node:fs';

const table = JSON.parse(readFileSync('.gate/handin.json', 'utf8'));
const tests = table.tests.map((p) => new RegExp(p));
const source = new RegExp(process.env.GATE_SOURCE || '\\.([cm]?[jt]sx?|py|go|rs|rb|java|kt|php|sh)$');
let kit = new Set();
try {
  kit = new Set(readFileSync('.gate/kit-files', 'utf8').split('\n').filter(Boolean));
} catch {}

const input = readFileSync(0, 'utf8').split('\n').filter(Boolean);
for (const path of input) {
  const kind = kit.has(path) ? 'other' : tests.some((p) => p.test(path)) ? 'test' : source.test(path) ? 'source' : 'other';
  console.log(`${kind}\t${path}`);
}
