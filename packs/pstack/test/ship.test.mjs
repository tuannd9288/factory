// scripts/ship (#85): one command that opens the pull request only after a local pass and then takes step 4's next step,
// against a fake gh, in a copy of the kit and the pstack pack with a real bare origin.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, run, quiet } from '../../../test/helpers.mjs';

// gh: the one pull request is $SH/pr.json (absent: none); every call is appended to $SH/gh-calls.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const sh = process.env.SH;
const a = process.argv.slice(2);
fs.appendFileSync(sh + '/gh-calls', a.join(' ') + '\n');
const read = () => (fs.existsSync(sh + '/pr.json') ? JSON.parse(fs.readFileSync(sh + '/pr.json', 'utf8')) : null);
const out = (s) => { process.stdout.write(s); process.exit(0); };
// The repository's merge methods are $SH/methods.json, both allowed by default.
if (a[0] === 'repo' && a[1] === 'view') out(fs.existsSync(sh + '/methods.json') ? fs.readFileSync(sh + '/methods.json', 'utf8') : '{"squashMergeAllowed":true,"mergeCommitAllowed":true}');
if (a[0] === 'pr' && a[1] === 'ready') { const pr = read(); pr.isDraft = a.includes('--undo'); fs.writeFileSync(sh + '/pr.json', JSON.stringify(pr)); out('ok\n'); }
// The pull request's last base change and its head commit's date, from pr.json's baseChange and committedDate.
if (a[0] === 'api' && a[1] === 'graphql') {
  const pr = read();
  out(JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: pr.baseChange ? [pr.baseChange] : [] }, commits: { nodes: [{ commit: { committedDate: pr.committedDate ?? '2026-11-07T00:00:00Z' } }] } } } } }));
}
if (a[0] === 'pr' && a[1] === 'list' && a.includes('merged'))
  out(fs.existsSync(sh + '/parent.json') ? fs.readFileSync(sh + '/parent.json', 'utf8') : '[]');
