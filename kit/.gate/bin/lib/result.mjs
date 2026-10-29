// Checks a reviewer's result before it counts. The result is JSON on stdin:
//   { "reviewer": "<name>", "job": "review" | "verdict", "base": "<sha>", "head": "<sha>",
//     "blocking": [{ "id": "<id>", "claim": "<what is wrong, where>" }, ...],
//     "noRed": "accepted" | "rejected" | "unjudged",
//     "raise": { "tier": 3, "why": "<what, where>" },       optional, review only: the Human reads this one
//     "forIssue": [{ "id", "claim", "often": 1-10, "harm": 1-10 }, ...] }   optional: findings for an issue, never blocking
//   node .gate/bin/lib/result.mjs --job review|verdict --base <sha> --head <sha> [--no-red]
// It passes when the result names this job, base and head, holds no blocking finding, and, when the PR body claims
// No-red (--no-red), accepts that claim explicitly. Exit 0 pass, 1 blocked, 2 a result that is missing, malformed or
// about another commit: a reviewer that said nothing usable has not passed the change.
// A raise only ever raises: any tier but 3, a second key, an empty or long reason, or a raise in a verdict is
// malformed (exit 2). It does not block. The reason is printed after a fixed prefix on one line, and once as the
// annotation `review-result` (message `none`, or `raise: <why>`) on the review job, always the first line printed, which
// the tier job reads (.gate/bin/lib/history.mjs raise); a review that reached its result and left none is read as absent.
// #171, the Human (2026-10-29): a bug whose two scores, how often and how bad, each 1 to 10, multiply to less than 5 is
// filed as an issue and the code is left alone. Such a finding is printed for the Lead to file and never blocks; one
// scored 5 or more, or off the scale, is malformed (exit 2), so a blocking finding cannot pass as one.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const want = { job: opt('--job'), base: opt('--base'), head: opt('--head') };
const unusable = (why) => {
  console.log(`result: ${why}; the reviewer's result does not count, so this check fails closed`);
  process.exit(2);
};

let result;
try {
  result = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  unusable('no JSON result');
}
for (const key of ['job', 'base', 'head']) if (result?.[key] !== want[key]) unusable(`the result's ${key} is ${JSON.stringify(result?.[key])}, not ${want[key]}`);
if (!Array.isArray(result.blocking) || result.blocking.some((f) => typeof f?.id !== 'string' || typeof f?.claim !== 'string' || !f.claim))
  unusable('"blocking" is not a list of findings with an id and a claim');
if (!['accepted', 'rejected', 'unjudged'].includes(result.noRed)) unusable('"noRed" is not accepted, rejected or unjudged');

const raise = result.raise;
if (raise !== undefined) {
  if (want.job !== 'review') unusable('only the review job may raise a tier');
  if (raise === null || typeof raise !== 'object' || Array.isArray(raise) || Object.keys(raise).sort().join() !== 'tier,why')
    unusable('"raise" is not { "tier": 3, "why": "<what, where>" }');
  if (raise.tier !== 3) unusable(`"raise" names tier ${JSON.stringify(raise.tier)}; a raise names tier 3 and never lowers one`);
  if (typeof raise.why !== 'string' || !raise.why.trim() || raise.why.length > 500) unusable('"raise.why" is not a reason of 1 to 500 characters');
}
const score = (n) => Number.isInteger(n) && n >= 1 && n <= 10;
const forIssue = result.forIssue ?? [];
if (!Array.isArray(forIssue) || forIssue.some((f) => f === null || typeof f !== 'object' || Object.keys(f).sort().join() !== 'claim,harm,id,often'
  || typeof f.id !== 'string' || typeof f.claim !== 'string' || !f.claim.trim() || !score(f.often) || !score(f.harm) || f.often * f.harm >= 5))
  unusable('"forIssue" is not a list of { "id", "claim", "often", "harm" } scored 1 to 10 whose two scores multiply to less than 5');

// Everything the reviewer wrote is printed as one line with its control characters collapsed and `##[` broken: the
// runner finds the legacy command `##[name]` anywhere in a line, the `::name::` form at the start of one, and splits
// lines at `\r` too. The result annotation comes first, before any model text, so no later line can stop commands.
const clean = (text) => String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, ' ').replace(/##\[/g, '## [').trim();
const why = raise ? clean(raise.why) : '';
console.log(`::notice title=review-result::${raise ? `raise: ${why}`.replace(/%/g, '%25') : 'none'}`);

const who = `${want.job} (${clean(result.reviewer ?? 'unnamed reviewer')})`;
let blocked = false;
for (const f of result.blocking) {
  console.log(`${who}: ${clean(f.id)}: ${clean(f.claim)}`);
  blocked = true;
}
if (args.includes('--no-red') && result.noRed !== 'accepted') {
  console.log(`${who}: the PR body's No-red line is not accepted (${result.noRed}); add a test that fails first, or a reviewer must accept the reason`);
  blocked = true;
}
if (raise) console.log(`${who}: raises to tier 3: ${why}`);
for (const f of forIssue) console.log(`${who}: for an issue (${f.often} x ${f.harm}): ${clean(f.id)}: ${clean(f.claim)}`);
console.log(`${who}: ${blocked ? 'blocks' : 'passes'} ${want.head.slice(0, 8)}`);
process.exit(blocked ? 1 : 0);
