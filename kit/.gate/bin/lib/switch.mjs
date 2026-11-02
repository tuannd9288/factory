// The merge switch of a repository (#333): three positions, set by the two review parameters of the `pull_request` rule of
// its factory-gate ruleset, which only the owner's login changes and GitHub applies at once to every open pull request.
//   all    every pull request merges by itself once its checks are green, tier 3 included
//   1-2    tier 1 and 2 merge by themselves; tier 3 waits for the Human's approval (the default)
//   none   every pull request waits for an approval
// A position is read from the rules in force on the branch (GET repos/<owner>/<name>/rules/branches/<branch>), not from one
// ruleset: GitHub applies every `pull_request` rule there, so the largest count counts and any code-owner requirement counts.
//   required_approving_review_count   require_code_owner_review   position
//   0                                 false                       all
//   0                                 true                        1-2
//   1 or more                         either                      none
// The count decides first. No `pull_request` rule in force is 1-2, the position of a switch nobody set. A rule with a
// count or a flag that is not a number or a boolean is no reading: the caller fails closed.
//   node .gate/bin/lib/switch.mjs      the rules' JSON on stdin, as one list or as the pages `gh api --paginate --slurp` gives;
//                                      prints the position, or why it could not read them (exit 2)
// The gate (`tier`), the queue and bin/onboard-owner share this file.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The parameters of each position: what `bin/onboard-owner --merge` sets, and what reads back as that position. */
export const PARAMETERS = {
  all: { required_approving_review_count: 0, require_code_owner_review: false },
  '1-2': { required_approving_review_count: 0, require_code_owner_review: true },
  none: { required_approving_review_count: 1, require_code_owner_review: true },
};
export const POSITIONS = Object.keys(PARAMETERS);

/** The rules as one list: `gh api --paginate --slurp` gives a list of pages, one list for each page of the rules in force. */
export const pagesOf = (rules) => (Array.isArray(rules) && rules.length && rules.every(Array.isArray) ? rules.flat() : rules);

/** The position the rules in force give, or an Error saying why they give none and naming the value it met. */
export function positionOf(rules) {
  if (!Array.isArray(rules)) throw new Error(`the rules in force are not a list: ${JSON.stringify(rules)?.slice(0, 80)}`);
  const pulls = rules.filter((r) => r?.type === 'pull_request');
  let count = 0;
  let owner = false;
  for (const { parameters } of pulls) {
    const n = parameters?.required_approving_review_count;
    const o = parameters?.require_code_owner_review;
    if (!Number.isInteger(n) || n < 0) throw new Error(`a pull_request rule has required_approving_review_count ${JSON.stringify(n) ?? 'unset'}, not a number from 0`);
    if (typeof o !== 'boolean') throw new Error(`a pull_request rule has require_code_owner_review ${JSON.stringify(o) ?? 'unset'}, not true or false`);
    count = Math.max(count, n);
    owner ||= o;
  }
  if (count >= 1) return 'none';
  return pulls.length && !owner ? 'all' : '1-2';
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(positionOf(pagesOf(JSON.parse(readFileSync(0, 'utf8')))));
  } catch (error) {
    console.log(`switch: the rules in force could not be read as a position (${error.message})`);
    process.exitCode = 2;
  }
}