if (a[0] === 'pr' && a[1] === 'edit') {
  const pr = read();
  if (a.includes('--add-label')) pr.labels = [...pr.labels, { name: a[a.indexOf('--add-label') + 1] }];
  if (a.includes('--base')) {
    pr.baseRefName = a[a.indexOf('--base') + 1];
    pr.baseRefOid = fs.readFileSync(sh + '/base', 'utf8').trim();
  }
  fs.writeFileSync(sh + '/pr.json', JSON.stringify(pr));
  out('ok\n');
}
if (a[0] === 'pr' && a[1] === 'list') { const pr = read(); out(JSON.stringify(pr ? [pr] : [])); }
if (a[0] === 'pr' && a[1] === 'create') {
  fs.copyFileSync(a[a.indexOf('--body-file') + 1], sh + '/created-body');
  const head = fs.readFileSync(sh + '/head', 'utf8').trim();
  const base = fs.readFileSync(sh + '/base', 'utf8').trim();
  fs.writeFileSync(sh + '/pr.json', JSON.stringify({ number: 7, title: a[a.indexOf('--title') + 1], url: 'https://github.com/o/app/pull/7', baseRefName: a[a.indexOf('--base') + 1], baseRefOid: base, headRefOid: head, labels: [], isDraft: a.includes('--draft'), autoMergeRequest: null, statusCheckRollup: [] }));
  out('https://github.com/o/app/pull/7\n');
}
if (a[0] === 'pr' && a[1] === 'view') out(JSON.stringify({ mergeStateStatus: read().mergeStateStatus }));
if (a[0] === 'pr' && a[1] === 'merge') {
  // $SH/arm-refused: GitHub refuses to enable auto-merge, as gh 2.102.0 reports it.
  if (a.includes('--auto') && fs.existsSync(sh + '/arm-refused')) {
    process.stderr.write('GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)\n');
    process.exit(1);
  }
  const pr = read();
  pr.autoMergeRequest = a.includes('--auto') ? { mergeMethod: 'MERGE' } : null;
  fs.writeFileSync(sh + '/pr.json', JSON.stringify(pr));
  out('ok\n');
}
process.stderr.write('fake gh: ' + a.join(' ') + '\n');
process.exit(1);
`;

const BODY = '**Tóm tắt cho anh**\n- **Anh quyết:** x\n- **Đề xuất:** Approve.\n- **Rủi ro:** y\n\n**TL;DR**\n- **You decide:** x\n- **Recommendation:** Approve.\n- **Risk:** y\n\n<details>\n<summary>The change in detail</summary>\n\n- Purpose: names the operation\n\n</details>\n\nCloses #3\n';

const directories = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the kit on branch `work` (one commit past `main`, which origin holds), with stamps and fakes on request. Each run of ship
 * finds a reviewer's PASS on the head it runs at (FAC-101), unless `reviewed` is false; `review` appends a reviewer seat's record. */
function world({ driver = true, stacks, merge, drafts = 'pstack', reviewed = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ship-')));
  directories.push(dir);
  const repo = join(dir, 'app');
  const sh = join(dir, 'sh');
  cpSync(join(factory, 'kit'), repo, { recursive: true });
  // What a pstack team copies into its repository (packs/pstack/INSTALL.md): the pack's scripts.
  cpSync(join(factory, 'packs/pstack/scripts'), join(repo, 'scripts'), { recursive: true });
  // main's switches, which ship reads at origin/main; `driver: 'absent'` leaves the file out.
  if (driver !== 'absent') writeFileSync(join(repo, '.gate/driver.json'), JSON.stringify({ stacks, merge, drafts: drafts ?? undefined }));
  mkdirSync(sh);
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, { 'cli.js': 'console.log(1);\n' }, 'start');
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(repo, 'remote', 'add', 'origin', join(dir, 'origin.git'));
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'switch', '-q', '-c', 'work');
  commit(repo, { 'cli.js': 'console.log(2);\n' }, 'fix(cli): print two');
  git(repo, 'push', '-q', 'origin', 'work');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/gh'), FAKE_GH);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  writeFileSync(join(dir, 'body.md'), BODY);
  const gitdir = () => join(git(repo, 'rev-parse', '--absolute-git-dir'), 'factory');
  const w = {
    dir,
    repo,
    sh,
    head: () => git(repo, 'rev-parse', 'HEAD'),
    stamp: (name) => {
      mkdirSync(gitdir(), { recursive: true });
      writeFileSync(join(gitdir(), name), '');
    },
    passed: (base = git(repo, 'rev-parse', 'origin/main')) => {
      w.stamp(`red-check-${w.head()}-${base}`);
    },
    review: (over = {}) => {
      mkdirSync(join(dir, 'state'), { recursive: true });
      const record = { role: 'reviewer', team: 'app-pig', repo: 'o/app', tag: 'review1', session: 's1', head: w.head(), structured: { conclusion: 'PASS' }, ...over };
      appendFileSync(join(dir, 'state', 'sessions.jsonl'), `${JSON.stringify(record)}\n`);
    },
    ship: (args = ['--body-file', join(dir, 'body.md')]) => {
      writeFileSync(join(sh, 'head'), w.head());
      writeFileSync(join(sh, 'base'), git(repo, 'rev-parse', 'origin/main'));
      if (reviewed) w.review();
      return run(repo, join(repo, 'scripts/ship'), args, { ...quiet, SH: sh, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GH_TOKEN: 'not-a-token', FACTORY_STATE: join(dir, 'state'), FACTORY_TEAM: 'app-pig' });
    },
    pr: (over) => writeFileSync(join(sh, 'pr.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(sh, 'pr.json'), 'utf8')), ...over })),
    read: (name) => (existsSync(join(sh, name)) ? readFileSync(join(sh, name), 'utf8') : ''),
    calls: () => w.read('gh-calls').split('\n').filter(Boolean),
  };
  return w;
}

test('removes every world when its test ends', async (t) => {
  const dirs = [];
  t.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  await t.test('creates two worlds', () => {
    dirs.push(world().dir, world().dir);
    for (const dir of dirs) assert.ok(existsSync(dir));
  });
  for (const dir of dirs) assert.ok(!existsSync(dir), `world remains: ${dir}`);
});

describe('opening the pull request', () => {
  for (const driver of [true, 'absent']) {
    test(`default opens a draft with ${driver === true ? 'no drafts key' : 'no driver file'}`, () => {
      const w = world({ driver, drafts: null });
      w.passed();
      const out = w.ship();
      assert.equal(out.code, 0, out.out);
      assert.ok(w.calls().find((c) => c.startsWith('pr create')).includes('--draft'));
      assert.equal(w.ship().code, 0);
      assert.ok(!w.calls().some((c) => c.includes('--auto')));
    });
  }

  test('landable opens a draft using main policy, keeps it one until verify passed on its head with no conflict, then readies and arms it (FAC-55)', () => {
    const w = world({ drafts: 'landable' });
    writeFileSync(join(w.repo, '.gate/driver.json'), JSON.stringify({ drafts: 'pstack' }));
    w.passed();
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.ok(w.calls().find((c) => c.startsWith('pr create')).includes('--draft'));
    const tier = { name: 'tier', status: 'COMPLETED', conclusion: 'SUCCESS' };
    const verify = (conclusion, startedAt) => ({ name: 'verify', status: 'COMPLETED', conclusion, startedAt });
    for (const over of [
      { statusCheckRollup: [tier] },
      { statusCheckRollup: [tier, verify('SUCCESS', '2026-11-07T01:00:00Z'), verify('FAILURE', '2026-11-07T02:00:00Z')] },
      { statusCheckRollup: [tier, verify('SUCCESS')], mergeable: 'CONFLICTING' },
    ]) {
      w.pr(over);
      assert.equal(w.ship().code, 0);
      assert.ok(!w.calls().some((c) => c.startsWith('pr ready') || c.includes('--auto')), JSON.stringify(over));
    }
    w.pr({ statusCheckRollup: [tier, verify('FAILURE', '2026-11-07T01:00:00Z'), verify('SUCCESS', '2026-11-07T02:00:00Z')], mergeable: 'MERGEABLE' });
    const armed = w.ship();
    assert.equal(armed.code, 0, armed.out);
    const after = w.calls().slice(w.calls().indexOf('pr ready 7'));
    assert.deepEqual(after.filter((c) => c.startsWith('pr ready') || c.startsWith('pr merge')), ['pr ready 7', `pr merge 7 --auto --squash --match-head-commit ${w.head()}`]);
  });

  test('a draft moved onto main is readied only once its parent landed and its head holds that landing (INN-38 A, FAC-55)', () => {
    const w = world({ drafts: 'landable' });
    w.passed();
    assert.equal(w.ship().code, 0);
    const green = { statusCheckRollup: [{ name: 'tier', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    w.pr({ ...green, baseChange: { previousRefName: 'parent', currentRefName: 'main', createdAt: '2026-11-07T01:00:00Z' } });
    const held = (pattern) => {
      const out = w.ship();
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, pattern);
      assert.ok(!w.calls().some((c) => c.startsWith('pr ready') || c.includes('--auto')));
    };
    // Moved by hand before its parent landed, as #490 was: its parent's change is not on main.
    held(/its parent parent has not landed/);
    // The parent landed; the child's head does not hold that landing yet: the queue's restack is pending, whatever its verify's time.
    const other = join(w.dir, 'other');
    git(w.dir, 'clone', '-q', join(w.dir, 'origin.git'), other);
    const landing = commit(other, { 'parent.js': 'landed\n' }, 'Land parent (#6)');
    git(other, 'push', '-q', 'origin', 'main');
    writeFileSync(join(w.sh, 'parent.json'), JSON.stringify([{ headRefOid: landing, mergeCommit: { oid: landing } }]));
    held(/restack/);
    // Restacked: its head holds the landing, as after the queue's merge of main, or its Lead's.
    git(w.repo, 'fetch', '-q', 'origin');
    git(w.repo, 'merge', '--no-ff', '--no-edit', 'origin/main');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.pr({ headRefOid: w.head() });
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.ok(w.calls().includes('pr ready 7'), w.calls().join('\n'));
    assert.ok(w.calls().includes(`pr merge 7 --auto --squash --match-head-commit ${w.head()}`));
  });



  test('is refused without a red-check stamp, and for one against another base', () => {
    const w = world();
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused: HEAD [0-9a-f]{7} has no red-check stamp against origin\/main [0-9a-f]{7}; run \.gate\/bin\/red-check --base origin\/main$/m);
    w.stamp(`red-check-${w.head()}-${'0'.repeat(40)}`);
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /no red-check stamp against origin\/main/);
    assert.ok(!w.calls().some((c) => c.startsWith('pr create')));
  });

  // FAC-14: the factory runs the pack from its source. Its root has scripts/verify and scripts/ship, the kit under kit/, no .gate/ and no
  // pull request template, so no red-check; CI runs scripts/verify.
  test('in a checkout shaped like the factory, scripts/ship opens a draft on main with the body as given, and no red-check stamp (FAC-14)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ship-')));
    directories.push(dir);
    const repo = join(dir, 'factory');
    const sh = join(dir, 'sh');
    for (const path of ['kit', 'packs/pstack/scripts', 'scripts']) cpSync(join(factory, path), join(repo, path), { recursive: true });
    mkdirSync(sh);
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), FAKE_GH);
    chmodSync(join(dir, 'bin/gh'), 0o755);
    git(repo, 'init', '-q', '-b', 'main');
    commit(repo, {}, 'start');
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(repo, 'remote', 'add', 'origin', join(dir, 'origin.git'));
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'switch', '-q', '-c', 'fac-14-ship-here');
    commit(repo, { 'bin/x.mjs': 'export const x = 1;\n' }, 'feat(factory): add x');
    git(repo, 'push', '-q', 'origin', 'fac-14-ship-here');
    const body = BODY.replace('Closes #3\n', 'Issue: FAC-14\nTeam: lead\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n');
    writeFileSync(join(dir, 'body.md'), body);
    writeFileSync(join(sh, 'head'), git(repo, 'rev-parse', 'HEAD'));
    writeFileSync(join(sh, 'base'), git(repo, 'rev-parse', 'origin/main'));
    // An empty state folder: here no reviewer record is required (FAC-101), since Colly and the supervising session review.
    const ship = () => run(repo, join(repo, 'scripts/ship'), ['--body-file', join(dir, 'body.md')], { ...quiet, SH: sh, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GH_TOKEN: 'not-a-token', FACTORY_STATE: join(dir, 'state'), FACTORY_TEAM: 'factory-pig' });
    const out = ship();
    assert.equal(out.code, 0, out.out);
    const calls = () => readFileSync(join(sh, 'gh-calls'), 'utf8').split('\n').filter(Boolean);
    const create = calls().find((c) => c.startsWith('pr create'));
    assert.match(create, /--base main --head fac-14-ship-here --title feat\(factory\): add x /);
    assert.ok(create.includes('--draft'));
    assert.equal(readFileSync(join(sh, 'created-body'), 'utf8'), body);
    // Once verify passed, ship readies it and arms it with this repository's own method, merge commits: every pull request here waits
    // for the Human, so it stops there.
    writeFileSync(join(sh, 'methods.json'), JSON.stringify({ squashMergeAllowed: false, mergeCommitAllowed: true }));
    const pr = JSON.parse(readFileSync(join(sh, 'pr.json'), 'utf8'));
    writeFileSync(join(sh, 'pr.json'), JSON.stringify({ ...pr, statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    const armed = ship();
    assert.equal(armed.code, 1, armed.out);
    assert.match(armed.out, /waits for the Human's approval/);
    assert.deepEqual(calls().filter((c) => c.startsWith('pr ready') || c.startsWith('pr merge')), ['pr ready 7', `pr merge 7 --auto --merge --match-head-commit ${pr.headRefOid}`]);
  });

  test('is refused when origin/main moved past the base red-check judged', () => {
    const w = world();
    w.passed();
    git(w.repo, 'switch', '-q', 'main');
    commit(w.repo, { 'other.js': 'x\n' }, 'main moves');
    git(w.repo, 'push', '-q', 'origin', 'main');
    git(w.repo, 'fetch', '-q', 'origin');
    git(w.repo, 'switch', '-q', 'work');
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /no red-check stamp against origin\/main/);
  });

  test('pstack opens ready through gh pr create --body-file once the red-check stamp names the head, with no verify stamp', () => {
    const w = world();
    w.passed();
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: opened #7 https:\/\/github\.com\/o\/app\/pull\/7$/m);
    const create = w.calls().find((c) => c.startsWith('pr create'));
    assert.ok(!create.includes('--draft'));
    assert.match(create, /--base main/);
    assert.match(create, /--head work/);
    assert.match(create, /--title fix\(cli\): print two/);
    assert.match(create, /--body-file /);
    assert.equal(w.read('created-body'), BODY);
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')), 'it opens, and goes no further in the same run');
  });

  test('takes the title from the last subject without its trailing issue number, and --title as given', () => {
    let w = world();
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'fix(cli): print three (#12)');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.passed();
    assert.equal(w.ship().code, 0);
    assert.match(w.calls().find((c) => c.startsWith('pr create')), /--title fix\(cli\): print three --body-file /);
    w = world();
    w.passed();
    assert.equal(w.ship().code, 0);
    assert.match(w.calls().find((c) => c.startsWith('pr create')), /--title fix\(cli\): print two --body-file /);
    w = world();
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'fix(cli): print three (#12)');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.passed();
    assert.equal(w.ship(['--body-file', join(w.dir, 'body.md'), '--title', 'fix(cli): use given (#12)']).code, 0);
    assert.match(w.calls().find((c) => c.startsWith('pr create')), /--title fix\(cli\): use given \(#12\) --body-file /);
  });

  test('refuses a body that still holds the template\'s placeholder', () => {
    const w = world();
    w.passed();
    const out = w.ship(['--body-file', join(w.repo, '.github/pull_request_template.md')]);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused: the body still holds the template's "Closes #<issue labelled task>"; pass --body-file with the issue number filled in$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr create')));
  });

  test('opens a body that carries Fixes <KEY> and Issue: <KEY> in place of the Closes line (#404), and refuses one that keeps the template\'s Issue line', () => {
    const w = world();
    w.passed();
    const linear = BODY.replace('Closes #3\n', 'Fixes FAC-12\nIssue: FAC-12\n');
    writeFileSync(join(w.dir, 'linear.md'), linear);
    const out = w.ship(['--body-file', join(w.dir, 'linear.md')]);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: opened #7 /m);
    assert.equal(w.read('created-body'), linear);
    const kept = world();
    kept.passed();
    writeFileSync(join(kept.dir, 'mixed.md'), BODY.replace('Closes #3\n', 'Fixes FAC-12\nIssue: #<issue labelled task>\n'));
    const mixed = kept.ship(['--body-file', join(kept.dir, 'mixed.md')]);
    assert.equal(mixed.code, 1, mixed.out);
    assert.ok(!kept.calls().some((c) => c.startsWith('pr create')));
  });

  test('is refused on main and on a detached head', () => {
    const w = world();
    git(w.repo, 'switch', '-q', 'main');
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused: the branch is main; work on a branch of its own$/m);
    git(w.repo, 'switch', '-q', '--detach');
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused: HEAD is on no branch$/m);
  });
});

describe('the steps after it opened', () => {
  const opened = () => {
    const w = world();
    w.passed();
    assert.equal(w.ship().code, 0);
    return w;
  };

  test('a second run arms; a third finds nothing to do', () => {
    const w = opened();
    let out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: armed #7 at HEAD [0-9a-f]{7}\b/m);
    assert.ok(w.calls().includes(`pr merge 7 --auto --squash --match-head-commit ${w.head()}`), w.calls().join('\n'));
    out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: #7 is armed; nothing to do$/m);
    assert.equal(w.calls().filter((c) => c.startsWith('pr merge')).length, 1);
  });

  test('stops on a ready pull request that is not armed, before the arm (#304)', () => {
    for (const mergeStateStatus of ['CLEAN', 'HAS_HOOKS', 'UNSTABLE']) {
      const w = opened();
      w.pr({ mergeStateStatus });
      const out = w.ship();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ship: stopped on #7: it is ready to merge and not armed; the Human merges it$/m);
      assert.ok(!w.calls().some((c) => c.startsWith('pr merge')), w.calls().join('\n'));
    }
  });

  test('stops when GitHub refuses the arm because auto-merge is off (#304)', () => {
    const w = opened();
    w.pr({ mergeStateStatus: 'BLOCKED' });
    writeFileSync(join(w.sh, 'arm-refused'), '');
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: stopped on #7: auto-merge is off on this repository; the Human merges it$/m);
    assert.doesNotMatch(out.out, /could not run|armed #7/);
  });

  test('refuses to arm when stacks is off and the base is not main', () => {
    const w = world({ stacks: 'off' });
    w.passed();
    assert.equal(w.ship().code, 0);
    w.pr({ baseRefName: 'develop' });
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused to arm #7: its base is develop, not main$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')));
  });

  test('disarms an armed pull request first when HEAD has a commit the pull request lacks', () => {
    const w = opened();
    assert.equal(w.ship().code, 0);
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'A new patch');
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: disarmed #7: HEAD [0-9a-f]{7} is past what was verified; push it, then run ship again$/m);
    assert.equal(w.calls().at(-1), 'pr merge 7 --disable-auto');
  });

  test('stops while the pull request carries needs-human', () => {
    const w = opened();
    w.pr({ labels: [{ name: 'needs-human' }] });
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: stopped on #7: it carries needs-human; the Human decides$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')));
  });

  test('arms a tier-3 pull request, then stops while its tier check waits, and is done once it is green', () => {
    const w = opened();
    w.pr({ labels: [{ name: 'tier-3' }], statusCheckRollup: [{ name: 'tier', status: 'IN_PROGRESS', conclusion: '' }] });
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: armed #7/m);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval \(unless the merge switch is at all\)$/m);
    assert.ok(w.calls().includes(`pr merge 7 --auto --squash --match-head-commit ${w.head()}`));
    w.pr({ statusCheckRollup: [{ name: 'tier', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: #7 is armed; nothing to do$/m);
  });

  test('a disarm comes before the stop', () => {
    const w = opened();
    assert.equal(w.ship().code, 0);
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'A new patch');
    w.pr({ labels: [{ name: 'needs-human' }] });
    const out = w.ship();
    assert.match(out.out, /^ship: disarmed #7/m);
    assert.equal(w.calls().at(-1), 'pr merge 7 --disable-auto');
  });
});

// .gate/bin/tier: prints the tier in $SH/tier, and logs its arguments.
const FAKE_TIER = String.raw`#!/usr/bin/env node
const fs = require('fs');
const sh = process.env.SH;
fs.appendFileSync(sh + '/tier-calls', process.argv.slice(2).join(' ') + '\n');
console.log('tier ' + fs.readFileSync(sh + '/tier', 'utf8').trim());
`;

// FAC-101: ship arms only a head its team's reviewer passed, read from the reviewer seat's record in sessions.jsonl.
describe('the reviewer\'s PASS', () => {
  const opened = () => {
    const w = world({ reviewed: false });
    w.passed();
    assert.equal(w.ship().code, 0);
    return w;
  };
  const arms = (w) => w.calls().filter((c) => c.includes('--auto'));

  test('with no PASS on the head ship refuses to arm and says so; another team\'s, another repository\'s or a worker\'s do not count; a PASS on that head arms it', () => {
    const w = opened();
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /refused to arm #7: no reviewer PASS/);
    w.review({ team: 'app-other' });
    w.review({ repo: 'o/other' });
    w.review({ role: 'worker' });
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.deepEqual(arms(w), []);
    w.review({ tag: 'review2', session: 'sess-2' });
    out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /armed #7 at HEAD [0-9a-f]{7}: .*review2.*sess-2/);
    assert.deepEqual(arms(w), [`pr merge 7 --auto --squash --match-head-commit ${w.head()}`]);
  });

  test('a pushed commit that changes the patch disarms and needs its own PASS; a merge of main that leaves the patch as it was keeps it', () => {
    const w = opened();
    w.review();
    assert.equal(w.ship().code, 0);
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'fix(cli): print three');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.pr({ headRefOid: w.head() });
    let out = w.ship();
    assert.match(out.out, /disarmed #7: no reviewer PASS/);
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /refused to arm #7: no reviewer PASS/);
    w.review({ tag: 'review2', session: 's2' });
    assert.equal(w.ship().code, 0);
    // main moves and is merged in, the change untouched: the armed pull request stays armed, and once disarmed it arms again on review2.
    const other = join(w.dir, 'other');
    git(w.dir, 'clone', '-q', join(w.dir, 'origin.git'), other);
    commit(other, { 'other.js': 'x\n' }, 'feat(other): add other');
    git(other, 'push', '-q', 'origin', 'main');
    git(w.repo, 'fetch', '-q', 'origin');
    git(w.repo, 'merge', '--no-ff', '--no-edit', 'origin/main');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.pr({ headRefOid: w.head() });
    out = w.ship();
    assert.match(out.out, /#7 is armed; nothing to do/);
    w.pr({ autoMergeRequest: null });
    out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /armed #7 at HEAD [0-9a-f]{7}: .*review2/);
  });

  test('the newest record on the patch decides: a FAIL after a PASS refuses, and names the FAIL', () => {
    const w = opened();
    w.review({ tag: 'review1', session: 's1' });
    w.review({ tag: 'review2', session: 's2', structured: { conclusion: 'FAIL: cli.js prints the wrong number' } });
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /review2 \(session s2\), concluded FAIL/);
    assert.deepEqual(arms(w), []);
  });

  test('a PASS with a raise labels the pull request needs-human before arming it, then stops on the Human\'s wait', () => {
    const w = opened();
    w.review({ structured: { conclusion: 'PASS', raise: 'secrets: cli.js reads the token file' } });
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    const calls = w.calls();
    const label = calls.indexOf('pr edit 7 --add-label needs-human');
    assert.ok(label >= 0 && calls.findIndex((c) => c.includes('--auto')) > label, calls.join('\n'));
    assert.match(out.out, /needs-human/);
  });
});

describe('a tier 3 that the paths make, with no label on the pull request', () => {
  const opened = (tier) => {
    const w = world();
    w.passed();
    assert.equal(w.ship().code, 0);
    writeFileSync(join(w.repo, '.gate/bin/tier'), FAKE_TIER);
    git(w.repo, 'update-index', '--assume-unchanged', '.gate/bin/tier');
    writeFileSync(join(w.sh, 'tier'), `${tier}\n`);
    return w;
  };
  const waiting = [{ name: 'tier', status: 'IN_PROGRESS', conclusion: '' }];

  test('is judged by .gate/bin/tier on origin/main, HEAD and the pull request\'s labels', () => {
    const w = opened(1);
    w.pr({ labels: [{ name: 'task' }, { name: 'tier-2' }] });
    assert.equal(w.ship().code, 0);
    assert.equal(w.read('tier-calls'), '--base origin/main --head HEAD --labels task,tier-2\n');
  });

  test('arms it, then stops with the line, and a later run stops again', () => {
    const w = opened(3);
    w.pr({ statusCheckRollup: waiting });
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: armed #7/m);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval \(unless the merge switch is at all\)$/m);
    assert.ok(w.calls().includes(`pr merge 7 --auto --squash --match-head-commit ${w.head()}`));
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval \(unless the merge switch is at all\)$/m);
    assert.equal(w.calls().filter((c) => c.startsWith('pr merge')).length, 1);
  });

  test('is no wait once the tier check passed, and a running tier check below tier 3 is none', () => {
    let w = opened(3);
    w.pr({ statusCheckRollup: [{ name: 'tier', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    let out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.doesNotMatch(out.out, /waits for the Human/);
    w = opened(2);
    w.pr({ statusCheckRollup: waiting });
    out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: armed #7/m);
    assert.doesNotMatch(out.out, /waits for the Human/);
  });
});

describe('pushing', () => {
  test('is never refused by ship: not before the pull request, not while it is stopped or refused', () => {
    const w = world();
    assert.equal(w.ship().code, 1, 'no stamps: refused');
    git(w.repo, 'push', '-q', 'origin', 'work');
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'fix(cli): print more');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.passed();
    assert.equal(w.ship().code, 0);
    w.pr({ labels: [{ name: 'needs-human' }] });
    assert.equal(w.ship().code, 1, 'needs-human: stopped');
    commit(w.repo, { 'cli.js': 'console.log(4);\n' }, 'Even more');
    git(w.repo, 'push', '-q', 'origin', 'work');
    assert.equal(git(w.repo, 'rev-parse', 'origin/work'), w.head());
  });
});

describe('a tier 3 whose tier check is red, which is how the kit shows the wait for the Human', () => {
  const failed = [{ name: 'tier', status: 'COMPLETED', conclusion: 'FAILURE' }];
  const opened = (tier, labels = []) => {
    const w = world();
    w.passed();
    assert.equal(w.ship().code, 0);
    writeFileSync(join(w.repo, '.gate/bin/tier'), FAKE_TIER);
    git(w.repo, 'update-index', '--assume-unchanged', '.gate/bin/tier');
    writeFileSync(join(w.sh, 'tier'), `${tier}\n`);
    w.pr({ labels: labels.map((name) => ({ name })), statusCheckRollup: failed });
    return w;
  };

  test('by the label: armed, then stopped, and stopped again on the next run', () => {
    const w = opened(3, ['tier-3']);
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: armed #7/m);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval \(unless the merge switch is at all\)$/m);
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval \(unless the merge switch is at all\)$/m);
    assert.doesNotMatch(out.out, /nothing to do/);
  });

  test('by .gate/bin/tier on the paths: the same', () => {
    const w = opened(3);
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval \(unless the merge switch is at all\)$/m);
  });

  test('below tier 3 a red tier check is no wait of the Human\'s', () => {
    const w = opened(2);
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.doesNotMatch(out.out, /waits for the Human/);
  });

  test('when .gate/bin/tier cannot judge, ship fails closed: no arming', () => {
    const w = opened(3);
    writeFileSync(join(w.repo, '.gate/bin/tier'), '#!/bin/sh\necho "tier: could not read the policy"\nexit 2\n');
    const out = w.ship();
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /^ship: could not judge the tier \(\.gate\/bin\/tier exited 2\)$/m);
    assert.equal(w.calls().filter((c) => c.startsWith('pr merge')).length, 0);
  });
});

describe('a red-check that passed by the body\'s No-red line', () => {
  const LINE = 'No-red: a rename with no behaviour to show first';
  const passedByLine = () => {
    const w = world();
    w.stamp(`red-check-${w.head()}-${git(w.repo, 'rev-parse', 'origin/main')}`);
    writeFileSync(join(git(w.repo, 'rev-parse', '--absolute-git-dir'), 'factory', `red-check-${w.head()}-${git(w.repo, 'rev-parse', 'origin/main')}`), `${LINE}\n`);
    return w;
  };

  test('refuses a body file that lacks that line, and names it', () => {
    const w = passedByLine();
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, new RegExp(`^ship: refused: red-check passed by the body's "${LINE}"; the body file lacks that line$`, 'm'));
    assert.ok(!w.calls().some((c) => c.startsWith('pr create')));
  });

  test('opens with a body file that holds it', () => {
    const w = passedByLine();
    writeFileSync(join(w.dir, 'body.md'), `${BODY}\n${LINE}\n`);
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: opened #7/m);
  });
});

