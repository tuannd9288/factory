// scripts/live-verify: the live verifier on Codex, against a fake gh and a fake codex on PATH, in a copy of the kit.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, quiet, run } from './helpers.mjs';

// gh: the pull request and its issue from $LV, every comment posted appended to $LV/comments.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const lv = process.env.LV;
const a = process.argv.slice(2);
fs.appendFileSync(lv + '/gh-calls', a.join(' ') + '\n');
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (a[0] === 'api' && a[1] === 'user') out(process.env.GH_LOGIN + '\n');
if (a[0] === 'pr' && a[1] === 'view') out(fs.readFileSync(lv + '/pr.json', 'utf8'));
if (a[0] === 'issue' && a[1] === 'view') out(fs.readFileSync(lv + '/issue.json', 'utf8'));
if (a[0] === 'pr' && a[1] === 'comment') {
  fs.appendFileSync(lv + '/comments', fs.readFileSync(a[a.indexOf('--body-file') + 1], 'utf8') + '\n====\n');
  out('https://github.com/o/app/pull/7#issuecomment-1\n');
}
process.stderr.write('fake gh: ' + a.join(' ') + '\n');
process.exit(1);
`;

// codex: logged in and answering as $LV/codex.json says, with the SHAs its prompt names. It reads no setting from
// its environment, which live-verify strips; LV is written into it.
const FAKE_CODEX = (lv) => String.raw`#!/usr/bin/env node
const fs = require('fs');
const lv = ${JSON.stringify(lv)};
const conf = JSON.parse(fs.readFileSync(lv + '/codex.json', 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(lv + '/codex-calls', JSON.stringify({ args: a, home: process.env.CODEX_HOME, env: Object.keys(process.env) }) + '\n');
if (a[0] === '--version') { console.log('codex-cli 0.159.2'); process.exit(0); }
if (a[0] === 'login' && a[1] === 'status') {
  if (conf.loggedIn === '1') { console.log('Logged in using ChatGPT'); process.exit(0); }
  console.log('Not logged in'); process.exit(1);
}
if (a[0] !== 'exec') process.exit(1);
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(lv + '/prompt', prompt);
const sha = (k) => new RegExp('^' + k + ': ([0-9a-f]{40})$', 'm').exec(prompt)?.[1];
const mode = conf.mode;
if (mode === 'exit1') { process.stderr.write('stream error\n'); process.exit(1); }
const live = [{ at: 'parent', command: 'node cli.js add 2 3', observed: '5' }, { at: 'head', command: 'node cli.js add 2 3', observed: '5' }];
const result = {
  verdict: mode === 'issues' ? 'ISSUES' : 'PASS',
  parent: sha('parent'),
  head: mode === 'wrong-sha' ? '0'.repeat(40) : sha('head'),
  driver: 'cli',
  ran: mode === 'no-live' ? [] : live,
  gates: [{ command: 'scripts/verify', result: 'verify: 1 passed' }],
  audit: 'Thay đổi nhỏ, đúng mô tả.',
  issues: mode === 'issues' ? ['add(2, -3) trả về 5'] : [],
  notes: mode === 'notes' ? ['Chưa có thông báo lỗi khi thiếu đối số'] : [],
  reason: '',
};
fs.writeFileSync(a[a.indexOf('-o') + 1], JSON.stringify(result));
process.exit(0);
`;

const DRIVER = { name: 'cli', start: '', drive: 'node cli.js add <a> <b>, as a user types it', network: false };

/** A repository holding the kit, a pull request #7 from branch work, and a fake gh and codex that answer for it. */
function world({ driver = DRIVER } = {}) {
  // The real path: git names the repository by it, and the worktrees' paths in Codex's arguments with it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'live-verify-')));
  const repo = join(dir, 'app');
  cpSync(join(factory, 'kit'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.github/CODEOWNERS'), '* @tuannd9288\n');
  if (driver) writeFileSync(join(repo, '.gate/driver.json'), JSON.stringify(driver));
  const base = commit(repo, { 'cli.js': 'console.log(Number(process.argv[3]) + Number(process.argv[4]));\n' }, 'start');
  git(repo, 'switch', '-q', '-c', 'work');
  const head = commit(repo, { 'cli.js': 'const [, , op, a, b] = process.argv;\nconsole.log(op === "add" ? Number(a) + Number(b) : NaN);\n' }, 'Name the operation');
  git(repo, 'switch', '-q', 'main');
  const lv = join(dir, 'lv');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(lv);
  writeFileSync(join(dir, 'bin/gh'), FAKE_GH);
  writeFileSync(join(dir, 'bin/codex'), FAKE_CODEX(lv));
  chmodSync(join(dir, 'bin/gh'), 0o755);
  chmodSync(join(dir, 'bin/codex'), 0o755);
  const pr = (over = {}) =>
    writeFileSync(
      join(lv, 'pr.json'),
      JSON.stringify({
        number: 7,
        url: 'https://github.com/o/app/pull/7',
        title: 'Đặt tên phép tính',
        body: 'Closes #3\n\nCLI nhận tên phép tính trước hai số.',
        author: { login: 'tuan9288-agent' },
        baseRefName: 'main',
        baseRefOid: base,
        headRefName: 'work',
        headRefOid: head,
        state: 'OPEN',
        closingIssuesReferences: [{ number: 3 }],
        comments: [],
        ...over,
      }),
    );
  pr();
  writeFileSync(join(lv, 'issue.json'), JSON.stringify({ number: 3, title: 'CLI đặt tên phép tính', body: '`node cli.js add 2 3` in ra 5.' }));
  const verify = (args = ['7'], env = {}) => {
    writeFileSync(join(lv, 'codex.json'), JSON.stringify({ loggedIn: env.CODEX_LOGGED_IN ?? '1', mode: env.CODEX_MODE ?? 'pass' }));
    return run(repo, join(repo, 'scripts/live-verify'), args, {
      ...quiet,
      GH_TOKEN: 'not-a-token',
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      LV: lv,
      GH_LOGIN: 'tuan9288-agent',
      GATE_VERIFIER_HOME: join(dir, 'verifier/codex'),
      ...env,
    });
  };
  const read = (name) => (existsSync(join(lv, name)) ? readFileSync(join(lv, name), 'utf8') : '');
  const execs = () => read('codex-calls').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args[0] === 'exec');
  const patchOf = (b, h) => {
    const fork = git(repo, 'merge-base', b, h);
    const diff = execFileSync('git', ['-C', repo, 'diff', '--binary', '--no-renames', fork, h], { encoding: 'utf8' });
    return execFileSync('git', ['-C', repo, 'patch-id', '--verbatim'], { input: diff, encoding: 'utf8' }).split(' ')[0];
  };
  return { dir, repo, base, head, lv, pr, verify, read, execs, patchOf, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('live-verify', () => {
  test('posts the verdict with the head, the parent and the patch it covers, and cleans its worktrees up', () => {
    const w = world();
    try {
      const out = w.verify(['7'], { CODEX_MODE: 'notes' });
      assert.equal(out.code, 0, out.out);
      const posted = w.read('comments');
      assert.match(posted, /^live-verify: PASS\+NOTES$/m);
      assert.match(posted, new RegExp(`^head: ${w.head}$`, 'm'));
      assert.match(posted, new RegExp(`^parent: ${w.base}$`, 'm'));
      assert.match(posted, new RegExp(`^patch: ${w.patchOf(w.base, w.head)}$`, 'm'));
      assert.match(posted, /^codex: codex-cli 0\.159\.2, 1 run$/m);
      assert.match(posted, /Chưa có thông báo lỗi khi thiếu đối số/);
      // The brief stands alone: the goal from the pull request and its issue, the exact commits, the driver.
      const prompt = w.read('prompt');
      assert.match(prompt, /CLI nhận tên phép tính/);
      assert.match(prompt, /`node cli\.js add 2 3` in ra 5/);
      assert.match(prompt, /node cli\.js add <a> <b>, as a user types it/);
      // The log of Codex's runs stays, for the BLOCKED comment that points at it; the worktrees go.
      assert.deepEqual(readdirSync(join(w.repo, '.claude/worktrees')), ['live-verify-7.log']);
      assert.match(git(w.repo, 'worktree', 'list'), /^\S+\s+[0-9a-f]+ \[main\]$/);
    } finally {
      w.cleanup();
    }
  });

  test('runs Codex in a workspace-write sandbox on the head, the parent beside it, with no approval and no bypass', () => {
    const w = world();
    try {
      assert.equal(w.verify().code, 0);
      const [call] = w.execs();
      const args = call.args.join(' ');
      assert.equal(call.home, join(w.dir, 'verifier/codex'));
      // What the verifier runs sees no credential and no profile of the agent that called it.
      assert.deepEqual(call.env.filter((k) => /TOKEN|SECRET|^GH_|^GITHUB_|^CLAUDE|^ANTHROPIC/.test(k)), []);
      assert.match(args, new RegExp(`-C ${w.repo}/\\.claude/worktrees/live-verify-7/head `));
      assert.match(args, new RegExp(`--add-dir ${w.repo}/\\.claude/worktrees/live-verify-7/parent `));
      assert.match(args, /-s workspace-write /);
      assert.match(args, /-c approval_policy="never" /);
      // The candidate's AGENTS.md is the change under test, not the verifier's instructions.
      assert.match(args, /-c project_doc_max_bytes=0 /);
      assert.match(args, /--ignore-rules /);
      assert.doesNotMatch(args, /network_access/);
      assert.doesNotMatch(args, /dangerously|--approve-for-me| -m /);
      const text = readFileSync(join(factory, 'kit/scripts/live-verify'), 'utf8') + readFileSync(join(factory, 'kit/scripts/lib/live-verify.mjs'), 'utf8');
      assert.doesNotMatch(text, /--dangerously|pr review|--approve\b|codex login(?! status)|'login',(?! *'status')/);
    } finally {
      w.cleanup();
    }
  });

  test('opens the network only when the driver says it needs it', () => {
    const w = world({ driver: { ...DRIVER, network: true } });
    try {
      assert.equal(w.verify().code, 0);
      assert.match(w.execs()[0].args.join(' '), /-c sandbox_workspace_write\.network_access=true /);
    } finally {
      w.cleanup();
    }
  });

  test('no driver on the base is BLOCKED, never PASS, and runs no Codex', () => {
    for (const driver of [null, { name: '', start: '', drive: '', network: false }]) {
      const w = world({ driver });
      try {
        const out = w.verify();
        assert.equal(out.code, 2, out.out);
        assert.match(w.read('comments'), /^live-verify: BLOCKED$/m);
        assert.match(w.read('comments'), /\.gate\/driver\.json/);
        assert.match(w.read('comments'), /^codex: not run$/m);
        assert.deepEqual(w.execs(), []);
      } finally {
        w.cleanup();
      }
    }
  });

  test('a driver the pull request itself adds does not count: the base\'s is read', () => {
    const w = world({ driver: null });
    try {
      git(w.repo, 'switch', '-q', 'work');
      writeFileSync(join(w.repo, '.gate/driver.json'), JSON.stringify(DRIVER));
      const head = commit(w.repo, {}, 'Add a driver');
      git(w.repo, 'switch', '-q', 'main');
      w.pr({ headRefOid: head });
      assert.equal(w.verify().code, 2);
      assert.deepEqual(w.execs(), []);
    } finally {
      w.cleanup();
    }
  });

  test('a verifier profile not logged in is BLOCKED; the script never logs in', () => {
    const w = world();
    try {
      const out = w.verify(['7'], { CODEX_LOGGED_IN: '0' });
      assert.equal(out.code, 2, out.out);
      assert.match(w.read('comments'), /^live-verify: BLOCKED$/m);
      assert.match(w.read('comments'), /not logged in/);
      const calls = w.read('codex-calls').split('\n').filter(Boolean).map((l) => JSON.parse(l).args.join(' '));
      assert.ok(calls.every((c) => c === '--version' || c === 'login status'), calls.join('\n'));
    } finally {
      w.cleanup();
    }
  });

  test('a Codex failure is BLOCKED, with no second attempt on another model', () => {
    const w = world();
    try {
      const out = w.verify(['7'], { CODEX_MODE: 'exit1' });
      assert.equal(out.code, 2, out.out);
      assert.match(w.read('comments'), /^live-verify: BLOCKED$/m);
      assert.match(w.read('comments'), /codex exec exited 1/);
      assert.equal(w.execs().length, 1);
    } finally {
      w.cleanup();
    }
  });

  test('a result that does not record the commits it was given, or a PASS with no live run, is retried once, then BLOCKED', () => {
    for (const mode of ['wrong-sha', 'no-live']) {
      const w = world();
      try {
        const out = w.verify(['7'], { CODEX_MODE: mode });
        assert.equal(out.code, 2, out.out);
        assert.match(w.read('comments'), /^live-verify: BLOCKED$/m);
        assert.match(w.read('comments'), /^codex: codex-cli 0\.159\.2, 2 runs$/m);
        assert.equal(w.execs().length, 2);
      } finally {
        w.cleanup();
      }
    }
  });

  test('ISSUES is posted as FAIL with every issue, and exits 1', () => {
    const w = world();
    try {
      const out = w.verify(['7'], { CODEX_MODE: 'issues' });
      assert.equal(out.code, 1, out.out);
      assert.match(w.read('comments'), /^live-verify: FAIL$/m);
      assert.match(w.read('comments'), /add\(2, -3\) trả về 5/);
    } finally {
      w.cleanup();
    }
  });

  test('posts only as the pull request\'s author, the agents\' account, never as a code owner', () => {
    const w = world();
    try {
      const out = w.verify(['7'], { GH_LOGIN: 'tuannd9288' });
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /posts as the pull request's author \(tuan9288-agent\), not as tuannd9288/);
      assert.equal(w.read('comments'), '');
      assert.deepEqual(w.execs(), []);
    } finally {
      w.cleanup();
    }
  });
});

describe('live-verify --covered', () => {
  const verdict = (v, head, patch, extra = '') => `live-verify: ${v}\nhead: ${head}\nparent: ${'p'.repeat(40)}\npatch: ${patch}\ndriver: cli\ncodex: codex-cli 0.159.2, 1 run\n${extra}`;

  test('a PASS covers the head it names, or a later head carrying its patch unchanged; an older head with another patch does not count', () => {
    const w = world();
    try {
      const agent = { login: 'tuan9288-agent' };
      const own = w.patchOf(w.base, w.head);
      // main moves on, and the queue merges it into the branch: a new head, the same patch.
      const base2 = commit(w.repo, { 'README.md': '# app\n' }, 'Readme');
      git(w.repo, 'switch', '-q', 'work');
      git(w.repo, 'merge', '-q', '--no-edit', 'main');
      const head2 = git(w.repo, 'rev-parse', 'HEAD');
      git(w.repo, 'switch', '-q', 'main');
      const covered = (comments, over = {}) => {
        w.pr({ baseRefOid: base2, headRefOid: head2, comments, ...over });
        return w.verify(['--covered', '7']);
      };
      assert.equal(covered([]).code, 1);
      // An older head whose patch differs: the verdict saw other code.
      let out = covered([{ author: agent, body: verdict('PASS', w.base, 'f'.repeat(40)) }]);
      assert.equal(out.code, 1, out.out);
      out = covered([{ author: agent, body: verdict('PASS+NOTES', w.head, own) }]);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, new RegExp(`covered by PASS\\+NOTES on ${w.head.slice(0, 7)}, whose patch the head carries unchanged`));
      assert.equal(covered([{ author: agent, body: verdict('PASS', head2, 'e'.repeat(40)) }]).code, 0);
      // The latest verdict on the patch decides: a FAIL after the PASS uncovers it.
      assert.equal(covered([{ author: agent, body: verdict('PASS', w.head, own) }, { author: agent, body: verdict('FAIL', head2, own) }]).code, 1);
      // Only the pull request's author posts verdicts: anyone else's text is not one.
      assert.equal(covered([{ author: { login: 'someone' }, body: verdict('PASS', head2, own) }]).code, 1);
      // The header is the comment's first lines; a line quoted further down is not a verdict.
      assert.equal(covered([{ author: agent, body: `Xem lại:\n${verdict('PASS', head2, own)}` }]).code, 1);
    } finally {
      w.cleanup();
    }
  });
});
