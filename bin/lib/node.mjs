// This node (#366): which place it is, where its installed copy of the factory is, and the agents' GitHub login it holds. It imports
// nothing but checkout.mjs and token.mjs, so the daemon and the queue can use it without entering the module ring that bin/lib/factory.mjs
// is part of (factory.mjs -> colly-status.mjs -> ledger.mjs -> queue.mjs). bin/lib/factory.mjs re-exports placeOf and installedRoot.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { checkoutRoot } from './checkout.mjs';
import { readTokenFile, tokenDir } from './token.mjs';

/** The factory host's name, which ssh reaches as factory@HOST. */
export const HOST = 'tuans-mac-mini';

// The function itself, taken now: a test that mocks child_process.spawnSync later does not get this read.
const run = spawnSync;
let name;
/** This machine's name, in lower case: its LocalHostName (`scutil --get LocalHostName`, the name set in Sharing), which a network cannot
 * change, as it can the kernel's host name when HostName is not set; os.hostname() where scutil is missing or fails (Linux). Read once. */
export function nodeName() {
  if (name === undefined) {
    const r = run('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const local = r.status === 0 ? r.stdout.trim() : '';
    name = (local || hostname()).toLowerCase().replace(/\.local$/, '').split('.')[0];
  }
  return name;
}

/** Whether this process runs as the agents' macOS user: FACTORY_HOST_USER, `factory` unless the setting names another (#366). */
export const isAgentsUser = (env = process.env) => userInfo().username === (env.FACTORY_HOST_USER || 'factory');

/** The factory host is the machine named HOST (FACTORY_HOST_NAME in tests) when the command runs as the agents' user there. The agents'
 * `factory` user on any other machine is a node (#366). */
export const placeOf = (env = process.env) => (isAgentsUser(env) && nodeName() === (env.FACTORY_HOST_NAME || HOST) ? 'factory' : 'macbook');

/** Where this machine's installed copy of the factory is (#390): $FACTORY_CHECKOUT; on the factory host ~/WORKSPACES, as the queue's
 * checkoutRoot has it; on the MacBook ${XDG_DATA_HOME:-~/.local/share}/factory/checkout, outside the folders macOS refuses a launchd job.
 * Everything that runs on a schedule, and `factory` on the PATH, takes its root from here and never from where the running file sits. */
export function installedRoot(env = process.env) {
  if (env.FACTORY_CHECKOUT) return env.FACTORY_CHECKOUT;
  if (placeOf(env) === 'factory') return checkoutRoot(env) ?? join(env.HOME, 'WORKSPACES');
  return join(env.XDG_DATA_HOME || join(env.HOME, '.local/share'), 'factory/checkout');
}

/** The agents' GitHub account, as bin/onboard names it: FACTORY_AGENT, else nami9288; an empty FACTORY_AGENT means the default, as
 * bin/onboard's ${FACTORY_AGENT:-…} has it. */
export const agentOf = (env = process.env) => env.FACTORY_AGENT || 'nami9288';

/** The agents' GitHub token in this node's own token store (#366), under the agents' account; undefined on the factory host, whose gh has its
 * own login, and on a node that holds none. */
export function nodeGithubToken(env = process.env) {
  if (placeOf(env) === 'factory') return undefined;
  return readTokenFile(join(tokenDir(env.AGENT_PROFILES ?? join(env.HOME, '.agent-profiles')), agentOf(env))).token;
}

/** git's settings for the agents' token in the environment as GH_TOKEN (#366): no credential helper git was given, one for
 * https://github.com that reads $GH_TOKEN, and GitHub's ssh addresses over HTTPS. */
export const TOKEN_GIT = [
  ['credential.helper', ''],
  ['credential.https://github.com.helper', '!f() { if [ "$1" = get ]; then printf "%s\\n" "username=x-access-token" "password=$GH_TOKEN"; fi; }; f'],
  ...['git@github.com:', 'ssh://git@github.com/'].map((from) => ['url.https://github.com/.insteadOf', from]),
];

/** git settings as the environment variables git reads them from. */
export const gitEnv = (pairs) => ({
  GIT_CONFIG_COUNT: String(pairs.length),
  ...Object.fromEntries(pairs.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
});

/** The environment the factory's own gh and git run with on this node (#366): on the factory host none, since its gh has the agents' login.
 * Elsewhere the node's agents token alone: GH_TOKEN, an empty GITHUB_TOKEN, an empty gh folder under `state` (so no login of the person
 * whose machine it is is read), and TOKEN_GIT. { env }, or { refusal } in one line when the node holds no agents token. The token is
 * only ever in the returned environment. `more` are git settings the caller adds, after TOKEN_GIT's, and on the host alone. */
export function nodeLogin(env, state, more = []) {
  if (placeOf(env) === 'factory') return { env: more.length ? gitEnv(more) : {} };
  const token = nodeGithubToken(env);
  if (!token) return { refusal: `this node holds no GitHub token for the agents (factory store ${agentOf(env)}), so the factory's gh and git do not run here` };
  const empty = join(state, 'node', 'gh-empty');
  mkdirSync(empty, { recursive: true, mode: 0o700 });
  return { env: { GH_TOKEN: token, GITHUB_TOKEN: '', GH_CONFIG_DIR: empty, GIT_TERMINAL_PROMPT: '0', ...gitEnv([...TOKEN_GIT, ...more]) } };
}