describe('a remote branch at a commit HEAD does not contain', () => {
  // Another clone puts a commit on origin/work, which this repository has not fetched.
  const ahead = (w) => {
    const other = join(w.dir, 'other');
    git(w.dir, 'clone', '-q', join(w.dir, 'origin.git'), other);
    git(other, 'switch', '-q', 'work');
    const sha = commit(other, { 'other.js': 'x\n' }, 'Someone else pushed');
    git(other, 'push', '-q', 'origin', 'work');
    return sha;
  };

  test('is told to pull first, when origin is ahead and when the branches diverged', () => {
    const w = world();
    const theirs = ahead(w);
    w.passed();
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, new RegExp(`^ship: refused: origin/work is at ${theirs.slice(0, 7)}, which HEAD [0-9a-f]{7} does not contain; pull first$`, 'm'));
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'Mine, not pushed');
    w.passed();
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /which HEAD [0-9a-f]{7} does not contain; pull first$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr create')));
  });

  test('keeps "push HEAD first" for a remote that HEAD contains', () => {
    const w = world();
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'Not pushed');
    w.passed();
    const out = w.ship();
    assert.match(out.out, /not HEAD [0-9a-f]{7}; push HEAD first$/m);
    assert.doesNotMatch(out.out, /pull/);
  });

  test('keeps today\'s message and adds "or pull, if origin is ahead" when origin\'s commit cannot be fetched', () => {
    const w = world();
    const theirs = ahead(w);
    w.passed();
    writeFileSync(join(w.sh, 'head'), w.head());
    // origin answers the first connection (ls-remote) and refuses every later one (the fetch).
    const once = join(w.dir, 'upload-pack-once');
    writeFileSync(once, '#!/bin/sh\nn=$(cat "$0.n" 2>/dev/null || echo 0)\necho $((n + 1)) >"$0.n"\n[ "$n" -eq 0 ] || exit 1\nexec git upload-pack "$@"\n', { mode: 0o755 });
    const out = run(w.repo, join(w.repo, 'scripts/ship'), ['--body-file', join(w.dir, 'body.md')], {
      ...quiet,
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_3: 'remote.origin.uploadpack',
      GIT_CONFIG_VALUE_3: once,
      SH: w.sh,
      PATH: `${join(w.dir, 'bin')}:${process.env.PATH}`,
      GH_TOKEN: 'not-a-token',
    });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, new RegExp(`^ship: refused: origin/work is at ${theirs.slice(0, 7)}, not HEAD [0-9a-f]{7}; push HEAD first, or pull, if origin is ahead$`, 'm'));
  });
});

