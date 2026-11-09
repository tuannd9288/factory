// scripts/ship's reviewer gate (FAC-101): whether this team's reviewer passed a pull request's change, and the raises ship labelled.
// ship.mjs imports it from beside it, in a repository's scripts/lib/ once the pack is installed, or in the pack's own source in the factory.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quietGit = (args) => spawnSync('git', args, { stdio: 'ignore' }).status === 0;

/** The state folder, where bin/seat's records are: $FACTORY_STATE, else ~/.local/state/factory. */
const stateDir = () => process.env.FACTORY_STATE ?? join(process.env.HOME ?? '', '.local/state/factory');
/** The pull request's repository, owner/name, from its URL. */
const repoOf = (pr) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url ?? '')?.[1] ?? null;

/** The patch-id of a commit's own change, its diff from its merge base with origin/main, as .gate/bin/lib/approval.mjs reads it for the
 * Human's approval; null when it cannot be read (the commit is not here) or the change is empty. */
function patchOf(sha) {
  try {
    const fork = git(['merge-base', 'origin/main', sha]);
    const diff = execFileSync('git', ['diff', '--binary', '--no-renames', fork, sha], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    if (!diff) return null;
    return execFileSync('git', ['patch-id', '--verbatim'], { input: diff, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).split(' ')[0].trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether this team's reviewer passed the pull request's change (FAC-101): { pass, why, record }. bin/seat's supervisor appends each seat's
 * record to $FACTORY_STATE/sessions.jsonl when the seat ends, with the head its work folder was at when it started and the reviewer's report
 * (packs/pstack/lead.md step 6). A record counts when it is a reviewer's, of this repository and of this team (FACTORY_TEAM, which the
 * Lead's launcher sets and bin/seat records), on the pull request's head or on a head whose patch is the same: a merge of main that leaves
 * the change as it was keeps the PASS, as the Human's approval is kept; a commit that changes the patch needs a PASS of its own. The newest
 * such record decides, so a later FAIL beats an earlier PASS.
 * The references split on enforcing a review before work is taken: zeroshot 0ad6653 enforces it ("The agent that writes the code cannot
 * approve its own work", README.md:42-45), as pi-herdsman f2064d9 does (docs/guides/customizing-agents.md:150); pstack 4dd1d05 gates
 * nothing on its reviewers. The Human chose enforcement on 2026-11-08 (FAC-99). Any process of this account can append a record, the Lead
 * included: the Lead is trusted to hold its own reviewer, as in those references.
 */
export function reviewOf(pr) {
  // A head made on GitHub, as the queue's update-branch makes one when main moves, is not in this clone yet: fetch it, and main with it, as
  // draftWait does, or its patch could not be read and its PASS would not be found. main too, since against a stale origin/main the new
  // head's patch would carry main's new commits.
  if (!quietGit(['cat-file', '-e', `${pr.headRefOid}^{commit}`])) spawnSync('git', ['fetch', '--quiet', 'origin', 'main', pr.headRefOid], { stdio: 'ignore' });
  const repo = repoOf(pr);
  const team = process.env.FACTORY_TEAM ?? null;
  const short = String(pr.headRefOid).slice(0, 7);
  let text = '';
  try {
    text = readFileSync(join(stateDir(), 'sessions.jsonl'), 'utf8');
  } catch {
    // No record yet.
  }
  const patches = new Map();
  const patch = (sha) => (patches.has(sha) ? patches.get(sha) : patches.set(sha, patchOf(sha)).get(sha));
  // Newest first: the file is appended to, so the first record that counts, from the end, is the newest.
  const lines = text.split('\n');
  let record = null;
  for (let i = lines.length - 1; i >= 0 && !record; i -= 1) {
    let r;
    try {
      r = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (r?.role !== 'reviewer' || !team || r.team !== team || r.repo !== repo || typeof r.head !== 'string') continue;
    if (r.head === pr.headRefOid || (patch(pr.headRefOid) && patch(r.head) === patch(pr.headRefOid))) record = r;
  }
  const conclusion = String(record?.structured?.conclusion ?? '');
  if (record && conclusion.startsWith('PASS')) return { pass: true, record };
  const named = record ? `the newest, ${record.tag} (session ${record.session}), concluded ${conclusion.split('\n')[0].slice(0, 80) || 'nothing'}` : 'there is none';
  return { pass: false, why: `no reviewer PASS of team ${team ?? '(FACTORY_TEAM is not set)'} covers head ${short} or its patch (${named}); run step 6's reviewer on it` };
}

/**
 * The raises ship labelled (FAC-101): one line per label it set, in $FACTORY_STATE/ship-raised.jsonl, naming the repository, the pull request
 * and the reviewer record (its session and tag) whose raise it was. A raise is read on the record reviewOf picks, the one on the head or on a
 * head with its patch; so when that record's line is here and the pull request no longer carries needs-human, the label ship set was taken
 * off, which is the Human's decision on that raise, and ship arms. A new patch needs a new review, whose raise is a new record and is
 * labelled again. The line is kept on this machine, where the Lead runs ship; a run elsewhere labels again and stops, which lands nothing.
 */
const raisedFile = () => join(stateDir(), 'ship-raised.jsonl');
const sameRaise = (line, pr, record) => line.repo === repoOf(pr) && line.pr === pr.number && line.session === record.session && line.tag === record.tag;
export function labelledBefore(pr, record) {
  let text;
  try {
    text = readFileSync(raisedFile(), 'utf8');
  } catch {
    return false;
  }
  return text.split('\n').some((l) => {
    try {
      return sameRaise(JSON.parse(l), pr, record);
    } catch {
      return false;
    }
  });
}
export function noteLabelled(pr, record) {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(raisedFile(), `${JSON.stringify({ repo: repoOf(pr), pr: pr.number, session: record.session, tag: record.tag, head: pr.headRefOid, at: new Date().toISOString() })}\n`);
}
