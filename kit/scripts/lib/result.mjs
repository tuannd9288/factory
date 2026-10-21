// Checks a reviewer's result before it counts. The result is JSON on stdin:
//   { "reviewer": "<name>", "job": "review" | "verdict", "base": "<sha>", "head": "<sha>",
//     "blocking": [{ "id": "<id>", "claim": "<what is wrong, where>" }, ...],
//     "noRed": "accepted" | "rejected" | "unjudged" }
//   node scripts/lib/result.mjs --job review|verdict --base <sha> --head <sha> [--no-red]
// It passes when the result names this job, base and head, holds no blocking finding, and, when the PR body claims
// No-red (--no-red), accepts that claim explicitly. Exit 0 pass, 1 blocked, 2 a result that is missing, malformed or
// about another commit: a reviewer that said nothing usable has not passed the change.
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

const who = `${want.job} (${result.reviewer ?? 'unnamed reviewer'})`;
let blocked = false;
for (const f of result.blocking) {
  console.log(`${who}: ${f.id}: ${f.claim}`);
  blocked = true;
}
if (args.includes('--no-red') && result.noRed !== 'accepted') {
  console.log(`${who}: the PR body's No-red line is not accepted (${result.noRed}); add a test that fails first, or a reviewer must accept the reason`);
  blocked = true;
}
console.log(`${who}: ${blocked ? 'blocks' : 'passes'} ${want.head.slice(0, 8)}`);
process.exit(blocked ? 1 : 0);