describe('a missing stamp', () => {
  const HINT = /^ship: if the work tree is not clean, commit or remove what `git status` shows$/m;

  test('adds, to the refusal for a red-check stamp, what to do when the tree is not clean', () => {
    const w = world();
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /has no red-check stamp/);
    assert.match(out.out, HINT);
  });
});

describe('the remote branch', () => {
  test('is read from origin, and opening is refused while it is behind HEAD, or missing', () => {
    const w = world();
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'Not pushed');
    w.passed();
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused: origin\/work is at [0-9a-f]{7}, not HEAD [0-9a-f]{7}; push HEAD first$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr create')), w.calls().join('\n'));
    git(w.repo, 'switch', '-q', '-c', 'fresh');
    w.passed();
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused: origin has no branch fresh; push HEAD first$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr create')));
  });

  test('lets the pull request open once HEAD is pushed', () => {
    const w = world();
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'fix(cli): print three');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.passed();
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: opened #7/m);
  });

  test('is read again before arming: a pull request whose remote is behind HEAD is not armed', () => {
    const w = world();
    w.passed();
    assert.equal(w.ship().code, 0);
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'Not pushed');
    w.pr({ headRefOid: w.head() });
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused: origin\/work is at [0-9a-f]{7}, not HEAD [0-9a-f]{7}; push HEAD first$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')));
  });
});

