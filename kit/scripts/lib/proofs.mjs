// The proof that lets a change drop a test (AGENTS.md, Hand-in rule exceptions): one added line that names the test
// kept in the dropped one's place and a break of the code that turns it red,
//   gate-allow test-deleted: <path>; kept: <test file> "<test name>"; red: <source file> "<from>" -> "<to>"
// or gate-allow assertions-removed: the same, for a test file that lost assertions. Strings are JSON string literals.
// scripts/rules reads it statically, so the pre-commit hook can: the kept file is a test, holds the name, and is not
// the dropped file; the break edits a source file that holds <from> exactly once. scripts/red-check makes the break in
// a copy of the head and needs the kept test red under it and green without it.
//   node scripts/lib/proofs.mjs list <base>          the proofs the head adds since <base>: n, path, kept, name, summary
//   node scripts/lib/proofs.mjs break <base> <n> <dir>  makes proof n's break in the checkout <dir>
// The proof shows the kept test sensitive to a change, not that it covers what the dropped one did: the reviewer judges
// that, which is why scripts/tier makes such a change tier 2.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STRING = '"(?:[^"\\\\]|\\\\.)*"';
export const PROOF = new RegExp(`gate-allow (test-deleted|assertions-removed): (\\S+); kept: (\\S+) (${STRING}); red: (\\S+) (${STRING}) -> (${STRING})`);
export const FORM = 'gate-allow <rule>: <path>; kept: <test file> "<test name>"; red: <source file> "<from>" -> "<to>"';

/** The proof on a line, or null. */
export function proofOf(line) {
  const m = PROOF.exec(line);
  if (!m) return null;
  try {
    const [name, from, to] = [m[4], m[6], m[7]].map((s) => JSON.parse(s));
    return { rule: m[1], path: m[2], kept: m[3], name, source: m[5], from, to };
  } catch {
    return null;
  }
}

const count = (text, part) => (part ? text.split(part).length - 1 : 0);
const shown = (s) => JSON.stringify(s);

/** Why the proof does not hold in the tree `read` reads (a path's text, or '' for none), or '' when it holds. */
export function why(proof, { isTest, read }) {
  const { rule, path, kept, name, source, from, to } = proof;
  if (rule === 'test-deleted' && kept === path) return 'the kept test is the one dropped';
  if (!isTest(kept)) return `${kept} is not a test file`;
  const keptText = read(kept);
  if (!keptText) return `${kept} is not in the tree`;
  // The proof's own line names the test too; the name must stand elsewhere in the file.
  const body = keptText
    .split('\n')
    .filter((l) => !l.includes('gate-allow '))
    .join('\n');
  if (!name.trim() || !body.includes(name)) return `${kept} does not hold the test ${shown(name)}`;
  if (isTest(source)) return `the break edits ${source}, a test; it must break the code`;
  const sourceText = read(source);
  if (!sourceText) return `${source} is not in the tree`;
  const n = count(sourceText, from);
  if (n !== 1) return `${source} holds ${shown(from)} ${n} times, not once`;
  if (from === to) return 'the break changes nothing';
  return '';
}

export const summary = (p) => `${p.path} dropped: ${p.kept} ${shown(p.name)} is red under ${p.source} ${shown(p.from)} -> ${shown(p.to)}`;

/** The proofs on the lines the head adds since base, in diff order. */
function added(base) {
  const diff = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--no-renames', base, 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++ '))
    .map((l) => proofOf(l.slice(1)))
    .filter(Boolean);
}

function main([verb, base, n, dir]) {
  if (verb === 'list' && base) {
    added(base).forEach((p, i) => console.log([i, p.path, p.kept, p.name, summary(p)].map((f) => String(f).replace(/[\t\n]/g, ' ')).join('\t')));
    return 0;
  }
  if (verb === 'break' && base && /^\d+$/.test(n ?? '') && dir) {
    const p = added(base)[Number(n)];
    if (!p) return console.log(`no proof ${n}`), 2;
    const file = join(dir, p.source);
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {}
    const times = count(text, p.from);
    if (times !== 1) return console.log(`${p.source} holds ${shown(p.from)} ${times} times, not once`), 1;
    writeFileSync(file, text.replace(p.from, () => p.to));
    return 0;
  }
  console.log('usage: node scripts/lib/proofs.mjs list <base> | break <base> <n> <dir>');
  return 2;
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.log(`proofs: ${String(error.stderr || error.message).trim()}`);
    process.exitCode = 2;
  }
}
