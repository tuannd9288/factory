// #133: .gate/bin/claim. A claim is the ref claim/<n> on origin; its tip's subject is the state. Real bare origin, real git,
// a fake gh on PATH (every call is logged in $FAKE/gh-calls) and a git wrapper that logs each push. No network.
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { commit, factory, git, quiet, run } from './helpers.mjs';

const CLAIM = join(factory, 'kit/.gate/bin/claim');
const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

const FAKE_GH = `#!/bin/sh
echo "$*" >>"$FAKE/gh-calls"
case "$1 $2" in
  "issue view") cat "$FAKE/issue.json" 2>/dev/null || echo '{"state":"OPEN","labels":[{"name":"task"}]}' ;;
  "issue comment") [ -e "$FAKE/comment-fails" ] && { echo boom >&2; exit 1; }; cp "$5" "$FAKE/comment-$3" ;;
  "repo view") cat "$FAKE/perm.json" 2>/dev/null || echo '{"viewerPermission":"WRITE"}' ;;
  "pr list") cat "$FAKE/prs.json" 2>/dev/null || echo '[]' ;;
  "pr merge") exit 0 ;;
  "run list") cat "$FAKE/runs.json" 2>/dev/null || echo '[{"databaseId":9,"status":"completed"}]' ;;
  "run view") cat "$FAKE/jobs.json" 2>/dev/null || echo '{"jobs":[{"databaseId":55,"name":"tier"},{"databaseId":56,"name":"review"}]}' ;;
  "run rerun") [ -e "$FAKE/rerun-fails" ] && { echo "cannot be rerun" >&2; exit 1; }; exit 0 ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;

// Logs every push; when $FAKE/race exists, another team's claim on issue 7 lands first, as a second pusher would.
const GIT_WRAPPER = (real) => `#!/bin/sh
if [ "$1" = push ]; then
  echo "$*" >>"$FAKE/pushes"
  if [ -e "$FAKE/race" ]; then
    rm "$FAKE/race"
    main=$(${real} -C "$OTHER" rev-parse origin/main)
    sha=$(${real} -C "$OTHER" commit-tree "$main^{tree}" -p "$main" -m "claim 7 team-y")
    ${real} -C "$OTHER" push -q origin "$sha:refs/heads/claim/7"
  fi