describe('stacked pull requests', () => {
  test('opens a child against its parent, by default and with pstack explicit', () => {
    for (const stacks of [undefined, 'pstack']) {
      const w = world({ stacks });
      w.passed();
      const out = w.ship(['--base', 'parent', '--body-file', join(w.dir, 'body.md')]);
      assert.equal(out.code, 0, out.out);
      assert.match(w.calls().find((c) => c.startsWith('pr create')), /--base parent /);
    }
  });

  test('waits without arming while the parent is not merged', () => {
    const w = world();
    w.passed();
    assert.equal(w.ship().code, 0);
    w.pr({ baseRefName: 'parent' });
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /waits for its parent/);
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge') || c.startsWith('pr edit')));
  });

  test('with merge commits, waits until the parent is in origin/main, then only moves the child to main', () => {
    const w = world({ merge: 'merge' });
    const parent = w.head();
    git(w.repo, 'branch', 'parent');
    commit(w.repo, { 'child.js': 'child\n' }, 'feat(cli): add child');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.passed();
    assert.equal(w.ship(['--base', 'parent', '--body-file', join(w.dir, 'body.md')]).code, 0);
    w.pr({ baseRefOid: parent });
    const child = w.head();
    git(w.repo, 'switch', '-q', 'parent');
    const tip = commit(w.repo, { 'parent.js': 'later\n' }, 'Parent advances');
    git(w.repo, 'switch', '-q', 'work');
    writeFileSync(join(w.sh, 'parent.json'), JSON.stringify([{ headRefOid: tip }]));
    const early = w.ship();
    assert.equal(early.code, 0, early.out);
    assert.match(early.out, /waits for its parent parent in origin\/main/);
    assert.ok(!w.calls().some((c) => c.startsWith('pr edit')));
    git(w.repo, 'switch', '-q', 'main');
    git(w.repo, 'merge', '--no-ff', '--no-edit', 'parent');
    git(w.repo, 'push', '-q', 'origin', 'main');
    git(w.repo, 'switch', '-q', 'work');
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.ok(w.calls().includes('pr edit 7 --base main'));
    assert.equal(w.head(), child);
    assert.ok(!w.calls().some((c) => c.includes('--auto')));
  });

  test('off on origin/main refuses opening a child even when HEAD enables stacks', () => {
    const w = world({ stacks: 'off' });
    commit(w.repo, { '.gate/driver.json': JSON.stringify({ stacks: 'pstack' }) }, 'Candidate policy');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.passed();
    const out = w.ship(['--base', 'parent', '--body-file', join(w.dir, 'body.md')]);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /base is parent, not main/);
    assert.ok(!w.calls().some((c) => c.startsWith('pr create')));
  });
});

