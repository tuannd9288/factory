#!/usr/bin/env node
// The cut-back inventory's one check and its measures (#271, phase 1). It reads the table in cutback/inventory.md and:
//   - places every file git tracks under bin/, kit/, packs/ and modules/ in the rows whose part cell names it, as a path or a
//     glob in backticks (`*` within one folder, `**` across folders), and lists the files in no row and the files in two or more;
//   - measures each row: lines, every line (`wc -l`) of the row's tracked files under those four folders that are not tests;
//     tests, the `test(` calls (`grep -cE '^\s*test(\.\w+)?\('`) of the row's test files, where `test/kit.test.mjs:A-B` counts
//     only lines A to B of that file (the top-level describe block that covers the part);
//   - compares each row's "lines and tests" cell with that measure, and sums the rows by their keep-or-cut word.
// Run from the repository's root: node cutback/check.mjs [--rows]. It reads files and git only, and writes nothing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FOLDERS = ['bin', 'kit', 'packs', 'modules'];
const TEST_CALL = /^\s*test(\.\w+)?\(/;
const tracked = execFileSync('git', ['ls-files', '-z', ...FOLDERS], { encoding: 'utf8' }).split('\0').filter(Boolean);
const testFiles = execFileSync('git', ['ls-files', '-z', 'test'], { encoding: 'utf8' }).split('\0')
  .filter((f) => f.endsWith('.mjs'));
const all = new Set([...tracked, ...testFiles]);

const isTest = (f) => f.startsWith('test/') || /(^|\/)test\//.test(f);
const lines = (f, from = 1, to = Infinity) => readFileSync(f, 'utf8').split('\n').slice(from - 1, to);
const count = (text) => { const n = text.split('\n').length; return text.endsWith('\n') ? n - 1 : n; };
const toRegex = (glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*') + '$');

const md = readFileSync(new URL('./inventory.md', import.meta.url), 'utf8').split('\n');
const start = md.findIndex((l) => /^\|\s*part\s*\|/.test(l));
if (start < 0) { console.error('check: no table whose first column is "part" in cutback/inventory.md'); process.exit(2); }
const rows = [];
for (let i = start + 2; i < md.length && md[i].startsWith('|'); i++) {
  const cells = md[i].split(' | ').map((c) => c.replace(/^\|\s*|\s*\|$/g, '').trim());
  const name = (cells[0].match(/\*\*(.+?)\*\*/) || [, cells[0]])[1];
  const tokens = [...cells[0].matchAll(/`([^`\s]+)`/g)].map((m) => m[1])
    .filter((t) => /^(bin|kit|packs|modules|test)\//.test(t));
  rows.push({ line: i + 1, name, tokens, cell: cells[1] ?? '', word: (cells[2] ?? '').replace(/\*/g, '').trim().toLowerCase() });
}

const placed = new Map(); // file -> [row names]
const testPlaced = new Map(); // test file or range -> [row names]
const empty = [];
for (const row of rows) {
  row.files = new Set(); row.tests = 0; row.testLines = 0;
  for (const token of row.tokens) {
    const range = token.match(/^(.+\.mjs):(\d+)-(\d+)$/);
    if (range) {
      const [, file, a, b] = range;
      const text = lines(file, +a, +b);
      row.tests += text.filter((l) => TEST_CALL.test(l)).length; row.testLines += text.length;
      testPlaced.set(token, [...(testPlaced.get(token) ?? []), row.name]);
      continue;
    }
    const re = toRegex(token);
    const hits = [...all].filter((f) => re.test(f));
    if (!hits.length) empty.push(`${row.name}: ${token}`);
    for (const f of hits) row.files.add(f);
  }
  for (const f of row.files) {
    if (FOLDERS.some((d) => f.startsWith(d + '/'))) placed.set(f, [...(placed.get(f) ?? []), row.name]);
    if (isTest(f)) {
      testPlaced.set(f, [...(testPlaced.get(f) ?? []), row.name]);
      const text = readFileSync(f, 'utf8');
      row.tests += text.split('\n').filter((l) => TEST_CALL.test(l)).length; row.testLines += count(text);
    } else {
      row.lines = (row.lines ?? 0) + count(readFileSync(f, 'utf8'));
    }
  }
  row.lines ??= 0;
}

const missing = tracked.filter((f) => !placed.has(f));
const twice = [...placed].filter(([, r]) => r.length > 1);
const testTwice = [...testPlaced].filter(([, r]) => r.length > 1);
const testLoose = testFiles.filter((f) => !testPlaced.has(f) && ![...testPlaced.keys()].some((k) => k.startsWith(f + ':')));
const stale = rows.filter((r) => {
  const m = r.cell.replace(/,(?=\d{3})/g, '').match(/(\d+) lines?, (\d+) tests?/);
  return !m || +m[1] !== r.lines || +m[2] !== r.tests;
});

if (process.argv.includes('--rows')) {
  for (const r of rows) console.log(`${String(r.lines).padStart(6)} lines ${String(r.tests).padStart(4)} tests  ${r.word.padEnd(10)} ${r.name}`);
}

const CLASSES = [['keep', /^keep/], ['planned', /^planned/], ['cut', /^cut/], ['his word', /^his word/], ['his call', /^his call/]];
const sums = Object.fromEntries(CLASSES.map(([k]) => [k, { rows: 0, lines: 0, tests: 0, testLines: 0 }]));
const unclassed = [];
for (const r of rows) {
  const k = CLASSES.find(([, re]) => re.test(r.word));
  if (!k) { unclassed.push(r.name); continue; }
  Object.assign(sums[k[0]], { rows: sums[k[0]].rows + 1, lines: sums[k[0]].lines + r.lines, tests: sums[k[0]].tests + r.tests,
    testLines: sums[k[0]].testLines + r.testLines });
}
const total = (keys) => keys.reduce((a, k) => ({ rows: a.rows + sums[k].rows, lines: a.lines + sums[k].lines,
  tests: a.tests + sums[k].tests, testLines: a.testLines + sums[k].testLines }), { rows: 0, lines: 0, tests: 0, testLines: 0 });
const fmt = (s) => `${s.rows} rows, ${s.lines} lines, ${s.tests} tests (${s.testLines} test lines)`;

const say = (label, list) => {
  console.log(`${label}: ${list.length}`);
  for (const x of list) console.log(`  ${Array.isArray(x) ? `${x[0]} (in: ${x[1].join('; ')})` : x}`);
};
console.log(`check: ${tracked.length} files tracked under ${FOLDERS.map((d) => d + '/').join(' ')}; ${rows.length} rows`);
say('files missing from every row', missing);
say('files listed in two or more rows', twice);
say('paths or globs that match no tracked file', empty);
say('test files or ranges listed in two or more rows', testTwice);
say('test/*.mjs files in no row (they count toward no part)', testLoose);
say('rows whose "lines and tests" cell differs from the measure', stale.map((r) => `${r.name} (line ${r.line}): cell "${r.cell}", measured ${r.lines} lines, ${r.tests} tests`));
say('rows with no keep-or-cut word the check knows', unclassed);
console.log('sums by keep-or-cut word:');
for (const [k] of CLASSES) console.log(`  ${k.padEnd(9)} ${fmt(sums[k])}`);
console.log(`  before   ${fmt(total(CLASSES.map(([k]) => k)))}`);
console.log(`  after A  ${fmt(total(['keep', 'his word', 'his call']))}  (planned and cut rows gone)`);
console.log(`  after B  ${fmt(total(['keep', 'his call']))}  (and the rows that need his word on a settled decision)`);
process.exit(missing.length || twice.length || empty.length || testTwice.length || stale.length || unclassed.length ? 1 : 0);
