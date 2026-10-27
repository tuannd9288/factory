// The commit subject rules, in one place: .gate/hooks/commit-msg checks a message with them as the commit is made, and
// .gate/bin/verify (the `subjects` check) checks every commit a change adds. Plain node: the hook runs before any
// dependency is installed.
//   node subject.mjs <message file>   the hook: the first line that is not a comment is the subject
//   node subject.mjs --base [<rev>]   the commits in <rev>..HEAD with fewer than two parents (default: merge-base with main)
// Exit 0 clean, 1 on a subject that breaks a rule, 2 when it could not run.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX = 72;
const PLACEHOLDER = /^(WIP|wip)|^(fix|update|changes|\.)$/;
// Nothing here is ever squashed or rebased, so a fixup or squash subject would land on main as it stands.
const AUTOSQUASH = /^(fixup|squash)! /;

/** The rule a subject breaks, as a sentence, or null. */
export function subjectProblem(raw) {
  // The hook trims; git's %s keeps leading spaces, so both judge the trimmed text.
  const subject = (raw ?? '').trim();
  if (!subject) return 'the subject line is empty';
  const length = [...subject].length;
  if (length > MAX) return `the subject has ${length} characters; at most ${MAX}`;
  if (AUTOSQUASH.test(subject)) return `say what the commit changes: '${subject.split(' ')[0]}' commits are never squashed here, so it would land as it is`;
  if (PLACEHOLDER.test(subject)) return `say what the commit changes, not '${subject}'`;
  return null;
}

/** The subject of a message, as git's %s has it: blank and comment lines skipped, then the first paragraph with its
 * lines joined by spaces. */
export function subjectOf(text) {
  const lines = text.split('\n').filter((l) => !l.startsWith('#'));
  const start = lines.findIndex((l) => l.trim());
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && !l.trim());
  return lines.slice(start, end < 0 ? undefined : end).map((l) => l.trim()).join(' ');
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });

/** Commits in base..HEAD with fewer than two parents that break a rule: the ledger skips merges the same way. */
export function badSubjects(base) {
  return git(['log', '-z', '--no-merges', '--format=%h %s', `${base}..HEAD`])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const space = entry.indexOf(' ');
      const subject = space < 0 ? '' : entry.slice(space + 1);
      return { sha: entry.slice(0, space < 0 ? undefined : space), subject, problem: subjectProblem(subject) };
    })
    .filter((c) => c.problem);
}

function defaultBase() {
  for (const ref of ['origin/main', 'origin/HEAD', 'main']) {
    try {
      return git(['merge-base', 'HEAD', ref]).trim();
    } catch {}
  }
  throw new Error('no merge-base with origin/main; pass --base <rev>');
}

function main(argv) {
  if (argv[0] === '--base') {
    const bad = badSubjects(argv[1] || defaultBase());
    for (const c of bad) console.log(`${c.sha}: ${c.problem}\n    ${c.subject}`);
    if (bad.length) console.log(`subjects: ${bad.length} commit(s) with a subject that breaks a rule`);
    return bad.length ? 1 : 0;
  }
  if (!argv[0]) {
    console.log('commit-msg: no message file');
    return 2;
  }
  const problem = subjectProblem(subjectOf(readFileSync(argv[0], 'utf8')));
  if (problem) console.log(`commit-msg: ${problem}`);
  return problem ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.log(`subjects: could not run: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    process.exitCode = 2;
  }
}