for (const merge of [undefined, 'squash', 'merge']) {
  test(`arms with ${merge ?? 'default squash'} from origin/main, ignoring the candidate's method`, () => {
    const w = world({ merge });
    commit(w.repo, { '.gate/driver.json': JSON.stringify({ merge: merge === 'merge' ? 'squash' : 'merge' }) }, 'chore(gate): change candidate method');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.passed();
    assert.equal(w.ship().code, 0);
    w.pr({ statusCheckRollup: [{ name: 'tier', conclusion: 'SUCCESS' }] });
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.ok(w.calls().includes(`pr merge 7 --auto --${merge ?? 'squash'} --match-head-commit ${w.head()}`));
  });
}

test('after a squashed parent lands, ship only moves the child to main: no rebase, no push, the queue merges main into it', () => {
  const w = world();
  const parent = w.head();
  git(w.repo, 'branch', 'parent');
  commit(w.repo, { 'child.js': 'child\n' }, 'feat(cli): add child');
  git(w.repo, 'push', '-q', 'origin', 'work');
  const child = w.head();
  w.passed();
  assert.equal(w.ship(['--base', 'parent', '--body-file', join(w.dir, 'body.md')]).code, 0);
  w.pr({ baseRefOid: parent });
  const other = join(w.dir, 'other');
  git(w.dir, 'clone', '-q', join(w.dir, 'origin.git'), other);
  git(other, 'switch', '-q', '-c', 'parent', parent);
  const tip = commit(other, { 'parent.js': 'later\n' }, 'Parent advances');
  git(other, 'push', '-q', 'origin', 'HEAD:refs/pull/6/head');
  git(other, 'switch', '-q', 'main');
  git(other, 'merge', '--squash', 'parent');
  commit(other, {}, 'Land parent (#6)');
  git(other, 'push', '-q', 'origin', 'main');
  writeFileSync(join(w.sh, 'parent.json'), JSON.stringify([{ headRefOid: tip }]));
  const out = w.ship();
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /the queue merges main into it/);
  assert.ok(w.calls().includes('pr edit 7 --base main'));
  assert.equal(w.head(), child);
  assert.equal(git(w.repo, 'ls-remote', 'origin', 'refs/heads/work').split(/\s/)[0], child);
  assert.ok(!w.calls().some((c) => c.includes('--auto')));
});

