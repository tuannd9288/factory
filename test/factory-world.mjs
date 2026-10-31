// The world of bin/factory's tests: fake claude, codex, gh, direnv, pig and ssh on PATH, and fixture folders. Nothing live runs,
// and every name below is invented. The fake ssh runs `factory store` of the Mac mini for real, in a home of its own ($FAKE/far).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

export const EMAIL = 'ann.example@secret-corp.example';
export const ORG = 'org-00000000-1111-2222-3333-444444444444';
export const claudeJson = (email, plan = 'max') => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email, orgId: ORG, orgName: 'Secret Corp', subscriptionType: plan });
export const rowOf = (out, profile) => out.split('\n').find((l) => l.startsWith(profile));

// Each fake logs its argv and environment to calls.log, and answers from files in $FAKE.
const SCRIPTS = {
  claude: `#!/bin/sh
echo "claude $* CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" >> "$FAKE/calls.log"
if [ "$1" = setup-token ]; then
  echo "SETUP-BANNER on stdout"; echo "SETUP-BANNER on stderr" >&2
  [ -f "$FAKE/setup-fail" ] && exit 1
  exit 0
fi
[ -f "$FAKE/hang-claude" ] && exec sleep 30
f="$FAKE/claude-$(basename "\${CLAUDE_CONFIG_DIR:-default}").json"
if [ -f "$f" ]; then cat "$f"; else echo '{"loggedIn":false,"authMethod":"none"}'; exit 1; fi
`,
  codex: `#!/bin/sh
echo "codex $* CODEX_HOME=$CODEX_HOME" >> "$FAKE/calls.log"
f="$FAKE/codex-$(basename "\${CODEX_HOME:-default}")"
if [ -f "$f" ]; then echo "Logged in using ChatGPT"; exit 0; else echo "Not logged in"; exit 1; fi
`,
  gh: `#!/bin/sh
echo "gh $*" >> "$FAKE/calls.log"
if [ -f "$FAKE/gh-$USER_PLACE" ]; then printf 'github.com\\n  ✓ Logged in to github.com account %s (keyring)\\n' "$(cat "$FAKE/gh-$USER_PLACE")" >&2; else echo 'You are not logged into any GitHub hosts.' >&2; exit 1; fi
`,
  direnv: `#!/bin/sh
echo "direnv $* in $(basename "$PWD")" >> "$FAKE/calls.log"
shift 2
CLAUDE_CONFIG_DIR="$FAKE/lead-$(basename "$PWD")" exec "$@"
`,
  pig: `#!/bin/sh
echo "pig $*" >> "$FAKE/calls.log"
c="$1"; shift
if [ "$c" = claude ]; then CLAUDE_CONFIG_DIR="$FAKE/piggery-claude" exec claude "$@"; else CODEX_HOME="$FAKE/piggery-codex" exec codex "$@"; fi
`,
  ssh: `#!/bin/sh
echo "ssh $*" >> "$FAKE/calls.log"
for last; do :; done
user=\${last%%@*}
for a; do case "$a" in *@*) user=\${a%%@*};; esac; done
if [ -f "$FAKE/ssh-$user.error" ]; then cat "$FAKE/ssh-$user.error" >&2; exit 255; fi
cmd=$(printf '%s' "$last" | sed -n "s/^zsh -lc '\\(.*\\)'$/\\1/p")
case "$cmd" in
  *"factory store "*)
    rest=\${cmd#\\~/WORKSPACES/bin/factory}
    FACTORY_USER=factory HOME="$FAKE/far" AGENT_PROFILES="$FAKE/far/.agent-profiles" exec "$FACTORY_BIN" $rest;;
esac
if [ -f "$FAKE/ssh-factory.stderr" ]; then cat "$FAKE/ssh-factory.stderr" >&2; fi
if [ "$user" = factory ]; then cat "$FAKE/ssh-factory.json"; exit 0; fi
exec sh -c "$cmd"
`,
};

export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-bin-'));
  const fake = join(dir, 'fake');
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const state = join(dir, 'state');
  for (const d of [fake, bin, home, state]) mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(SCRIPTS)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const env = {
    FAKE: fake,
    FACTORY_BIN: join(factory, 'bin/factory'),
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    FACTORY_STATE: state,
    AGENT_PROFILES: join(home, '.agent-profiles'),
    FACTORY_ROOT: join(home, 'WORKSPACES'),
    FACTORY_RUNS: join(home, 'factory-runs'),
    FACTORY_SEAT_ACCOUNTS: '',
    FACTORY_USER: 'tuannguyen',
    USER_PLACE: 'macbook',
  };
  const w = (name, text) => writeFileSync(join(fake, name), text);
  const exec = (args, input) => {
    const { NODE_TEST_CONTEXT, ...outer } = process.env;
    const r = spawnSync(join(factory, 'bin/factory'), args, { cwd: factory, encoding: 'utf8', env: { ...outer, ...env }, input });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const calls = () => (existsSync(join(fake, 'calls.log')) ? readFileSync(join(fake, 'calls.log'), 'utf8') : '');
  const onHost = () => {
    env.USER_PLACE = 'factory';
    env.FACTORY_USER = 'factory';
  };
  // The files under the sandbox that hold these bytes, relative to it.
  const holders = (bytes) => {
    const found = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && readFileSync(p).includes(bytes)) found.push(p.slice(dir.length + 1));
      }
    };
    walk(dir);
    return found;
  };
  return {
    dir, fake, home, state, env, w, calls, onHost, holders, exec,
    fac: (...args) => exec(args),
    facIn: (input, ...args) => exec(args, input),
    tokens: (base = env.AGENT_PROFILES) => join(base, 'tokens'),
    modeOf: (p) => (statSync(p).mode & 0o777).toString(8),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
