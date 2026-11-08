// This node (#366): the one place that resolves its facts from its environment (FAC-85, fix 7): its folders (home, state, runs, profiles,
// data, the factory root), which place it is and where its installed copy of the factory is, the factory host's name, its two macOS users
// and the agents' checkout there, and the agents' and the Human's GitHub logins. agent-orchestrator resolves its own once, in config.Load
// (backend/internal/config/config.go:273 at 9dc1c14), as piggery does in internal/driver/local/layout.go (67c083e). It imports nothing but
// checkout.mjs and token.mjs, so the daemon and the queue can use it without entering the module ring that bin/lib/factory.mjs is part of
// (factory.mjs -> colly-status.mjs -> ledger.mjs -> queue.mjs). bin/lib/factory.mjs re-exports placeOf and installedRoot.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT, checkoutRoot } from './checkout.mjs';
import { readTokenFile, tokenDir } from './token.mjs';

/** The factory host's name, which ssh reaches as factory@HOST. */
export const HOST = 'tuans-mac-mini';
/** The host's two macOS users: the agents' (FACTORY_HOST_USER where a test names another) and the Human's own. */
export const AGENTS_USER = 'factory';
export const HUMAN_USER = 'tuannguyen';
/** The agents' checkout of the factory on the factory host, as ssh reaches it there. */
export const HOST_CHECKOUT = `/Users/${AGENTS_USER}/WORKSPACES`;
/** A node's own `factory` command, as ssh to its agents' user runs it in a login shell: on the factory host its main checkout's, on any
 * other node the link bin/install-factory makes into its installed copy. */
export const factoryCommand = (node = HOST) => (node === HOST ? '~/WORKSPACES/bin/factory' : '~/.local/bin/factory');
/** The agents' and the Human's GitHub logins, when the environment names none. */
export const AGENT = 'tuan9288-agent';
export const HUMAN = 'tuannd9288';

/** The state folder: FACTORY_STATE, else ~/.local/state/factory. */
export const stateOf = (env = process.env) => env.FACTORY_STATE ?? join(env.HOME, '.local/state/factory');
/** The runs folder, where the seats' and the Leads' run folders are: FACTORY_RUNS, else ~/factory-runs, made absolute. */
export const runsOf = (env = process.env) => resolve(env.FACTORY_RUNS ?? join(env.HOME, 'factory-runs'));
/** The profiles folder: AGENT_PROFILES, else ~/.agent-profiles. */
export const profilesOf = (env = process.env) => env.AGENT_PROFILES ?? join(env.HOME, '.agent-profiles');
/** The factory's root: FACTORY_ROOT, else the checkout this code runs from. */
export const rootOf = (env = process.env) => env.FACTORY_ROOT ?? ROOT;
/** The factory's data folder: ${XDG_DATA_HOME:-~/.local/share}/factory. */
export const dataOf = (env = process.env) => join(env.XDG_DATA_HOME || join(env.HOME, '.local/share'), 'factory');
/** The Human's GitHub login: FACTORY_HUMAN, else HUMAN; an empty FACTORY_HUMAN means the default. */
export const humanOf = (env = process.env) => env.FACTORY_HUMAN || HUMAN;

/** This node's folders and settings, from its environment: { env, home, root, state, agentProfiles, runs, timeout }, `timeout` being a
 * vendor command's time limit in ms (FACTORY_TIMEOUT_MS, else 15 s). It takes the place of bin/lib/factory.mjs's contextOf (FAC-85). */
export function contextOf(env = process.env) {
  return {
    env,
    home: env.HOME,
    root: rootOf(env),
    state: stateOf(env),
    agentProfiles: profilesOf(env),
    runs: runsOf(env),
    timeout: Number(env.FACTORY_TIMEOUT_MS) || 15000,
  };
}

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
export const isAgentsUser = (env = process.env) => userInfo().username === (env.FACTORY_HOST_USER || AGENTS_USER);

/** The factory host is the machine named HOST (FACTORY_HOST_NAME in tests) when the command runs as the agents' user there. The agents'
 * `factory` user on any other machine is a node (#366). */
export const placeOf = (env = process.env) => (isAgentsUser(env) && nodeName() === (env.FACTORY_HOST_NAME || HOST) ? 'factory' : 'macbook');

/** Where this machine's installed copy of the factory is (#390): $FACTORY_CHECKOUT; on the factory host ~/WORKSPACES, as the queue's
 * checkoutRoot has it; on the MacBook ${XDG_DATA_HOME:-~/.local/share}/factory/checkout, outside the folders macOS refuses a launchd job.
 * Everything that runs on a schedule, and `factory` on the PATH, takes its root from here and never from where the running file sits. */
export function installedRoot(env = process.env) {
  if (env.FACTORY_CHECKOUT) return env.FACTORY_CHECKOUT;
  if (placeOf(env) === 'factory') return checkoutRoot(env) ?? join(env.HOME, 'WORKSPACES');
  return join(dataOf(env), 'checkout');
}

/** The agents' GitHub account, as bin/onboard names it. */
export const agentOf = (env = process.env) => env.FACTORY_AGENT ?? AGENT;

/** The agents' GitHub token in this node's own token store (#366), under the agents' account; undefined on the factory host, whose gh has its
 * own login, and on a node that holds none. */
export function nodeGithubToken(env = process.env) {
  if (placeOf(env) === 'factory') return undefined;
  return readTokenFile(join(tokenDir(profilesOf(env)), agentOf(env))).token;
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
 * only ever in the returned environment. */
export function nodeLogin(env, state) {
  if (placeOf(env) === 'factory') return { env: {} };
  const token = nodeGithubToken(env);
  if (!token) return { refusal: `this node holds no GitHub token for the agents (factory store ${agentOf(env)}), so the factory's gh and git do not run here` };
  const empty = join(state, 'node', 'gh-empty');
  mkdirSync(empty, { recursive: true, mode: 0o700 });
  return { env: { GH_TOKEN: token, GITHUB_TOKEN: '', GH_CONFIG_DIR: empty, GIT_TERMINAL_PROMPT: '0', ...gitEnv(TOKEN_GIT) } };
}
