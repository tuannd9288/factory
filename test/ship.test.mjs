// scripts/ship (#85): one command that opens the pull request only after a local pass and then takes step 4's next step,
// against a fake gh and a fake scripts/live-verify, in a copy of the kit with a real bare origin.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, run, quiet } from './helpers.mjs';

// gh: the one pull request is $SH/pr.json (absent: none); every call is appended to $SH/gh-calls.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const sh = process.env.SH;
const a = process.argv.slice(2);
fs.appendFileSync(sh + '/gh-calls', a.join(' ') + '\n');
const read = () => (fs.existsSync(sh + '/pr.json') ? JSON.parse(fs.readFileSync(sh + '/pr.json', 'utf8')) : null);
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (a[0] === 'pr' && a[1] === 'list') { const pr = read(); out(JSON.stringify(pr ? [pr] : [])); }
if (a[0] === 'pr' && a[1] === 'create') {
  fs.copyFileSync(a[a.indexOf('--body-file') + 1], sh + '/created-body');
  const head = fs.readFileSync(sh + '/head', 'utf8').trim();
  fs.writeFileSync(sh + '/pr.json', JSON.stringify({ number: 7, url: 'https://github.com/o/app/pull/7', baseRefName: 'main', headRefOid: head, labels: [], autoMergeRequest: null, statusCheckRollup: [] }));
  out('https://github.com/o/app/pull/7\n');
}
if (a[0] === 'pr' && a[1] === 'merge') {
  const pr = read();
  pr.autoMergeRequest = a.includes('--auto') ? { mergeMethod: 'MERGE' } : null;
  fs.writeFileSync(sh + '/pr.json', JSON.stringify(pr));
  out('ok\n');
}
process.stderr.write('fake gh: ' + a.join(' ') + '\n');
process.exit(1);
`;

// scripts/live-verify: $SH/verdict names what a run answers; a PASS or PASS+NOTES makes --covered pass.
const FAKE_LIVE_VERIFY = String.raw`#!/usr/bin/env node
const fs = require('fs');
const sh = process.env.SH;
const a = process.argv.slice(2);
fs.appendFileSync(sh + '/lv-calls', a.join(' ') + '\n');
if (a[0] === '--covered') process.exit(fs.existsSync(sh + '/covered') ? 0 : 1);
const verdict = fs.readFileSync(sh + '/verdict', 'utf8').trim();
console.log('live-verify: ' + verdict + ' on #' + a[0]);
if (verdict === 'PASS' || verdict === 'PASS+NOTES') { fs.writeFileSync(sh + '/covered', ''); process.exit(0); }
process.exit(verdict === 'FAIL' ? 1 : 2);
`;

const BODY = 'Closes #3\n\n## Summary for the Human\n- Purpose: names the operation\n';

/** A copy of the kit on branch `work` (one commit past `main`, which origin holds), with stamps and fakes on request. */
function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ship-')));
  const repo = join(dir, 'app');
  const sh = join(dir, 'sh');
  cpSync(join(factory, 'kit'), repo, { recursive: true });
  mkdirSync(sh);
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, { 'cli.js': 'console.log(1);\n' }, 'start');
  git(dir, 'init', '-q', '--bare', 'origin.git');
  git(repo, 'remote', 'add', 'origin', join(dir, 'origin.git'));
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'switch', '-q', '-c', 'work');
  commit(repo, { 'cli.js': 'console.log(2);\n' }, 'Print two');
  git(repo, 'push', '-q', 'origin', 'work');
  writeFileSync(join(repo, 'scripts/live-verify'), FAKE_LIVE_VERIFY);
  git(repo, 'update-index', '--assume-unchanged', 'scripts/live-verify');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/gh'), FAKE_GH);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  chmodSync(join(repo, 'scripts/live-verify'), 0o755);
  writeFileSync(join(sh, 'verdict'), 'PASS\n');
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
      w.stamp(`verify-${w.head()}`);
      w.stamp(`red-check-${w.head()}-${base}`);
    },
    ship: (args = ['--body-file', join(dir, 'body.md')]) => {
      writeFileSync(join(sh, 'head'), w.head());
      return run(repo, join(repo, 'scripts/ship'), args, { ...quiet, SH: sh, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GH_TOKEN: 'not-a-token' });
    },
    pr: (over) => writeFileSync(join(sh, 'pr.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(sh, 'pr.json'), 'utf8')), ...over })),
    read: (name) => (existsSync(join(sh, name)) ? readFileSync(join(sh, name), 'utf8') : ''),
    calls: () => w.read('gh-calls').split('\n').filter(Boolean),
  };
  return w;
}

describe('opening the pull request', () => {
  test('is refused without a verify stamp for the head, and says so', () => {
    const w = world();
    w.stamp(`red-check-${w.head()}-${git(w.repo, 'rev-parse', 'origin/main')}`);
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused: HEAD [0-9a-f]{7} has no verify stamp; run \.gate\/bin\/verify on it$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr create')), w.calls().join('\n'));
  });

  test('is refused without a red-check stamp, and for one against another base', () => {
    const w = world();
    w.stamp(`verify-${w.head()}`);
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused: HEAD [0-9a-f]{7} has no red-check stamp against origin\/main [0-9a-f]{7}; run \.gate\/bin\/red-check --base origin\/main$/m);
    w.stamp(`red-check-${w.head()}-${'0'.repeat(40)}`);
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /no red-check stamp against origin\/main/);
    assert.ok(!w.calls().some((c) => c.startsWith('pr create')));
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

  test('opens it through gh pr create --body-file once both stamps name the head', () => {
    const w = world();
    w.passed();
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: opened #7 https:\/\/github\.com\/o\/app\/pull\/7$/m);
    const create = w.calls().find((c) => c.startsWith('pr create'));
    assert.match(create, /--base main/);
    assert.match(create, /--head work/);
    assert.match(create, /--title Print two/);
    assert.match(create, /--body-file /);
    assert.equal(w.read('created-body'), BODY);
    assert.equal(w.read('lv-calls'), '', 'it opens, and goes no further in the same run');
  });

  test('refuses a body that still holds the template\'s placeholder', () => {
    const w = world();
    w.passed();
    const out = w.ship(['--body-file', join(w.repo, '.github/pull_request_template.md')]);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused: the body still holds the template's "Closes #<issue labelled task>"; pass --body-file with the issue number filled in$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr create')));
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

  test('a second run live-verifies and arms on PASS; a third finds nothing to do', () => {
    const w = opened();
    let out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^live-verify: PASS on #7$/m);
    assert.match(out.out, /^ship: armed #7: a live PASS covers HEAD [0-9a-f]{7}$/m);
    assert.equal(w.read('lv-calls'), '--covered 7\n7\n');
    assert.ok(w.calls().includes('pr merge 7 --auto --merge'), w.calls().join('\n'));
    out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: #7 is armed and a live verdict covers it; nothing to do$/m);
    assert.equal(w.calls().filter((c) => c.startsWith('pr merge')).length, 1);
  });

  test('arms on PASS+NOTES too', () => {
    const w = opened();
    writeFileSync(join(w.sh, 'verdict'), 'PASS+NOTES\n');
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.ok(w.calls().includes('pr merge 7 --auto --merge'));
  });

  test('refuses to arm on FAIL, and on BLOCKED, and says what to do', () => {
    const w = opened();
    writeFileSync(join(w.sh, 'verdict'), 'FAIL\n');
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused to arm #7: live-verify answered FAIL; fix forward with a red test, then run ship again$/m);
    writeFileSync(join(w.sh, 'verdict'), 'BLOCKED\n');
    out = w.ship();
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /^ship: stopped on #7: live-verify is BLOCKED; put the reason and your recommended answer in the pull request$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')));
  });

  test('refuses to arm when the base is not main, and says which', () => {
    const w = opened();
    w.pr({ baseRefName: 'develop' });
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: refused to arm #7: its base is develop, not main$/m);
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')));
  });

  test('arms again without a new run when a verdict already covers the head', () => {
    const w = opened();
    writeFileSync(join(w.sh, 'covered'), '');
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.equal(w.read('lv-calls'), '--covered 7\n');
    assert.ok(w.calls().includes('pr merge 7 --auto --merge'));
  });

  test('disarms an armed pull request first when HEAD has a commit the pull request lacks', () => {
    const w = opened();
    assert.equal(w.ship().code, 0);
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'A new patch');
    const before = w.read('lv-calls');
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: disarmed #7: HEAD [0-9a-f]{7} is past what was verified; push it, then run ship again$/m);
    assert.equal(w.calls().at(-1), 'pr merge 7 --disable-auto');
    assert.equal(w.read('lv-calls'), before, 'nothing else ran in that run');
  });

  test('disarms when the pushed head is no longer covered, then covers it and arms again on the next runs', () => {
    const w = opened();
    assert.equal(w.ship().code, 0);
    const old = w.head();
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'A new patch');
    git(w.repo, 'push', '-q', 'origin', 'work');
    w.pr({ headRefOid: w.head() });
    rmSync(join(w.sh, 'covered'));
    let out = w.ship();
    assert.match(out.out, /^ship: disarmed #7: no live verdict covers HEAD [0-9a-f]{7}/m);
    assert.equal(w.calls().at(-1), 'pr merge 7 --disable-auto');
    assert.notEqual(old, w.head());
    out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: armed #7/m);
    assert.equal(w.calls().at(-1), 'pr merge 7 --auto --merge');
  });

  test('stops while the pull request carries needs-human', () => {
    const w = opened();
    w.pr({ labels: [{ name: 'needs-human' }] });
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: stopped on #7: it carries needs-human; the Human decides$/m);
    assert.equal(w.read('lv-calls'), '');
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')));
  });

  test('arms a tier-3 pull request by the PASS rule, then stops while its tier check waits, and is done once it is green', () => {
    const w = opened();
    w.pr({ labels: [{ name: 'tier-3' }], statusCheckRollup: [{ name: 'tier', status: 'IN_PROGRESS', conclusion: '' }] });
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: armed #7/m);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval$/m);
    assert.ok(w.calls().includes('pr merge 7 --auto --merge'));
    w.pr({ statusCheckRollup: [{ name: 'tier', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^ship: #7 is armed and a live verdict covers it; nothing to do$/m);
  });

  test('does not arm a tier-3 pull request on FAIL, and says FAIL, not the wait', () => {
    const w = opened();
    w.pr({ labels: [{ name: 'tier-3' }], statusCheckRollup: [{ name: 'tier', status: 'IN_PROGRESS', conclusion: '' }] });
    writeFileSync(join(w.sh, 'verdict'), 'FAIL\n');
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /live-verify answered FAIL/);
    assert.doesNotMatch(out.out, /waits for the Human/);
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')));
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

  test('arms by the same PASS rule, then stops with the line, and a later run stops again', () => {
    const w = opened(3);
    w.pr({ statusCheckRollup: waiting });
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: armed #7/m);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval$/m);
    assert.ok(w.calls().includes('pr merge 7 --auto --merge'));
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval$/m);
    assert.equal(w.calls().filter((c) => c.startsWith('pr merge')).length, 1);
  });

  test('does not arm it on FAIL, and says FAIL, not the wait', () => {
    const w = opened(3);
    w.pr({ statusCheckRollup: waiting });
    writeFileSync(join(w.sh, 'verdict'), 'FAIL\n');
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /live-verify answered FAIL/);
    assert.doesNotMatch(out.out, /waits for the Human/);
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')));
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
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'More');
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
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval$/m);
    out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval$/m);
    assert.doesNotMatch(out.out, /nothing to do/);
  });

  test('by .gate/bin/tier on the paths: the same', () => {
    const w = opened(3);
    const out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ship: stopped on #7: tier 3 waits for the Human's approval$/m);
  });

  test('below tier 3 a red tier check is no wait of the Human\'s', () => {
    const w = opened(2);
    const out = w.ship();
    assert.equal(out.code, 0, out.out);
    assert.doesNotMatch(out.out, /waits for the Human/);
  });

  test('when .gate/bin/tier cannot judge, ship fails closed: no live-verify, no arming', () => {
    const w = opened(3);
    writeFileSync(join(w.repo, '.gate/bin/tier'), '#!/bin/sh\necho "tier: could not read the policy"\nexit 2\n');
    const out = w.ship();
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /^ship: could not judge the tier \(\.gate\/bin\/tier exited 2\)$/m);
    assert.equal(w.read('lv-calls'), '');
    assert.equal(w.calls().filter((c) => c.startsWith('pr merge')).length, 0);
  });
});

describe('a red-check that passed by the body\'s No-red line', () => {
  const LINE = 'No-red: a rename with no behaviour to show first';
  const passedByLine = () => {
    const w = world();
    w.stamp(`verify-${w.head()}`);
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

describe('a live-verify that exits 2 without a BLOCKED verdict', () => {
  test('is said to have not run, with none of the BLOCKED advice', () => {
    const w = world();
    w.passed();
    assert.equal(w.ship().code, 0);
    writeFileSync(join(w.sh, 'verdict'), 'CRASH\n');
    const out = w.ship();
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /^ship: live-verify could not run on #7 \(exit 2\); nothing was armed$/m);
    assert.doesNotMatch(out.out, /BLOCKED|recommended answer/);
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')));
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

  test('adds, to the refusal for a verify stamp and for a red-check stamp, what to do when the tree is not clean', () => {
    const w = world();
    let out = w.ship();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /has no verify stamp/);
    assert.match(out.out, HINT);
    w.stamp(`verify-${w.head()}`);
    out = w.ship();
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
    commit(w.repo, { 'cli.js': 'console.log(3);\n' }, 'Pushed');
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
    assert.equal(w.read('lv-calls'), '');
    assert.ok(!w.calls().some((c) => c.startsWith('pr merge')));
  });
});
