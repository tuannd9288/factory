// The commit subject rules, in one place: .gate/bin/verify (the `subjects` check) checks every commit a change adds. There is
// no local commit-msg hook: it refused pstack's own `wip:` commit (Pause safely), and pstack rebases into clean commits before a
// pull request opens, so CI's check is the one that counts (FAC-8, INN-35).
//   node subject.mjs --base [<rev>]   the commits in <rev>..HEAD with fewer than two parents (default: merge-base with main)
// --base also checks the PR title when GITHUB_EVENT_PATH names a pull request event.
// Exit 0 clean, 1 on a subject that breaks a rule, 2 when it could not run.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX = 72;
const PLACEHOLDER = /^(WIP|wip)|^(fix|update|changes|\.)$/;
// Every authored commit must name its change, including commits in a pull request that will be squashed.
const AUTOSQUASH = /^(fixup|squash)! /;

/** The rule a subject breaks, as a sentence, or null. */
export function subjectProblem(raw) {
  // The hook trims; git's %s keeps leading spaces, so both judge the trimmed text.
  const subject = (raw ?? '').trim();
  if (!subject) return 'the subject line is empty';
  const length = [...subject].length;
  if (length > MAX) return `the subject has ${length} characters; at most ${MAX}`;
  if (AUTOSQUASH.test(subject)) return `say what the commit changes: '${subject.split(' ')[0]}' subjects do not name the change`;
  if (PLACEHOLDER.test(subject)) return `say what the commit changes, not '${subject}'`;
  return null;
}

/** The original title in a GitHub or Conventional Commits revert, if it names one. */
export function revertedTitle(title) {
  return /^Revert "(.+)"$/.exec(title)?.[1]
    ?? /^revert(?:\([^()\s]+\))?: (?:"(.+)"|(.+))$/.exec(title)?.slice(1).find((s) => s !== undefined);
}

/** PR titles become squash subjects; ordinary commits keep subjectProblem's rule. */
export function titleProblem(raw) {
  const problem = subjectProblem(raw);
  if (problem) return problem;
  const title = raw.trim();
  if (title.endsWith('.')) return 'the title must have no trailing period';
  if (revertedTitle(title) !== undefined) return null;
  if (!/^(feat|fix|docs|refactor|test|chore|perf)\([^()\s]+\): \S[^\r\n]*$/.test(title))
    return 'use type(scope): subject; type is feat, fix, docs, refactor, test, chore or perf';
  return null;
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
    const pr = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request : null;
    const titleError = pr ? titleProblem(pr.title) : null;
    if (titleError) console.log(`title: ${titleError}`);
    const bad = badSubjects(argv[1] || defaultBase());
    for (const c of bad) console.log(`${c.sha}: ${c.problem}\n    ${c.subject}`);
    if (bad.length) console.log(`subjects: ${bad.length} commit(s) with a subject that breaks a rule`);
    return bad.length || titleError ? 1 : 0;
  }
  console.log('usage: node subject.mjs --base [<rev>]');
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.log(`subjects: could not run: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    process.exitCode = 2;
  }
}
