// The issues a pull request closes, read by main's scripts for the reviewer: the acceptance is the issue's, not only the body's.
//   node .gate/bin/lib/acceptance.mjs --repo <owner/name> --pr <n> --out <file>
//   exit 0  <file> holds { issues: [{ number, title, labels, body, length }], elsewhere: [<owner/name#n>] } and stdout is `acc`,
//           the first 16 hex characters of a sha256 of that file's content, or `none` when it names no issue at all
//   exit 3  unreadable (gh failed, or printed what is not the recorded shape): one line `acceptance: <why>`, no file
//   exit 2  usage
// Two porcelain commands only, never `gh api`: `gh pr view <n> --json closingIssuesReferences`, then for each reference to
// an issue of this repository `gh issue view <n> --json number,title,labels,body`. A reference to another repository is named in
// `elsewhere` and its text is never fetched. The body is cut at 30,000 characters (`length` keeps the full size). Nothing from
// the candidate's tree reaches this: the workflow runs it in main's checkout, with the job's read-only token.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export const BODY_CAP = 30_000;
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const repo = opt('--repo');
const pr = opt('--pr');
const outFile = opt('--out');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[1-9]\d*$/.test(pr ?? '') || !outFile) {
  console.log('usage: acceptance.mjs --repo <owner/name> --pr <n> --out <file>');
  process.exit(2);
}

const oneLine = (text) => String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').replace(/##\[/g, '## [').trim().slice(0, 200);
const fail = (why) => {
  console.log(`acceptance: ${oneLine(why)}`);
  process.exit(3);
};
const gh = (...a) => {
  try {
    return JSON.parse(execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }));
  } catch (error) {
    return fail(`gh ${a.slice(0, 2).join(' ')} failed: ${error.stderr || error.message}`);
  }
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNumber = (v) => Number.isInteger(v) && v > 0;
const text = (v) => typeof v === 'string';

const listing = gh('pr', 'view', pr, '--repo', repo, '--json', 'closingIssuesReferences');
if (!isObject(listing) || !Array.isArray(listing.closingIssuesReferences)) fail('gh pr view did not print closingIssuesReferences as a list');

const issues = [];
const elsewhere = [];
const seen = new Set();
for (const ref of listing.closingIssuesReferences) {
  if (!isObject(ref) || !isNumber(ref.number) || !isObject(ref.repository) || !text(ref.repository.name) || !isObject(ref.repository.owner) || !text(ref.repository.owner.login))
    fail('a closing issue reference is not number and repository.owner.login/name');
  const where = `${ref.repository.owner.login}/${ref.repository.name}`;
  const key = `${where.toLowerCase()}#${ref.number}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (where.toLowerCase() !== repo.toLowerCase()) {
    elsewhere.push(`${where}#${ref.number}`);
    continue;
  }
  const one = gh('issue', 'view', String(ref.number), '--repo', repo, '--json', 'number,title,labels,body');
  if (!isObject(one) || one.number !== ref.number || !text(one.title) || !text(one.body) || !Array.isArray(one.labels) || !one.labels.every((l) => isObject(l) && text(l.name)))
    fail(`gh issue view ${ref.number} did not print number, title, labels and body`);
  issues.push({ number: one.number, title: one.title, labels: one.labels.map((l) => l.name), body: one.body.slice(0, BODY_CAP), length: one.body.length });
}

const content = JSON.stringify({ issues, elsewhere });
writeFileSync(outFile, content);
console.log(issues.length || elsewhere.length ? createHash('sha256').update(content).digest('hex').slice(0, 16) : 'none');