for (const merge of ['squash', 'merge']) {
  test(`${merge}: title validation includes the squash PR suffix`, () => {
    const w = world({ merge });
    w.passed();
    assert.equal(w.ship(['--title', 'fix(cli): ' + 'x'.repeat(58), '--body-file', join(w.dir, 'body.md')]).code, 0);
    const out = w.ship();
    assert.equal(out.code, merge === 'squash' ? 1 : 0, out.out);
    if (merge === 'squash') {
      assert.match(out.out, /at most 72/);
      assert.ok(!w.calls().some((c) => c.includes('--auto')));
      w.pr({ title: 'fix(cli): ' + 'x'.repeat(57) });
      assert.equal(w.ship().code, 0);
    }
  });
}

test('squash refuses malformed titles before opening or arming a pull request', () => {
  const w = world({ merge: 'squash' });
  w.passed();
  for (const title of ['Update the queue', 'unknown(queue): update it', 'fix(queue): update it.', 'fix(queue): ' + 'x'.repeat(62)]) {
    const out = w.ship(['--title', title, '--body-file', join(w.dir, 'body.md')]);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /refused title/);
  }
  assert.ok(!w.calls().some((c) => c.startsWith('pr create')));
  assert.equal(w.ship().code, 0);
  w.pr({ title: 'Update the queue' });
  assert.match(w.ship().out, /refused title/);
  assert.ok(!w.calls().some((c) => c.includes('--auto')));
});