fi
exec ${real} "$@"
`;

describe('.gate/bin/claim', () => {
  let dir;
  let origin;
  let work;
  let other;
  let fake;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'claim-'));
    origin = join(dir, 'origin.git');
    fake = join(dir, 'fake');
    mkdirSync(join(fake, 'bin'), { recursive: true });
    mkdirSync(join(fake, 'gitbin'));
    writeFileSync(join(fake, 'bin/gh'), FAKE_GH);
    writeFileSync(join(fake, 'gitbin/git'), GIT_WRAPPER(REAL_GIT));
    chmodSync(join(fake, 'bin/gh'), 0o755);
    chmodSync(join(fake, 'gitbin/git'), 0o755);
    const seed = join(dir, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    commit(seed, { 'README.md': '# app\n' }, 'start');
    git(dir, 'clone', '-q', '--bare', seed, origin);
    work = join(dir, 'work');
    other = join(dir, 'other');
    git(dir, 'clone', '-q', origin, work);
    git(dir, 'clone', '-q', origin, other);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    // Every test starts with no claim, no race and a clean fake.
    for (const ref of git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/claim/').split('\n').filter(Boolean)) git(origin, 'update-ref', '-d', ref);
    for (const f of ['gh-calls', 'pushes']) writeFileSync(join(fake, f), '');
    for (const f of ['issue.json', 'perm.json', 'prs.json', 'runs.json', 'jobs.json', 'race', 'comment-fails', 'rerun-fails']) rmSync(join(fake, f), { force: true });
  });

  const claim = (...args) => run(work, CLAIM, args, { ...quiet, PATH: `${join(fake, 'gitbin')}:${join(fake, 'bin')}:${process.env.PATH}`, FAKE: fake, OTHER: other });
  const ghCalls = () => readFileSync(join(fake, 'gh-calls'), 'utf8').split('\n').filter(Boolean);
  const ref = (n) => spawnSync(REAL_GIT, ['-C', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/claim/${n}`], { encoding: 'utf8' }).stdout.trim() || null;
  const subject = (sha) => git(origin, 'log', '-1', '--format=%s', sha);
  const parents = (sha) => git(origin, 'log', '-1', '--format=%P', sha).split(' ').filter(Boolean);
  const mainTip = () => git(origin, 'rev-parse', 'refs/heads/main');
  const pasted = (out) => /^Claim: ([0-9a-f]{40})$/m.exec(out)?.[1];

  test('a first claim is an empty commit on main, subject "claim <n> <team>", and prints the sha for the pull request', () => {
    const r = claim('7', 'team-x');
    assert.equal(r.code, 0, r.out);
    const sha = ref(7);
    assert.equal(pasted(r.out), sha);
    assert.equal(subject(sha), 'claim 7 team-x');
    assert.deepEqual(parents(sha), [mainTip()]);
    assert.equal(git(origin, 'rev-parse', `${sha}^{tree}`), git(origin, 'rev-parse', `${mainTip()}^{tree}`));
  });

  test('it reads the issue and comments on it with porcelain gh only', () => {
    claim('7', 'team-x');
    const calls = ghCalls();
    assert.ok(calls.includes('issue view 7 --json state,labels'), calls.join('\n'));
    assert.ok(calls.some((c) => c.startsWith('issue comment 7 --body-file ')), calls.join('\n'));
    assert.ok(!calls.some((c) => c.startsWith('api ')), 'gh api');
    assert.match(readFileSync(join(fake, 'comment-7'), 'utf8'), /team-x/);
  });

  test('a failed comment is not a failed claim: the ref is the claim', () => {
    writeFileSync(join(fake, 'comment-fails'), '');
    const r = claim('7', 'team-x');
    assert.equal(r.code, 0, r.out);
    assert.ok(ref(7));
  });

  test('a second team is refused with the holder named, and the ref does not move', () => {
    claim('7', 'team-x');
    const before = ref(7);
    const r = claim('7', 'team-y');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /team-x/);
    assert.equal(ref(7), before);
  });

  test('the same team asking again is refused too', () => {
    claim('7', 'team-x');
    assert.equal(claim('7', 'team-x').code, 1);
  });

  test('an issue that is closed, not labelled task, or unreadable gets no claim', () => {
    writeFileSync(join(fake, 'issue.json'), '{"state":"CLOSED","labels":[{"name":"task"}]}');
    assert.equal(claim('7', 'team-x').code, 1);
    writeFileSync(join(fake, 'issue.json'), '{"state":"OPEN","labels":[{"name":"bug"}]}');
    assert.equal(claim('7', 'team-x').code, 1);
    writeFileSync(join(fake, 'issue.json'), 'not json');
    assert.notEqual(claim('7', 'team-x').code, 0);
    assert.equal(ref(7), null);
  });

  test('a team name that is not a team name, or a bad issue number, is a usage error', () => {
    assert.equal(claim('7', 'Team X').code, 2);
    assert.equal(claim('seven', 'team-x').code, 2);
    assert.equal(claim('7').code, 2);
    assert.equal(ref(7), null);
  });

  test('a release is a fast-forward commit "release <n>" on the tip, not a deletion; the holder may then be replaced', () => {
    const first = pasted(claim('7', 'team-x').out);
    const r = claim('--release', '7', 'team-x');
    assert.equal(r.code, 0, r.out);
    const tip = ref(7);
    assert.equal(subject(tip), 'release 7');
    assert.deepEqual(parents(tip), [first]);
    const again = claim('7', 'team-y');
    assert.equal(again.code, 0, again.out);
    const next = ref(7);
    assert.equal(subject(next), 'claim 7 team-y');
    assert.deepEqual(parents(next), [tip]);
    assert.equal(pasted(again.out), next);
  });

  test('only the holder releases: another team is refused, and so is --human without admin rights', () => {
    claim('7', 'team-x');
    const tip = ref(7);
    assert.equal(claim('--release', '7', 'team-y').code, 1);
    assert.equal(claim('--release', '7', '--human').code, 1);
    assert.equal(ref(7), tip);
    writeFileSync(join(fake, 'perm.json'), '{"viewerPermission":"ADMIN"}');
    const r = claim('--release', '7', '--human');
    assert.equal(r.code, 0, r.out);
    assert.equal(subject(ref(7)), 'release 7');
    assert.ok(ghCalls().includes('repo view --json viewerPermission'));
  });

  test('a release of a claim nobody holds is refused', () => {
    assert.equal(claim('--release', '7', 'team-x').code, 1);
    claim('7', 'team-x');
    claim('--release', '7', 'team-x');
    assert.equal(claim('--release', '7', 'team-x').code, 1);
  });

  test('a handoff is a commit "handoff <n> <to>" by the holder; the old holder is then refused as any other team', () => {
    const first = pasted(claim('7', 'team-x').out);
    const r = claim('--handoff', '7', 'team-x', 'team-y');
    assert.equal(r.code, 0, r.out);
    const tip = ref(7);
    assert.equal(subject(tip), 'handoff 7 team-y');
    assert.deepEqual(parents(tip), [first]);
    assert.equal(pasted(r.out), tip);
    const x = claim('7', 'team-x');
    assert.equal(x.code, 1);
    assert.match(x.out, /team-y/);
    assert.equal(claim('--handoff', '7', 'team-x', 'team-z').code, 1);
    assert.equal(claim('--release', '7', 'team-y').code, 0);
  });

  test('--list reads the tips: claimed, handed-off, released and invalid; released only with --all', () => {
    claim('1', 'team-x');
    claim('2', 'team-x');
    claim('--handoff', '2', 'team-x', 'team-y');
    claim('3', 'team-x');
    claim('--release', '3', 'team-x');
    // A ref no form of claim wrote, and a subject whose number is another issue's.
    git(other, 'fetch', '-q', 'origin');
    const stray = git(other, 'commit-tree', 'origin/main^{tree}', '-p', 'origin/main', '-m', 'hello');
    git(other, 'push', '-q', 'origin', `${stray}:refs/heads/claim/4`);
    const wrong = git(other, 'commit-tree', 'origin/main^{tree}', '-p', 'origin/main', '-m', 'claim 9 team-x');
    git(other, 'push', '-q', 'origin', `${wrong}:refs/heads/claim/5`);
    const rows = (args) => claim('--list', ...args).out.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
    const byIssue = (rs) => Object.fromEntries(rs.map(([n, state, team]) => [n, [state, team]]));
    assert.deepEqual(byIssue(rows([])), { 1: ['claimed', 'team-x'], 2: ['handed-off', 'team-y'], 4: ['invalid', '-'], 5: ['invalid', '-'] });
    assert.deepEqual(byIssue(rows(['--all']))[3], ['released', '-']);
    assert.equal(rows(['--all']).length, 5);
    assert.match(rows([])[0][3], /^[0-9a-f]{7}$/);
  });

  test('a ref no form of claim wrote is not claimed over: the Human decides', () => {
    git(other, 'fetch', '-q', 'origin');
    const stray = git(other, 'commit-tree', 'origin/main^{tree}', '-p', 'origin/main', '-m', 'hello');
    git(other, 'push', '-q', 'origin', `${stray}:refs/heads/claim/7`);
    assert.equal(claim('7', 'team-x').code, 1);
    assert.equal(ref(7), stray);
  });

  test('no push is a force: no plus sign, no --force, no delete', () => {
    claim('7', 'team-x');
    claim('--handoff', '7', 'team-x', 'team-y');
    claim('--release', '7', 'team-y');
    claim('7', 'team-x');
    const pushes = readFileSync(join(fake, 'pushes'), 'utf8').split('\n').filter(Boolean);
    assert.equal(pushes.length, 4);
    for (const p of pushes) assert.doesNotMatch(p, /\+|--force|--delete| -f\b|origin :/);
  });

  test('a lost race refuses the second claim naming the winner, and leaves one claim', () => {
    writeFileSync(join(fake, 'race'), '');
    const r = claim('7', 'team-x');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /team-y/);
    assert.equal(subject(ref(7)), 'claim 7 team-y');
    assert.equal(git(origin, 'rev-list', '--count', `${mainTip()}..${ref(7)}`), '1');
  });

  test('a handoff or release disarms and re-runs tier of each open pull request naming the issue, in that order', () => {
    claim('7', 'team-x');
    writeFileSync(
      join(fake, 'prs.json'),
      JSON.stringify([
        { number: 3, headRefOid: 'h3', body: 'Issue: #7\nTeam: team-x\n' },
        { number: 4, headRefOid: 'h4', body: 'Issue: #70\n' },
        { number: 5, headRefOid: 'h5', body: 'mentions Issue: #7 in passing' },
      ]),
    );
    writeFileSync(join(fake, 'gh-calls'), '');
    const r = claim('--handoff', '7', 'team-x', 'team-y');
    assert.equal(r.code, 0, r.out);
    const calls = ghCalls().filter((c) => !c.startsWith('issue comment'));
    const from = calls.findIndex((c) => c.startsWith('pr list --state open --search '));
    assert.deepEqual(calls.slice(from + 1), ['pr merge 3 --disable-auto', 'run list --workflow gate-trusted.yml --commit h3 --limit 1 --json databaseId,status', 'run view 9 --json jobs', 'run rerun --job 55']);
  });

  test('a run that cannot be re-run, or no run at all, is no failure: the claim has moved', () => {
    claim('7', 'team-x');
    writeFileSync(join(fake, 'prs.json'), JSON.stringify([{ number: 3, headRefOid: 'h3', body: 'Issue: #7\n' }]));
    writeFileSync(join(fake, 'rerun-fails'), '');
    const r = claim('--release', '7', 'team-x');
    assert.equal(r.code, 0, r.out);
    assert.equal(subject(ref(7)), 'release 7');
    claim('7', 'team-x');
    rmSync(join(fake, 'rerun-fails'));
    writeFileSync(join(fake, 'runs.json'), '[]');
    assert.equal(claim('--handoff', '7', 'team-x', 'team-y').code, 0);
  });

  test('a first claim re-runs nothing', () => {
    writeFileSync(join(fake, 'prs.json'), JSON.stringify([{ number: 3, headRefOid: 'h3', body: 'Issue: #7\n' }]));
    claim('7', 'team-x');
    assert.ok(!ghCalls().some((c) => c.startsWith('pr ') || c.startsWith('run ')));
  });

  test('the kit starts no workflow on a push to claim/<n>', () => {
    const out = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(Dir[ARGV[0]].map { |f| [File.basename(f), YAML.load_file(f)] }.to_h)', join(factory, 'kit/.github/workflows/*.yml')], { encoding: 'utf8' }).stdout;
    for (const [file, wf] of Object.entries(JSON.parse(out))) {
      const on = wf.on ?? wf.true;
      const events = typeof on === 'string' ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((e) => [e, null])) : on;
      assert.ok(!('create' in events), `${file} runs on create`);
      if ('push' in events) {
        const branches = events.push?.branches;
        assert.ok(Array.isArray(branches) && branches.every((b) => !/[*?[]/.test(b) && b !== 'claim/7'), `${file} runs on a push to any branch`);
        assert.equal(events.push['branches-ignore'], undefined);
      }
    }
  });

  test('the command is a kit file and runs from a clone with no work tree change', () => {
    assert.ok(existsSync(CLAIM));
    claim('7', 'team-x');
    assert.equal(git(work, 'status', '--porcelain'), '');
  });
});

// A tip that no form of claim wrote (a raw push) is the Human's to clear: he releases it with --human, no team does, and
// tier says what the tip is rather than that it was released.
describe('a claim ref whose tip no form of claim wrote', () => {
  let dir;
  let origin;
  let work;
  let fake;
  let stray;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'claim-invalid-'));
    origin = join(dir, 'origin.git');
    fake = join(dir, 'fake');
    mkdirSync(join(fake, 'bin'), { recursive: true });
    writeFileSync(join(fake, 'base-gh'), FAKE_GH);
    writeFileSync(join(fake, 'bin/gh'), '#!/bin/sh\ncase "$1 $2" in\n  "pr view") cat "$FAKE/prview.json" ;;\n  *) exec "$FAKE/base-gh" "$@" ;;\nesac\n');
    chmodSync(join(fake, 'base-gh'), 0o755);
    chmodSync(join(fake, 'bin/gh'), 0o755);
    const seed = join(dir, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    commit(seed, { 'README.md': '# app\n' }, 'start');
    git(dir, 'clone', '-q', '--bare', seed, origin);
    work = join(dir, 'work');
    git(dir, 'clone', '-q', origin, work);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    git(origin, 'update-ref', '-d', 'refs/heads/claim/7');
    for (const f of ['gh-calls', 'perm.json']) rmSync(join(fake, f), { force: true });
    writeFileSync(join(fake, 'gh-calls'), '');
    stray = git(work, 'commit-tree', 'origin/main^{tree}', '-p', 'origin/main', '-m', 'hello');
    git(work, 'push', '-q', 'origin', `${stray}:refs/heads/claim/7`);
  });
  const claim = (...args) => run(work, CLAIM, args, { ...quiet, PATH: `${join(fake, 'bin')}:${process.env.PATH}`, FAKE: fake });
  const admin = () => writeFileSync(join(fake, 'perm.json'), '{"viewerPermission":"ADMIN"}');
  const body = (text) => writeFileSync(join(fake, 'prview.json'), JSON.stringify({ body: text, closingIssuesReferences: [] }));
  const tip = () => git(origin, 'rev-parse', 'refs/heads/claim/7');

  test('the Human releases it with --human, as a fast-forward commit on the stray tip', () => {
    admin();
    const r = claim('--release', '7', '--human');
    assert.equal(r.code, 0, r.out);
    assert.equal(git(origin, 'log', '-1', '--format=%s', tip()), 'release 7');
    assert.equal(git(origin, 'log', '-1', '--format=%P', tip()), stray);
    const again = claim('7', 'team-x');
    assert.equal(again.code, 0, again.out);
  });

  test('no team releases it, and --human without admin rights does not', () => {
    assert.equal(claim('--release', '7', 'team-x').code, 1);
    assert.equal(claim('--release', '7', '--human').code, 1);
    admin();
    assert.equal(claim('--handoff', '7', '--human', 'team-y').code, 1);
    assert.equal(tip(), stray);
  });

  test('tier says the tip is not a claim, and that the Human decides; a released tip it still calls released', () => {
    body(`Issue: #7\nClaim: ${stray}\n`);
    const bad = claim('check', '--repo', 'o/app', '--pr', '7');
    assert.equal(bad.code, 1, bad.out);
    assert.doesNotMatch(bad.out, /released/);
    assert.match(bad.out, /Human/);
    admin();
    claim('--release', '7', '--human');
    body(`Issue: #7\nClaim: ${tip()}\n`);
    const released = claim('check', '--repo', 'o/app', '--pr', '7');
    assert.equal(released.code, 1, released.out);
    assert.match(released.out, /released/);
  });
});

// git matches an ls-remote pattern against the tail of a ref name, so refs/heads/claim/7 also matches the branch
// a/refs/heads/claim/7, which sorts before it; so does refs/heads/main. The claim ref and main are read by their exact names.
describe('a look-alike branch is not the claim ref or main', () => {
  let dir;
  let origin;
  let work;
  let other;
  let fake;
  let real;
  let hostile;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'claim-lookalike-'));
    origin = join(dir, 'origin.git');
    fake = join(dir, 'fake');
    mkdirSync(join(fake, 'bin'), { recursive: true });
    writeFileSync(join(fake, 'base-gh'), FAKE_GH);
    writeFileSync(join(fake, 'bin/gh'), '#!/bin/sh\ncase "$1 $2" in\n  "pr view") cat "$FAKE/prview.json" ;;\n  *) exec "$FAKE/base-gh" "$@" ;;\nesac\n');
    chmodSync(join(fake, 'base-gh'), 0o755);
    chmodSync(join(fake, 'bin/gh'), 0o755);
    writeFileSync(join(fake, 'gh-calls'), '');
    const seed = join(dir, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    commit(seed, { 'README.md': '# app\n' }, 'start');
    git(dir, 'clone', '-q', '--bare', seed, origin);
    work = join(dir, 'work');
    other = join(dir, 'other');
    git(dir, 'clone', '-q', origin, work);
    git(dir, 'clone', '-q', origin, other);
    // The real claim on 7 is team-x's; the look-alikes are team-y's claim on 7, a claim on 9 that nobody made, and a main.
    const claim = (...args) => run(work, CLAIM, args, { ...quiet, PATH: `${join(fake, 'bin')}:${process.env.PATH}`, FAKE: fake });
    assert.equal(claim('7', 'team-x').code, 0);
    real = git(origin, 'rev-parse', 'refs/heads/claim/7');
    git(other, 'fetch', '-q', 'origin');
    const forge = (ref, subject) => {
      const sha = git(other, 'commit-tree', 'origin/main^{tree}', '-p', 'origin/main', '-m', subject);
      git(other, 'push', '-q', 'origin', `${sha}:refs/heads/${ref}`);
      return sha;
    };
    hostile = forge('a/refs/heads/claim/7', 'claim 7 team-y');
    forge('a/refs/heads/claim/9', 'claim 9 team-y');
    forge('a/refs/heads/main', 'a main that is not main');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const claim = (...args) => run(work, CLAIM, args, { ...quiet, PATH: `${join(fake, 'bin')}:${process.env.PATH}`, FAKE: fake });
  const body = (text) => writeFileSync(join(fake, 'prview.json'), JSON.stringify({ body: text, closingIssuesReferences: [] }));
  const tipOn = (ref) => git(origin, 'rev-parse', `refs/heads/${ref}`);

  test('git does sort the look-alike first, so this world can tell the two apart', () => {
    const lines = git(work, 'ls-remote', 'origin', 'refs/heads/claim/7').split('\n');
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /refs\/heads\/a\/refs\/heads\/claim\/7$/);
  });

  test('take reads the real claim: a second team is refused naming team-x, not the look-alike\'s team-y', () => {
    const r = claim('7', 'team-z');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /team-x/);
    assert.doesNotMatch(r.out, /team-y/);
  });

  test('take with no real claim is not refused because a look-alike exists', () => {
    const r = claim('9', 'team-x');
    assert.equal(r.code, 0, r.out);
    assert.equal(git(origin, 'log', '-1', '--format=%s', tipOn('claim/9')), 'claim 9 team-x');
  });

  test('a first claim is made on main itself, not on a branch whose name ends in refs/heads/main', () => {
    const r = claim('8', 'team-x');
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(git(origin, 'log', '-1', '--format=%P', tipOn('claim/8')).split(' '), [tipOn('main')]);
  });

  test('--list shows the real claim on 7', () => {
    const row = claim('--list').out.trim().split('\n').map((l) => l.split('\t')).find((r) => r[0] === '7');
    assert.deepEqual(row.slice(1, 4), ['claimed', 'team-x', real.slice(0, 7)]);
  });

  test('check reads the real claim: its sha passes and the look-alike\'s is not the claim', () => {
    body(`Issue: #7\nClaim: ${real}\n`);
    const ok = claim('check', '--repo', 'o/app', '--pr', '7');
    assert.equal(ok.code, 0, ok.out);
    body(`Issue: #7\nClaim: ${hostile}\n`);
    const bad = claim('check', '--repo', 'o/app', '--pr', '7');
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /team-x/);
  });
});

// git matches a push destination by its own rules, not by exact name: for refs/heads/claim/7 it also takes, as a strong
// match, refs/refs/heads/claim/7, a branch named refs/heads/claim/7 (refs/heads/refs/heads/claim/7) and a tag of that name.
// None is under refs/heads/claim/**, so no ruleset covers it. A push must never land on one of them, nor be blamed on a race.
describe('a ref git would take for the claim ref when it pushes', () => {
  const SHAPES = {
    'refs/refs/heads/claim/7': 'refs/refs/heads/claim/7',
    'a branch named refs/heads/claim/7': 'refs/heads/refs/heads/claim/7',
    'a tag named refs/heads/claim/7': 'refs/tags/refs/heads/claim/7',
  };
  let dir;
  let origin;
  let work;
  let forger;
  let fake;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'claim-pushmatch-'));
    origin = join(dir, 'origin.git');
    fake = join(dir, 'fake');
    mkdirSync(join(fake, 'bin'), { recursive: true });
    writeFileSync(join(fake, 'bin/gh'), FAKE_GH);
    chmodSync(join(fake, 'bin/gh'), 0o755);
    const seed = join(dir, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    commit(seed, { 'README.md': '# app\n' }, 'start');
    git(dir, 'clone', '-q', '--bare', seed, origin);
    work = join(dir, 'work');
    forger = join(dir, 'forger');
    git(dir, 'clone', '-q', origin, work);
    git(dir, 'clone', '-q', origin, forger);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    for (const ref of git(origin, 'for-each-ref', '--format=%(refname)').split('\n').filter((r) => r && r !== 'refs/heads/main')) git(origin, 'update-ref', '-d', ref);
    for (const f of ['gh-calls', 'perm.json']) rmSync(join(fake, f), { force: true });
    writeFileSync(join(fake, 'gh-calls'), '');
  });
  const claim = (...args) => run(work, CLAIM, args, { ...quiet, PATH: `${join(fake, 'bin')}:${process.env.PATH}`, FAKE: fake });
  const refs = () => git(origin, 'for-each-ref', '--format=%(refname) %(objectname)');
  const ghCalls = () => readFileSync(join(fake, 'gh-calls'), 'utf8');
  /** Puts ref on origin, at main's tip or at a commit of its own. */
  const forge = (ref, own) => {
    git(forger, 'fetch', '-q', 'origin');
    const sha = own ? git(forger, 'commit-tree', 'origin/main^{tree}', '-p', 'origin/main', '-m', 'claim 7 team-y') : git(forger, 'rev-parse', 'origin/main');
    git(forger, 'push', '-q', 'origin', `${sha}:${ref}`);
  };

  for (const [name, ref] of Object.entries(SHAPES)) {
    for (const own of [false, true]) {
      test(`${name}, made before the claim ${own ? 'at a commit of its own' : "at main's tip"}: take refuses, names it, and changes no ref`, () => {
        forge(ref, own);
        const before = refs();
        const r = claim('7', 'team-x');
        assert.equal(r.code, 1, r.out);
        assert.ok(r.out.includes(ref), r.out);
        assert.equal(refs(), before, 'a ref on origin moved or appeared');
        assert.doesNotMatch(ghCalls(), /issue comment/);
      });
    }

    for (const [form, args] of [
      ['--release', ['--release', '7', 'team-x']],
      ['--handoff', ['--handoff', '7', 'team-x', 'team-y']],
      ['--release --human', ['--release', '7', '--human']],
    ]) {
      test(`${name}, made after the claim: ${form} refuses, names it, and is not called a race`, () => {
        assert.equal(claim('7', 'team-x').code, 0);
        forge(ref, false);
        writeFileSync(join(fake, 'perm.json'), '{"viewerPermission":"ADMIN"}');
        const before = refs();
        const r = claim(...args);
        assert.equal(r.code, 1, r.out);
        assert.ok(r.out.includes(ref), r.out);
        assert.doesNotMatch(r.out, /moved/);
        assert.equal(refs(), before);
      });
    }
  }
});
