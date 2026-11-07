// #349: `factory lead <repo> --here` (a Lead on the MacBook with no GitHub login of the Human's) and `factory gh <args>` (gh on the
// factory host by ssh), against a fake ssh that runs the remote command through a shell, and a fake claude, gh, git and zsh on PATH.
// Nothing live runs, and every name below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tokenStoreDeny } from '../bin/lib/seat.mjs';
import { freeWord, teamsOf } from '../bin/lib/team-names.mjs';
import { HOST_ENV, factory } from './helpers.mjs';

// Each fake writes what it got to $FAKE: its arguments one per NUL (<name>.args), and gh its stdin and exits with gh.exit.
const SCRIPTS = {
  ssh: `#!/bin/sh
echo "ssh $*" >> "$FAKE/calls.log"
for last; do :; done
if [ -f "$FAKE/ssh-down" ]; then echo 'ssh: Could not resolve hostname' >&2; exit 255; fi
exec sh -c "$last"
`,
  zsh: `#!/bin/sh
[ "$1" = -lc ] || exit 64
exec sh -c "$2"
`,
  git: `#!/bin/sh
[ "$1 $2" = "config --global" ] || exit 64
f="$FAKE/git-$3"
if [ -f "$f" ]; then cat "$f"; else exit 1; fi
`,
  gh: `#!/bin/sh
pwd > "$FAKE/gh.cwd"
[ -f "$FAKE/gh.leave" ] && : > left-behind
: > "$FAKE/gh.args"
for a; do printf '%s\\0' "$a" >> "$FAKE/gh.args"; done
cat > "$FAKE/gh.stdin"
exit "$(cat "$FAKE/gh.exit" 2>/dev/null || echo 0)"
`,
  claude: `#!/bin/sh
pwd > "$FAKE/claude.cwd"
: > "$FAKE/claude.args"
for a; do printf '%s\\0' "$a" >> "$FAKE/claude.args"; done
exit "$(cat "$FAKE/claude.exit" 2>/dev/null || echo 0)"
`,
};

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-here-'));
  const fake = join(dir, 'fake');
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const state = join(dir, 'state');
  for (const d of [fake, bin, home, state]) mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(SCRIPTS)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const env = { FAKE: fake, HOME: home, PATH: `${bin}:${process.env.PATH}`, FACTORY_STATE: state, FACTORY_RUNS: join(home, 'factory-runs'), AGENT_PROFILES: join(dir, 'profiles'), FACTORY_ROOT: join(home, 'WORKSPACES'), FACTORY_HOST_USER: 'nobody-here' };
  mkdirSync(join(env.AGENT_PROFILES, 'tokens'), { recursive: true });
  writeFileSync(join(env.AGENT_PROFILES, 'tokens/fixture'), 'made-up-node-token');
  const w = (name, text) => writeFileSync(join(fake, name), text);
  const read = (name) => (existsSync(join(fake, name)) ? readFileSync(join(fake, name), 'utf8') : '');
  const nuls = (name) => read(name).split('\0').slice(0, -1);
  const fac = (args, input, cwd = factory) => {
    const selected = args.indexOf('--team');
    if (args[0] === 'lead' && args.includes('--here') && (selected !== -1 || !existsSync(join(state, 'accounts')))) {
      const team = selected === -1 ? freeWord('alpha', []) : args[selected + 1];
      writeFileSync(join(state, 'accounts'), `factory/alpha-${team}=fixture\n`);
    }
    const { NODE_TEST_CONTEXT, ...outer } = process.env;
    const r = spawnSync(process.execPath, ['--', join(factory, 'bin/lib/factory.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...outer, ...env }, input });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return {
    dir, fake, home, state, w, read, nuls, fac, calls: () => read('calls.log'),
    // The host's user here, on the machine named `name`: by default this one, so here is the factory host.
    onHost: (name = HOST_ENV.FACTORY_HOST_NAME) => { Object.assign(env, HOST_ENV, { FACTORY_HOST_NAME: name }); },
    identity: (name = 'Agent Ann', email = 'agent.ann@example.invalid') => { w('git-user.name', `${name}\n`); w('git-user.email', `${email}\n`); },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const settingsOf = (args) => JSON.parse(args[args.indexOf('--settings') + 1]);

test('the shared fixture adds no account team before a Lead is launched', () => {
  const s = world();
  try {
    s.onHost();
    const runs = join(s.home, 'factory-runs');
    mkdirSync(join(runs, 'alpha-lead'), { recursive: true });
    assert.deepEqual(teamsOf('alpha', {
      home: s.home, state: s.state, runs, root: join(s.home, 'WORKSPACES'), processes: () => [],
    }), ['lead']);
  } finally { s.done(); }
});

test('lead --here starts claude here with the empty gh folder, the agents\' git identity, no credential helper and gh auth denied', () => {
  const s = world();
  try {
    s.identity('Agent Ánh', 'agent.anh@example.invalid');
    const r = s.fac(['lead', 'alpha', '--here']);
    assert.equal(r.code, 0, r.out);
    const args = s.nuls('claude.args');
    const { env, permissions } = settingsOf(args);
    const empty = join(s.state, 'lead-here/gh-empty');
    const push = 'url.file:///nonexistent/factory-lead-pushes-from-the-mac-mini/.pushInsteadOf';
    assert.deepEqual(env, {
      GH_CONFIG_DIR: empty, GH_TOKEN: '', GITHUB_TOKEN: '',
      GIT_AUTHOR_NAME: 'Agent Ánh', GIT_AUTHOR_EMAIL: 'agent.anh@example.invalid',
      GIT_COMMITTER_NAME: 'Agent Ánh', GIT_COMMITTER_EMAIL: 'agent.anh@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: "sh -c 'echo git over ssh is off for a MacBook Lead, pushes go from the Mac mini >&2; exit 1'",
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: push, GIT_CONFIG_VALUE_1: 'https://github.com/',
      GIT_CONFIG_KEY_2: push, GIT_CONFIG_VALUE_2: 'git@github.com:',
      GIT_CONFIG_KEY_3: push, GIT_CONFIG_VALUE_3: 'ssh://git@github.com/',
    });
    assert.deepEqual(permissions.deny, [...tokenStoreDeny, 'Read(~/.agent-profiles/**)', `Read(/${join(s.dir, 'profiles')}/**)`, 'Bash(env:*)', 'Bash(printenv:*)', 'Bash(gh auth:*)', 'Bash(security:*)', 'Bash(/usr/bin/security:*)', 'Bash(*FACTORY_HOST_USER*)']);
    assert.ok(args.includes('--name') && args[args.indexOf('--name') + 1] === `alpha-${freeWord('alpha', [])}`, args.join(' '));
    assert.equal(statSync(empty).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(empty), []);
    // The identity is read on the factory host, as the host's user, in its login shell.
    assert.match(s.calls(), /ssh .*factory@tuans-mac-mini zsh -lc '.*git config --global user\.name.*git config --global user\.email/);
  } finally {
    s.done();
  }
});

test('lead --here passes what follows -- to claude, and the team to --name', () => {
  const s = world();
  try {
    s.identity();
    const r = s.fac(['lead', 'alpha', '--team', 'beta', '--here', '--', '--resume', 'abc-123']);
    assert.equal(r.code, 0, r.out);
    const args = s.nuls('claude.args');
    assert.deepEqual(args.slice(-2), ['--resume', 'abc-123']);
    assert.equal(args[args.indexOf('--name') + 1], 'alpha-beta');
    s.w('claude.exit', '7');
    assert.equal(s.fac(['lead', 'alpha', '--here']).code, 7, 'claude\'s exit code is the command\'s');
  } finally {
    s.done();
  }
});

test('lead --here starts in auto mode, with the factory host in the classifier\'s environment beside its defaults (#366)', () => {
  const s = world();
  try {
    s.identity();
    assert.equal(s.fac(['lead', 'alpha', '--team', 'beta', '--here']).code, 0);
    const args = s.nuls('claude.args');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
    const { environment } = settingsOf(args).autoMode;
    assert.ok(environment.includes('$defaults'), 'a list without "$defaults" replaces the built-in entries');
    assert.ok(environment.some((e) => e !== '$defaults' && e.includes('factory@tuans-mac-mini')), environment.join('\n'));
    // A mode given after -- is the only one claude gets.
    assert.equal(s.fac(['lead', 'alpha', '--team', 'beta', '--here', '--', '--permission-mode', 'plan']).code, 0);
    assert.deepEqual(s.nuls('claude.args').filter((a) => a === '--permission-mode' || a === 'auto'), ['--permission-mode']);
  } finally {
    s.done();
  }
});

test('lead --here trusts the folder it starts in, by its real path, in the team\'s profile, and keeps the file\'s other keys (#366)', () => {
  const s = world();
  try {
    s.identity();
    const file = join(s.dir, 'profiles/leads/alpha-beta/claude/.claude.json');
    const folder = realpathSync(s.dir);
    mkdirSync(join(s.dir, 'profiles/leads/alpha-beta/claude'), { recursive: true });
    writeFileSync(file, JSON.stringify({ numStartups: 3, projects: { '/elsewhere': { hasTrustDialogAccepted: false }, [folder]: { allowedTools: ['Read'] } } }));
    chmodSync(file, 0o640);
    assert.equal(s.fac(['lead', 'alpha', '--team', 'beta', '--here'], undefined, s.dir).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      numStartups: 3, hasCompletedOnboarding: true,
      projects: { '/elsewhere': { hasTrustDialogAccepted: false }, [folder]: { allowedTools: ['Read'], hasTrustDialogAccepted: true } },
    });
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(join(s.dir, 'profiles/leads/alpha-beta/claude')), ['.claude.json'], 'no temporary file is left');
  } finally {
    s.done();
  }
});

test('a restored Lead session returns through the launcher with its settings and role (#366)', () => {
  const s = world();
  try {
    s.identity();
    const session = '11111111-2222-4333-8444-555555555555';
    assert.equal(s.fac(['lead', '--resume-session', session, '--check']).code, 1);
    assert.equal(s.calls(), '');
    assert.equal(s.fac(['lead', 'alpha', '--team', 'beta', '--here', '--', '--resume', session], undefined, s.dir).code, 0);
    const original = s.nuls('claude.args');
    const calls = s.calls();
    rmSync(join(s.fake, 'claude.args'));
    assert.equal(s.fac(['lead', '--resume-session', session, '--check']).code, 0);
    assert.equal(s.calls(), calls, 'checking never launches anything');
    assert.equal(s.read('claude.args'), '');
    const resumed = s.fac(['lead', '--resume-session', session]);
    assert.equal(resumed.code, 0, resumed.out);
    assert.deepEqual(s.nuls('claude.args'), original, 'role, settings, wake hook and isolation are restored');
    assert.equal(s.read('claude.cwd').trim(), realpathSync(s.dir));
    assert.equal(s.fac(['lead', 'alpha', '--team', 'beta', '--here']).code, 0);
    const fresh = s.nuls('claude.args');
    const id = fresh[fresh.indexOf('--session-id') + 1];
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(s.fac(['lead', '--resume-session', id, '--check']).code, 0);
    assert.equal(s.fac(['lead', '--resume-session', session, '--check']).code, 0, 'earlier sessions remain recorded');
  } finally {
    s.done();
  }
});

test('lead --here refuses to start when the identity cannot be read, and starts no claude', () => {
  const s = world();
  try {
    s.w('git-user.name', 'Agent Ann\n');
    const noEmail = s.fac(['lead', 'alpha', '--here']);
    assert.notEqual(noEmail.code, 0, noEmail.out);
    assert.match(noEmail.out, /user\.email/);
    s.identity('', 'agent.ann@example.invalid');
    assert.notEqual(s.fac(['lead', 'alpha', '--here']).code, 0, 'an empty name');
    s.identity();
    s.w('ssh-down', '');
    const down = s.fac(['lead', 'alpha', '--here']);
    assert.notEqual(down.code, 0, down.out);
    assert.equal(s.read('claude.args'), '', 'claude never ran');
  } finally {
    s.done();
  }
});

// Real git, in a temporary repository, with the system and global config files replaced by temporary ones; nothing connects anywhere.
function realGit(s, extra) {
  const base = join(s.dir, 'gitworld');
  mkdirSync(base, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: s.home, GIT_CONFIG_SYSTEM: join(base, 'system.conf'), GIT_CONFIG_GLOBAL: join(base, 'global.conf'), GIT_TERMINAL_PROMPT: '0', ...extra };
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (args, input) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', input });
  return { base, env, git };
}

test('lead --here: a remote of each GitHub form pushes to the unreachable URL and fetches from its own', () => {
  const s = world();
  try {
    s.identity();
    assert.equal(s.fac(['lead', 'alpha', '--here']).code, 0);
    const { env: hereEnv } = settingsOf(s.nuls('claude.args'));
    const { git } = realGit(s, hereEnv);
    writeFileSync(join(s.dir, 'gitworld/system.conf'), '');
    writeFileSync(join(s.dir, 'gitworld/global.conf'), '');
    assert.equal(git(['init', '-q']).status, 0);
    const base = 'file:///nonexistent/factory-lead-pushes-from-the-mac-mini/';
    for (const [name, url, rest] of [['a', 'https://github.com/owner/repo.git', 'owner/repo.git'], ['b', 'git@github.com:owner/repo.git', 'owner/repo.git'], ['c', 'ssh://git@github.com/owner/repo.git', 'owner/repo.git']]) {
      assert.equal(git(['remote', 'add', name, url]).status, 0);
      assert.equal(git(['remote', 'get-url', '--push', name]).stdout.trim(), `${base}${rest}`, url);
      assert.equal(git(['remote', 'get-url', name]).stdout.trim(), url, url);
    }
  } finally {
    s.done();
  }
});

test('lead --here: git over ssh fails before any connection and says why', () => {
  const s = world();
  try {
    s.identity();
    assert.equal(s.fac(['lead', 'alpha', '--here']).code, 0);
    const { env: hereEnv } = settingsOf(s.nuls('claude.args'));
    const { git, base } = realGit(s, hereEnv);
    writeFileSync(join(base, 'system.conf'), '');
    writeFileSync(join(base, 'global.conf'), '');
    assert.equal(git(['init', '-q']).status, 0);
    assert.equal(git(['remote', 'add', 'origin', 'git@github.com:x/y.git']).status, 0);
    const r = git(['ls-remote', 'origin']);
    assert.notEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /git over ssh is off for a MacBook Lead, pushes go from the Mac mini/);
  } finally {
    s.done();
  }
});

test('lead --here: git runs no credential helper from the system, global or URL-specific config', () => {
  const s = world();
  try {
    s.identity();
    assert.equal(s.fac(['lead', 'alpha', '--here']).code, 0);
    const { env: hereEnv } = settingsOf(s.nuls('claude.args'));
    const withEnv = realGit(s, hereEnv);
    const without = realGit(s, {});
    const marks = join(s.dir, 'marks');
    mkdirSync(marks);
    const helper = (name) => {
      const path = join(s.dir, `helper-${name}.sh`);
      writeFileSync(path, `#!/bin/sh\necho ran >> '${join(marks, name)}'\n`);
      chmodSync(path, 0o755);
      return path;
    };
    writeFileSync(join(withEnv.base, 'system.conf'), `[credential]\n\thelper = ${helper('system')}\n`);
    writeFileSync(join(withEnv.base, 'global.conf'), `[credential]\n\thelper = ${helper('global')}\n[credential "https://github.com"]\n\thelper =\n\thelper = ${helper('url')}\n`);
    const fill = (g) => g.git(['credential', 'fill'], 'protocol=https\nhost=github.com\n\n');
    assert.equal(withEnv.git(['init', '-q']).status, 0);
    fill(withEnv);
    assert.deepEqual(readdirSync(marks), [], 'a helper ran under the --here env');
    fill(without);
    assert.ok(readdirSync(marks).length >= 1, 'no helper ran without it, so the test shows nothing');
  } finally {
    s.done();
  }
});

test('lead --here refuses to start when its gh folder holds a login (hosts.yml), names the folder and file, and lets config.yml alone pass', () => {
  const s = world();
  try {
    s.identity();
    const empty = join(s.state, 'lead-here/gh-empty');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'config.yml'), 'version: "1"\n');
    assert.equal(s.fac(['lead', 'alpha', '--here']).code, 0, 'a config file is no login');
    rmSync(join(s.fake, 'claude.args'));
    writeFileSync(join(empty, 'hosts.yml'), 'x');
    const r = s.fac(['lead', 'alpha', '--here']);
    assert.notEqual(r.code, 0, r.out);
    assert.ok(r.out.includes(join(empty, 'hosts.yml')), r.out);
    assert.equal(s.read('claude.args'), '', 'claude never ran');
  } finally {
    s.done();
  }
});

