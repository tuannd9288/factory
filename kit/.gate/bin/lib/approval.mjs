// Whether a tier-3 pull request has the Human's approval of its change, read from the reviews JSON on stdin (GitHub's
// list of a pull request's reviews; pages from `gh api --paginate --slurp` are flattened). Run in a checkout holding
// the commits.
//   node .gate/bin/lib/approval.mjs --owners <CODEOWNERS> --author <login> --head <sha> [--base <sha>] [--after <time>]
//     [--moved-at <time> --parent-head <sha|none>]
// Approved means: a user named in CODEOWNERS who is not the author, whose latest approving or blocking review is an
// approval of the head commit, or, with --base, of a commit whose own patch the head carries unchanged: the same
// `git patch-id --verbatim` of the change from its merge-base with the base, as after the queue merged main into the
// branch. Any change to the patch needs a new approval. GitHub's own code-owner rule is not enough: it asks nothing of
// an author who owns the code. With --after, an approval counts only when submitted after that time: the Human reads the
// reviewer's reason when the pull request is raised, so an approval given before the raise does not stand for it.
// --moved-at is the time of the pull request's last base change and --parent-head the head of the old base's pull request
// merged into the new base, or none (history.mjs moved). An approval given before that change showed the diff from the
// old base, so not even the head commit stands for it by itself: it counts only when the approved commit's patch from the
// parent's merged head is the head's patch from the base, as when a stack's parent landed and its child moved onto main. Teams
// are not counted as approvers. With --list and no stdin it prints the owners to request a review from (#374),
// `user <login>` less the author and `team @org/team`, and exits 0. Exit 0 approved, 1 not approved, 2 could not judge.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const head = opt('--head') ?? '';
const author = (opt('--author') ?? '').toLowerCase();
let owners;
let teams;
let reviews;
try {
  const tokens = readFileSync(opt('--owners'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(#|$)/.test(line))
    .flatMap((line) => line.trim().split(/\s+/).slice(1));
  owners = new Set(tokens.filter((o) => /^@[\w-]+$/.test(o)).map((o) => o.slice(1).toLowerCase()));
  teams = new Set(tokens.filter((o) => /^@[\w-]+\/[\w.-]+$/.test(o)).map((o) => o.toLowerCase()));
  // --list: the owners to request a review from, one line each: `user <login>` (not the author) or `team @org/team`.
  if (args.includes('--list')) {
    for (const o of owners) if (o !== author) console.log(`user ${o}`);
    for (const t of teams) console.log(`team ${t}`);
    process.exit(0);
  }
  reviews = JSON.parse(readFileSync(0, 'utf8')).flat();
} catch (error) {
  console.log(`approval: could not read the code owners or the reviews: ${error.message}`);
  process.exit(2);
}
if (!head || !author) {
  console.log('approval: the head commit and the author are needed');
  process.exit(2);
}

const base = opt('--base');
const git = (args, input) => execFileSync('git', args, { input, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['pipe', 'pipe', 'ignore'] });
const sha = (s) => /^[0-9a-f]{40}$/.test(String(s));
/** The patch-id of a commit's own change, its diff from its merge-base with `from` (the base by default); '' when it cannot be read. */
const patchOf = (commit, from = base) => {
  try {
    if (!sha(commit) || !from) return '';
    for (const c of [commit, from].filter(sha)) {
      try { git(['cat-file', '-e', `${c}^{commit}`]); }
      catch { git(['fetch', '--no-tags', 'origin', c]); }
    }
    const fork = git(['merge-base', from, commit]).trim();
    return git(['patch-id', '--verbatim'], git(['diff', '--binary', '--no-renames', fork, commit])).split(' ')[0].trim();
  } catch {
    return '';
  }
};
const own = base ? patchOf(head) : '';
const moved = opt('--moved-at') ?? '';
const parent = opt('--parent-head') ?? '';
const before = (r) => moved !== '' && String(r.submitted_at) <= moved;
const carried = (r) =>
  before(r)
    ? own !== '' && sha(parent) && patchOf(r.commit_id, parent) === own
    : r.commit_id === head || (own !== '' && patchOf(r.commit_id) === own);

const after = opt('--after') ?? '';
const latest = new Map();
for (const r of [...reviews].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) {
  if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user?.login?.toLowerCase(), r);
}
const standing = [...latest.entries()].filter(([login, r]) => owners.has(login) && login !== author && r.state === 'APPROVED' && String(r.submitted_at) > after);
const approvals = standing.filter(([, r]) => carried(r));
const eligible = [...owners].filter((o) => o !== author);
if (approvals.length) {
  for (const [login, r] of approvals)
    console.log(`approval: ${login} approved ${r.commit_id.slice(0, 8)}${r.commit_id === head && !before(r) ? '' : `, whose patch the head carries unchanged (${own.slice(0, 8)})`}`);
  process.exit(0);
}
if (standing.some(([, r]) => before(r)))
  console.log(`approval: an approval given before the base changed (${moved}) showed another diff, and the old base's change is not on the new base with this patch, so it does not count`);
console.log(
  eligible.length
    ? `approval: tier 3 waits for ${eligible.map((o) => `@${o}`).join(' or ')} to approve ${head.slice(0, 8)}; after approving, re-run this job`
    : `approval: tier 3 waits for a code owner who is not the author, and the only code owner (@${author}) wrote this pull request: agents need their own GitHub account`,
);
process.exit(1);
