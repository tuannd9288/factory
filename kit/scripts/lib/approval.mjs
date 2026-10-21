// Whether a tier-3 pull request has the Human's approval of its change, read from the reviews JSON on stdin (GitHub's
// list of a pull request's reviews; pages from `gh api --paginate --slurp` are flattened). Run in a checkout holding
// the commits.
//   node scripts/lib/approval.mjs --owners <CODEOWNERS> --author <login> --head <sha> [--base <sha>]
// Approved means: a user named in CODEOWNERS who is not the author, whose latest approving or blocking review is an
// approval of the head commit, or, with --base, of a commit whose own patch the head carries unchanged: the same
// `git patch-id --verbatim` of the change from its merge-base with the base, as after the queue merged main into the
// branch. Any change to the patch needs a new approval. GitHub's own code-owner rule is not enough: it asks nothing of
// an author who owns the code. Teams (@org/team) are not read. Exit 0 approved, 1 not approved, 2 could not judge.
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
let reviews;
try {
  owners = new Set(
    readFileSync(opt('--owners'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(#|$)/.test(line))
      .flatMap((line) => line.trim().split(/\s+/).slice(1))
      .filter((o) => /^@[\w-]+$/.test(o))
      .map((o) => o.slice(1).toLowerCase()),
  );
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
/** The patch-id of a commit's own change, its diff from its merge-base with the base; '' when it cannot be read. */
const patchOf = (commit) => {
  try {
    const fork = git(['merge-base', base, commit]).trim();
    return git(['patch-id', '--verbatim'], git(['diff', '--binary', '--no-renames', fork, commit])).split(' ')[0].trim();
  } catch {
    return '';
  }
};
const own = base ? patchOf(head) : '';
const carried = (commit) => commit === head || (own !== '' && patchOf(commit) === own);

const latest = new Map();
for (const r of [...reviews].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) {
  if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user?.login?.toLowerCase(), r);
}
const approvals = [...latest.entries()].filter(([login, r]) => owners.has(login) && login !== author && r.state === 'APPROVED' && carried(r.commit_id));
const eligible = [...owners].filter((o) => o !== author);
if (approvals.length) {
  for (const [login, r] of approvals)
    console.log(`approval: ${login} approved ${r.commit_id.slice(0, 8)}${r.commit_id === head ? '' : `, whose patch the head carries unchanged (${own.slice(0, 8)})`}`);
  process.exit(0);
}
console.log(
  eligible.length
    ? `approval: tier 3 waits for ${eligible.map((o) => `@${o}`).join(' or ')} to approve ${head.slice(0, 8)}; after approving, re-run this job`
    : `approval: tier 3 waits for a code owner who is not the author, and the only code owner (@${author}) wrote this pull request: agents need their own GitHub account`,
);
process.exit(1);