test('lead passes arguments after -- to claude only with --here', () => {
  const s = world();
  try {
    s.identity();
    const r = s.fac(['lead', 'alpha', '--', 'x']);
    assert.equal(r.code, 2, r.out);
    assert.equal(s.calls(), '', 'no ssh call');
    assert.equal(s.read('claude.args'), '');
  } finally {
    s.done();
  }
});

test('lead --here is refused on the factory host, and with --new or --dry-run; the host\'s user on another machine is a node and starts it (#366)', () => {
  const s = world();
  try {
    s.identity();
    for (const more of [['--new'], ['--dry-run']]) {
      const r = s.fac(['lead', 'alpha', '--here', ...more]);
      assert.equal(r.code, 2, r.out);
    }
    s.onHost();
    const r = s.fac(['lead', 'alpha', '--here']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /--here/);
    assert.equal(s.read('claude.args'), '');
    assert.equal(s.calls(), '', 'no ssh call');
    // The MacBook's own `factory` user: the host's user name, on a machine with another name.
    s.onHost('another-machine');
    const node = s.fac(['lead', 'alpha', '--here']);
    assert.equal(node.code, 0, node.out);
    assert.notEqual(s.read('claude.args'), '');
  } finally {
    s.done();
  }
});

test('gh hands every argument to the remote gh unchanged, as the host\'s user in its login shell', () => {
  const s = world();
  try {
    const args = ['issue', 'comment', '1', '--body', 'two  words', "it's", 'say "hi"', '$HOME', '`echo x`', 'a;b&c|d*', 'line one\nline two\n', 'Tiếng Việt: đã xong', '', '-'];
    const r = s.fac(['gh', ...args]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(s.nuls('gh.args'), args);
    assert.match(s.calls(), /ssh .*factory@tuans-mac-mini zsh -lc '/);
  } finally {
    s.done();
  }
});

test('gh passes stdin to the remote gh and keeps its exit code', () => {
  const s = world();
  try {
    s.w('gh.exit', '3');
    const body = 'Nội dung\n$HOME `x` \'quoted\'\n';
    const r = s.fac(['gh', 'issue', 'comment', '1', '--body-file', '-'], body);
    assert.equal(r.code, 3, r.out);
    assert.equal(s.read('gh.stdin'), body);
    assert.deepEqual(s.nuls('gh.args'), ['issue', 'comment', '1', '--body-file', '-']);
    s.w('ssh-down', '');
    assert.equal(s.fac(['gh', 'api', 'user']).code, 255, 'ssh\'s own exit code when it cannot reach the host');
  } finally {
    s.done();
  }
});

// `factory linear` on the MacBook (#404): the host's own bin/factory is a fake in ~/WORKSPACES that records its arguments and stdin.
function hostFactory(s) {
  mkdirSync(join(s.home, 'WORKSPACES/bin'), { recursive: true });
  const file = join(s.home, 'WORKSPACES/bin/factory');
  writeFileSync(file, `#!/bin/sh
: > "$FAKE/host.args"
for a; do printf '%s\\0' "$a" >> "$FAKE/host.args"; done
cat > "$FAKE/host.stdin"
exit "$(cat "$FAKE/host.exit" 2>/dev/null || echo 0)"
`);
  chmodSync(file, 0o755);
}

test('linear refuses a usage error on the MacBook before any ssh, and a body that names a file', () => {
  const s = world();
  try {
    hostFactory(s);
    for (const args of [['linear'], ['linear', 'nope'], ['linear', 'take', 'FAC-12'], ['linear', 'take', 'bad key', '--team', 'lead'], ['linear', 'comment', 'FAC-12', '--team', 'lead', '--body-file', 'note.md'], ['linear', 'take', 'FAC-12', '--team', 'two-words']]) {
      const r = s.fac(args);
      assert.equal(r.code, 2, `${args}: ${r.out}`);
    }
    assert.equal(s.calls(), '', 'no ssh call');
    assert.equal(s.read('host.args'), '');
  } finally {
    s.done();
  }
});

test('linear runs on this node when its token store holds the Factory app\'s credentials, else on the host; Colly\'s verbs on the host (FAC-38)', () => {
  const s = world();
  try {
    hostFactory(s);
    const list = ['linear', 'list', '--team-key', 'ZZZ'];
    assert.equal(s.fac(list).code, 0);
    assert.deepEqual(s.nuls('host.args'), list, 'with no app credentials here, on the host');
    const app = join(s.dir, 'profiles/tokens/linear-app');
    mkdirSync(app, { recursive: true });
    for (const name of ['client-id', 'client-secret']) writeFileSync(join(app, name), `invented-${name}\n`);
    s.w('calls.log', '');
    s.w('host.args', '');
    const r = s.fac(list);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /team ZZZ is not the team of a repository on Linear/, 'run here, on this node\'s own registry, before any request');
    assert.equal(s.calls(), '', 'no ssh call');
    const close = ['linear', 'decision-close', 'INN-7', '--body-file', '-'];
    assert.equal(s.fac(close, 'done\n').code, 0);
    assert.deepEqual(s.nuls('host.args'), close, 'a verb that acts as Colly still runs on the host');
  } finally {
    s.done();
  }
});

test('linear hands a title with quotes and a dollar sign to the host unchanged, with the body on stdin and the host\'s exit code', () => {
  const s = world();
  try {
    hostFactory(s);
    const title = `it's "quoted" $HOME \`x\` a;b|c`;
    const body = 'Nội dung\n$HOME `x` \'quoted\'\n';
    const args = ['linear', 'create', '--team-key', 'FAC', '--title', title, '--status', 'Triage', '--body-file', '-'];
    s.w('host.exit', '1');
    const r = s.fac(args, body);
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(s.nuls('host.args'), args);
    assert.equal(s.read('host.stdin'), body);
    assert.match(s.calls(), /ssh .*factory@tuans-mac-mini zsh -lc '/);
    s.w('ssh-down', '');
    assert.equal(s.fac(['linear', 'read', 'FAC-12']).code, 255, 'ssh\'s own exit code when it cannot reach the host');
  } finally {
    s.done();
  }
});

test('gh refuses gh auth other than status, before any ssh', () => {
  const s = world();
  try {
    for (const args of [['auth', 'token'], ['auth', 'login'], ['auth', 'refresh'], ['auth', 'logout'], ['auth', 'setup-git'], ['auth']]) {
      const r = s.fac(['gh', ...args]);
      assert.equal(r.code, 2, `${args}: ${r.out}`);
      assert.match(r.out, /gh auth/);
    }
    assert.equal(s.calls(), '', 'no ssh call');
    assert.equal(s.fac(['gh', 'auth', 'status']).code, 0);
    assert.deepEqual(s.nuls('gh.args'), ['auth', 'status']);
  } finally {
    s.done();
  }
});

test('gh refuses an argument that names a file on the MacBook, before any ssh, and says to use stdin', () => {
  const s = world();
  try {
    const files = [
      ['issue', 'comment', '1', '--body-file', 'note.md'],
      ['issue', 'comment', '1', '--body-file=note.md'],
      ['issue', 'comment', '1', '-F', 'note.md'],
      ['api', 'x', '-F', 'body=@note.md'],
      ['api', 'x', '-Fbody=@note.md'],
      ['api', 'x', '--field', 'body=@note.md'],
      ['api', 'x', '--field=body=@note.md'],
      ['api', 'x', '--input', 'note.json'],
      ['api', 'x', '--input=note.json'],
      ['release', 'create', 'v1', '--notes-file', 'notes.md'],
      ['release', 'create', 'v1', '--notes-file=notes.md'],
      ['secret', 'set', 'X', '--env-file', '.env'],
      ['secret', 'set', 'X', '--env-file=.env'],
      ['issue', 'create', '--recover', 'saved'],
      ['issue', 'create', '--recover=saved'],
      ['api', 'x', '-iFbody=@note.md'],
      ['api', 'x', '-iF', 'body=@note.md'],
    ];
    for (const args of files) {
      const r = s.fac(['gh', ...args]);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
      assert.match(r.out, /stdin/);
      assert.match(r.out, /@-/);
    }
    assert.equal(s.calls(), '', 'no ssh call');
  } finally {
    s.done();
  }
});

test('factory passes --env-file to its own code, not to node, which would exit 9 on a file that does not exist', () => {
  const s = world();
  try {
    assert.ok(!existsSync(join(s.dir, 'missing.env')));
    for (const flag of [['--env-file', 'missing.env'], ['--env-file=missing.env']]) {
      const r = s.fac(['gh', 'secret', 'set', 'X', ...flag], undefined, s.dir);
      assert.equal(r.code, 2, `${flag}: ${r.out}`);
      assert.match(r.out, /stdin/);
    }
    assert.equal(s.calls(), '', 'no ssh call');
  } finally {
    s.done();
  }
});

test('gh lets a file on stdin through: --body-file -, -F x=@-, --input - and a field that is no file', () => {
  const s = world();
  try {
    const ok = [
      ['issue', 'comment', '1', '--body-file', '-'],
      ['issue', 'comment', '1', '--body-file=-'],
      ['issue', 'comment', '1', '-F', '-'],
      ['api', 'x', '-F', 'body=@-'],
      ['api', 'x', '--field', 'body=@-'],
      ['api', 'x', '--input', '-'],
      ['api', 'x', '--input=-'],
      ['release', 'create', 'v1', '--notes-file', '-'],
      ['secret', 'set', 'X', '--env-file=-'],
      ['api', 'x', '-iFbody=@-'],
      ['auth', 'status', '--hostname', 'github.com'],
      ['api', 'x', '-F', 'draft=true'],
      ['api', 'x', '-f', 'body=me@example.invalid'],
      ['issue', 'comment', '1', '--body', 'a file note.md is named in this text'],
    ];
    for (const args of ok) {
      const r = s.fac(['gh', ...args], 'x');
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.out}`);
      assert.deepEqual(s.nuls('gh.args'), args);
    }
  } finally {
    s.done();
  }
});

test('gh refuses gh auth status with -t or --show-token, before any ssh', () => {
  const s = world();
  try {
    for (const flag of ['-t', '--show-token', '-at', '--show-token=true', '--show-token=false', '-t=true', '-at=true']) {
      const r = s.fac(['gh', 'auth', 'status', flag]);
      assert.equal(r.code, 2, `${flag}: ${r.out}`);
      assert.match(r.out, /token/);
    }
    assert.equal(s.calls(), '', 'no ssh call');
  } finally {
    s.done();
  }
});

test('gh quotes an argument that starts with =', () => {
  const s = world();
  try {
    assert.equal(s.fac(['gh', 'api', '=gh', 'a=b']).code, 0);
    assert.deepEqual(s.nuls('gh.args'), ['api', '=gh', 'a=b']);
    assert.ok(s.calls().includes("'\\''=gh'\\''"), s.calls());
    assert.ok(!s.calls().includes(' =gh'), s.calls());
  } finally {
    s.done();
  }
});

test('gh runs the remote gh in a new temporary folder each call, removes it with what gh wrote there, and keeps gh\'s exit code', () => {
  const s = world();
  try {
    s.w('gh.exit', '3');
    s.w('gh.leave', '');
    const seen = [];
    for (let i = 0; i < 2; i++) {
      const r = s.fac(['gh', 'run', 'download', '1']);
      assert.equal(r.code, 3, r.out);
      seen.push(s.read('gh.cwd').trim());
      assert.ok(seen[i].startsWith('/'), seen[i]);
      assert.ok(!existsSync(seen[i]), `${seen[i]} is still there`);
    }
    assert.notEqual(seen[0], seen[1]);
  } finally {
    s.done();
  }
});

test('lead --here has a hook on SessionStart and SessionEnd that records and removes its inbox socket, alongside the transcript hooks (#351, #476)', () => {
  const s = world();
  try {
    s.identity();
    assert.equal(s.fac(['lead', 'alpha', '--team', 'beta', '--here']).code, 0);
    const { hooks } = settingsOf(s.nuls('claude.args'));
    assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    const [{ hooks: [{ type, command }] }] = hooks.SessionStart;
    assert.equal(type, 'command');
    assert.deepEqual(hooks.SessionEnd, hooks.SessionStart);
    const file = join(s.state, 'lead-here/alpha-beta.socket');
    const run = (event, extra) => spawnSync('sh', ['-c', command], { input: JSON.stringify({ hook_event_name: event }), encoding: 'utf8', env: { PATH: process.env.PATH, ...extra } });
    const env = { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks-1/42.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token-value' };
    const started = run('SessionStart', env);
    assert.equal(started.status, 0);
    assert.equal(started.stderr, '');
    assert.equal(readFileSync(file, 'utf8'), '/tmp/cc-socks-1/42.sock\n');
    const args = s.nuls('claude.args');
    const session = args[args.indexOf('--session-id') + 1];
    assert.deepEqual(readdirSync(join(s.state, 'lead-here')).sort(), [`${session}.json`, 'alpha-beta.socket', 'gh-empty'].sort());
    run('SessionStart', { CLAUDE_CODE_MESSAGING_SOCKET: 'uds:/tmp/cc-socks-1/43.sock' });
    assert.equal(readFileSync(file, 'utf8'), '/tmp/cc-socks-1/43.sock\n');
    assert.equal(run('SessionEnd', env).status, 0);
    assert.ok(!existsSync(file));
    run('SessionStart', env);
    run('SessionStart', {});
    assert.ok(!existsSync(file), 'a start with no variable removes it');
  } finally {
    s.done();
  }
});

test('lead --here\'s status line keeps the newest five-hour and seven-day quota for its team, from a hash-named copy, and prints nothing (#365 B5)', () => {
  const s = world();
  try {
    s.identity();
    assert.equal(s.fac(['lead', 'alpha', '--team', 'beta', '--here']).code, 0);
    const { command } = settingsOf(s.nuls('claude.args')).statusLine;
    assert.match(command, /\/factory-runs\/alpha-beta\/hooks\/statusline-hook-[0-9a-f]{7}\.mjs'/, command);
    const file = join(s.home, 'factory-runs/alpha-beta/statusline.jsonl');
    const run = (input) => spawnSync('sh', ['-c', command], { input, encoding: 'utf8', env: { PATH: process.env.PATH } });
    // Claude Code's status-line input carries more than the quota; only the two windows are kept.
    const windows = { five_hour: { used_percentage: 12, resets_at: 1793970000 }, seven_day: { used_percentage: 3, resets_at: 1794500000 } };
    let r = run(JSON.stringify({ session_id: 'made-up-session', model: { id: 'made-up-model' }, rate_limits: { ...windows, extra: { note: 'made-up-extra' } } }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'the pane shows no status line');
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(kept).sort(), ['at', 'rate_limits']);
    assert.deepEqual(kept.rate_limits, windows);
    // An input with no quota, or none that parses, leaves the newest one there.
    for (const input of [JSON.stringify({ session_id: 'made-up-session' }), 'not json']) {
      r = run(input);
      assert.equal(r.status, 0);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).rate_limits, windows);
    }
  } finally {
    s.done();
  }
});

test('lead --here\'s hook runs a copy of socket-hook.mjs under the state folder named by a hash of its bytes, reused by the next start (#390)', () => {
  const s = world();
  try {
    s.identity();
    const commandOf = () => settingsOf(s.nuls('claude.args')).hooks.SessionStart[0].hooks[0].command;
    assert.equal(s.fac(['lead', 'alpha', '--here']).code, 0);
    const first = commandOf();
    const copy = first.match(/'([^']*\/hooks\/socket-hook-[0-9a-f]{7}\.mjs)'/)?.[1];
    assert.equal(copy?.startsWith(join(s.state, 'hooks/')), true, first);
    assert.deepEqual(readFileSync(copy), readFileSync(join(factory, 'bin/lib/socket-hook.mjs')));
    assert.ok(!first.includes(join(factory, 'bin/lib/socket-hook.mjs')), 'the hook does not run the installed file itself');
    // A copy that is there is reused, never written again.
    writeFileSync(copy, '// marker\n');
    assert.equal(s.fac(['lead', 'alpha', '--here']).code, 0);
    assert.equal(commandOf(), first);
    assert.equal(readFileSync(copy, 'utf8'), '// marker\n');
    assert.deepEqual(readdirSync(join(s.state, 'hooks')), [copy.split('/').pop()]);
  } finally {
    s.done();
  }
});

/** A real socket in the world's temporary folder, and what it was sent. */
async function listener(s, name = 's') {
  const path = join(s.dir, name);
  const got = [];
  const server = createServer((c) => {
    let text = '';
    c.on('data', (d) => (text += d));
    c.on('end', () => got.push(text));
  });
  await new Promise((done) => server.listen(path, done));
  return { path, got, server };
}
const arrived = async (got, n) => {
  for (const start = Date.now(); got.length < n && Date.now() - start < 3000; ) await new Promise((r) => setTimeout(r, 10));
};
const CONTENT = (repo, n) => new RegExp(`^\\[factory\\] wake #\\d+-\\d+: new comment on ${repo}#${n}; re-read the issue\\.$`);

test('wake on the MacBook posts to the socket its own Lead recorded, with no ssh (#351)', async () => {
  const s = world();
  const l = await listener(s);
  try {
    mkdirSync(join(s.state, 'lead-here'), { recursive: true });
    writeFileSync(join(s.state, 'lead-here/factory-lead.socket'), `${l.path}\n`);
    const r = s.fac(['wake', 'factory', '--issue', '7']);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out.trim().split('\n').length, 1);
    await arrived(l.got, 1);
    assert.equal(l.got.length, 1);
    const o = JSON.parse(l.got[0]);
    assert.deepEqual(o, { type: 'user', message: { content: o.message.content } });
    assert.match(o.message.content, CONTENT('factory', 7));
    assert.equal(s.calls(), '', 'no ssh call');
    // A socket nothing serves any more: exit 1, the reason, and that the comment waits.
    l.server.close();
    const gone = s.fac(['wake', 'factory', '--issue', '7']);
    assert.equal(gone.code, 1, gone.out);
    assert.match(gone.out, /no file|refused/);
    assert.match(gone.out, /waits on GitHub/);
    assert.equal(s.calls(), '', 'a recorded socket is not retried over ssh');
  } finally {
    l.server.close();
    s.done();
  }
});

/** A fake ssh that runs the remote command as the factory host: here, with this account as the host's user. */
function hostSsh(s) {
  const bin = join(s.home, 'WORKSPACES/bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(factory, 'bin/factory'), join(bin, 'factory'));
  writeFileSync(join(s.dir, 'bin/ssh'), `#!/bin/sh\necho "ssh $*" >> "$FAKE/calls.log"\nfor last; do :; done\nif [ -f "$FAKE/ssh-down" ]; then echo 'ssh: Could not resolve hostname' >&2; exit 255; fi\nFACTORY_HOST_USER=${HOST_ENV.FACTORY_HOST_USER} FACTORY_HOST_NAME=${HOST_ENV.FACTORY_HOST_NAME} exec sh -c "$last"\n`);
  chmodSync(join(s.dir, 'bin/ssh'), 0o755);
}

test('wake on the MacBook with no local socket runs the same command on the Mac mini by ssh, which posts there (#351)', async () => {
  const s = world();
  const l = await listener(s);
  try {
    hostSsh(s);
    mkdirSync(join(s.home, 'factory-runs/alpha-beta'), { recursive: true });
    writeFileSync(join(s.home, 'factory-runs/alpha-beta/socket'), `${l.path}\n`);
    const r = s.fac(['wake', 'alpha', '--team', 'beta', '--issue', '12']);
    assert.equal(r.code, 0, r.out);
    assert.match(s.calls(), /ssh -o BatchMode=yes .*factory@tuans-mac-mini zsh -lc '~\/WORKSPACES\/bin\/factory wake alpha --team beta --issue 12'/);
    await arrived(l.got, 1);
    assert.match(JSON.parse(l.got[0]).message.content, CONTENT('alpha', 12));
    // The Lead of another team has no socket there: the host says so, and the exit code is 1.
    const none = s.fac(['wake', 'alpha', '--team', 'gamma', '--issue', '12']);
    assert.equal(none.code, 1, none.out);
    assert.match(none.out, /no file/);
    assert.match(none.out, /waits on GitHub/);
    s.w('ssh-down', '');
    const down = s.fac(['wake', 'alpha', '--team', 'beta', '--issue', '12']);
    assert.equal(down.code, 1, down.out);
    assert.match(down.out, /the Mac mini did not answer; the comment on #12 waits on GitHub/);
  } finally {
    l.server.close();
    s.done();
  }
});

test('wake on the Mac mini posts to <runs>/<repo>-<team>/socket, using the only existing team, with no ssh (#351)', async () => {
  const s = world();
  const l = await listener(s);
  try {
    s.onHost();
    mkdirSync(join(s.home, 'factory-runs/alpha-lead'), { recursive: true });
    writeFileSync(join(s.home, 'factory-runs/alpha-lead/socket'), `${l.path}\n`);
    const r = s.fac(['wake', 'alpha', '--issue', '3']);
    assert.equal(r.code, 0, r.out);
    await arrived(l.got, 1);
    assert.match(JSON.parse(l.got[0]).message.content, CONTENT('alpha', 3));
    assert.equal(s.fac(['wake', 'alpha', '--team', 'beta', '--issue', '3']).code, 1);
    assert.equal(s.calls(), '', 'no ssh call');
  } finally {
    l.server.close();
    s.done();
  }
});

test('wake refuses a bad repository, issue or team, a flag twice and any other word, with exit 2 and before any ssh (#351)', () => {
  const s = world();
  try {
    for (const args of [[], ['alpha'], ['alpha', '--issue'], ['alpha', '--issue', 'x'], ['alpha', '--issue', '0'], ['alpha', '--issue', '7', '--issue', '8'], ['alpha', '--issue', '7', '--team', 'Bad'], ['alpha', '--issue', '7', '--team', 'a', '--team', 'b'], ['alpha', '--issue', '7', 'extra'], ['--issue', '7'], ['a b', '--issue', '7'], ["a'b", '--issue', '7']]) {
      const r = s.fac(['wake', ...args]);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
      assert.match(r.out, /usage: bin\/factory/);
    }
    assert.equal(s.calls(), '', 'no ssh call');
  } finally {
    s.done();
  }
});

test('gh on the factory host runs gh itself, unchanged: no ssh, and no refusal', () => {
  const s = world();
  try {
    s.onHost();
    for (const args of [['issue', 'comment', '1', '--body-file', 'note.md'], ['auth', 'token'], ['api', 'user', '--jq', '.login']]) {
      const r = s.fac(['gh', ...args], 'in');
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(s.nuls('gh.args'), args);
      assert.equal(s.read('gh.stdin'), 'in');
    }
    s.w('gh.exit', '4');
    assert.equal(s.fac(['gh', 'api', 'user']).code, 4);
    assert.equal(s.calls(), '', 'no ssh call');
  } finally {
    s.done();
  }
});

test('lead --here copies its transcript with the pack hook so the reader can discover it (#476)', async () => {
  const s = world();
  try {
    s.identity();
    assert.equal(s.fac(['lead', 'alpha', '--team', 'beta', '--here']).code, 0);
    const { hooks } = settingsOf(s.nuls('claude.args'));
    const command = hooks.Stop[0].hooks[0].command;
    // The session writes its transcript under the team's profile, whatever CLAUDE_CONFIG_DIR the caller's shell has (#366).
    const config = join(s.dir, 'profiles/leads/alpha-beta/claude');
    const source = join(config, 'projects/fixture/0a1b2c3d-1111-2222-3333-444455556666.jsonl');
    mkdirSync(join(config, 'projects/fixture'), { recursive: true });
    const content = '{"type":"assistant","message":{"content":"Done","stop_reason":"end_turn"}}\n';
    writeFileSync(source, content);
    for (const event of ['Stop', 'SessionEnd']) {
      const r = spawnSync('sh', ['-c', command], { input: JSON.stringify({ hook_event_name: event, transcript_path: source }), encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
    }
    const { listStreams } = await import('../bin/lib/streams.mjs');
    const streams = listStreams(join(s.home, 'factory-runs'));
    const found = streams.find((stream) => stream.key.startsWith('alpha-beta/transcripts/'));
    assert.ok(found);
    assert.equal(readFileSync(found.file, 'utf8'), content);
    const copy = command.match(/'([^']*\/hooks\/transcript-copy-[0-9a-f]{7}\.mjs)'/)?.[1];
    assert.ok(copy);
    assert.deepEqual(readFileSync(copy), readFileSync(join(factory, 'packs/pstack/bin/transcript-copy.mjs')));
  } finally { s.done(); }
});
