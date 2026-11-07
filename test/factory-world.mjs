// The world of bin/factory's tests: fake claude, codex, gh, direnv, pig and ssh on PATH, and fixture folders. Nothing live runs,
// and every name below is invented. The fake ssh runs `factory store` of the Mac mini for real, in a home and a state folder of its own
// ($FAKE/far, $FAKE/far/state), so each node has its own accounts file and token store.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_ENV, factory } from './helpers.mjs';

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
  // Logs its arguments to herdr.log. `agent wait` fails while herdr-busy exists; `agent get` prints the state in herdr-state (idle
  // by default) until `agent prompt` has been sent, then fails as a pane with no agent does; herdr-stuck keeps the agent there.
  // herdr-busy-<pane> busies one pane only, and a prompt exits only the pane it names (herdr-exited-<pane>, #196).
  // herdr-dialog: the prompt leaves the pane it names at Claude Code's exit dialog, so \`agent get\` prints blocked (#315);
  // \`agent send-keys\` exits 1 while herdr-keys-fail exists.
  herdr: `#!/bin/sh
echo "$*" >> "$FAKE/herdr.log"
case "$1 $2" in
  "agent wait") if [ -f "$FAKE/herdr-busy" ] || [ -f "$FAKE/herdr-busy-$3" ]; then echo "timed out" >&2; exit 1; fi; exit 0;;
  "agent get")
    if [ -f "$FAKE/herdr-exited" ] || [ -f "$FAKE/herdr-exited-$3" ]; then echo '{"error":{"code":"agent_not_found"}}' >&2; exit 1; fi
    if [ -f "$FAKE/herdr-blocked-$3" ]; then printf '{"agent":"claude","agent_status":"blocked"}\\n'; exit 0; fi
    printf '{"agent":"claude","agent_status":"%s"}\\n' "$(cat "$FAKE/herdr-state" 2>/dev/null || echo idle)"; exit 0;;
  "agent prompt")
    if [ -f "$FAKE/herdr-dialog" ]; then : > "$FAKE/herdr-blocked-$3"; elif [ ! -f "$FAKE/herdr-stuck" ]; then : > "$FAKE/herdr-exited-$3"; fi; exit 0;;
  "agent send-keys") if [ -f "$FAKE/herdr-keys-fail" ]; then echo "send-keys failed" >&2; exit 1; fi; exit 0;;
esac
exit 0
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
  *"factory store "*|*"factory use"*|*"factory account remove "*)
    rest=\${cmd#\\~/WORKSPACES/bin/factory}; rest=\${rest#\\~/.local/bin/factory}
    FACTORY_HOST_USER="$FAR_USER" FACTORY_HOST_NAME="$FAR_NAME" HOME="$FAKE/far" AGENT_PROFILES="$FAKE/far/.agent-profiles" FACTORY_STATE="$FAKE/far/state" exec "$NODE_BIN" -- "$FACTORY_BIN" $rest;;
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
    FACTORY_BIN: join(factory, 'bin/lib/factory.mjs'),
    NODE_BIN: process.execPath,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    FACTORY_STATE: state,
    AGENT_PROFILES: join(home, '.agent-profiles'),
    FACTORY_ROOT: join(home, 'WORKSPACES'),
    FACTORY_RUNS: join(home, 'factory-runs'),
    // The factory host is where the caller's user is FACTORY_HOST_USER: the MacBook here, the Mac mini after onHost() and in the
    // fake ssh's far side (FAR_USER, on the machine FAR_NAME).
    FACTORY_HOST_USER: 'nobody-here',
    FAR_USER: HOST_ENV.FACTORY_HOST_USER,
    FAR_NAME: HOST_ENV.FACTORY_HOST_NAME,
    USER_PLACE: 'macbook',
  };
  const w = (name, text) => writeFileSync(join(fake, name), text);
  const exec = (args, input) => {
    const { NODE_TEST_CONTEXT, ...outer } = process.env;
    const r = spawnSync(process.execPath, ['--', join(factory, 'bin/lib/factory.mjs'), ...args], { cwd: factory, encoding: 'utf8', env: { ...outer, ...env }, input });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const calls = () => (existsSync(join(fake, 'calls.log')) ? readFileSync(join(fake, 'calls.log'), 'utf8') : '');
  const onHost = () => {
    env.USER_PLACE = 'factory';
    Object.assign(env, HOST_ENV);
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
