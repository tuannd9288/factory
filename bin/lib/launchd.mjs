// The factory's launchd jobs (FAC-85, fix 10): one table of them, with what each runs, when and on which node; one job builder, one
// property-list printer, one `which` and the environment a job's check runs in. The queue's sweep, the weekly digest and the MacBook's
// relay print their plists from it (each tool's `plist`), the sweep compares the installed plists with what it prints
// (bin/lib/checkout.mjs), and bin/install-factory installs the MacBook's as LaunchDaemons (#366). It imports nothing of the factory, so
// every module that prints or reads a job can import it without importing another's graph: the node and the installed copy come in
// from the caller (bin/lib/node.mjs).
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The private repository the weekly digest posts to, where the Human reads it (#209). */
export const DIGEST_REPO = 'tuannd9288/better-factory';

/** Where the MacBook's daemon also writes its events, for Colly, who runs as another user, to follow (FAC-43): a folder of its own in
 * /Users/Shared, which every local user can reach. */
export const MACBOOK_SHARE = '/Users/Shared/factory/events.jsonl';

/** The start of every job's label. */
export const PREFIX = 'io.github.tuannd9288.factory.';

const FACTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYSTEM = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * The factory's jobs, by name. Each says:
 * - `label`, its launchd label, and `node`, where it runs: the factory host (the Mac mini), the MacBook, or both;
 * - `tool`, the bin command it runs, with `verb` and `args` before the repositories, and `flags`, what that tool's `plist` takes to
 *   print the LaunchDaemon;
 * - `interval` in seconds, or `calendar`, launchd's StartCalendarInterval, in its place;
 * - `log`, its file under ~/Library/Logs/factory, which launchd does not make;
 * - `path`, the programs whose folders lead its PATH, before the system's (`self` is the folder of the node that prints it);
 * - `root`: `clone`, the checkout that prints it, or `installed`, the node's installed copy (#390);
 * - `keep`, the variables of the printing shell it keeps;
 * - `checkout`: `always` names the installed copy in FACTORY_CHECKOUT; `off-host` does so, and adds the events share, only off the
 *   factory host (#366);
 * - `runsAs`: `always` runs it as the user that printed it, with that user's HOME; `daemon` only for a LaunchDaemon.
 */
export const JOBS = {
  queue: {
    label: `${PREFIX}queue`, node: 'both', tool: 'bin/factory-queue', verb: 'sweep', args: [], flags: ['--daemon'],
    interval: 60, calendar: null, log: 'queue.log', path: ['gh', 'node', 'self'], root: 'clone',
    keep: ['GH_CONFIG_DIR', 'FACTORY_STATE', 'FACTORY_HUMAN'], checkout: 'off-host', runsAs: 'daemon',
  },
  digest: {
    label: `${PREFIX}digest`, node: 'factory', tool: 'bin/factory-ledger', verb: null, args: ['--post', DIGEST_REPO, '--last-week'], flags: ['--daemon'],
    interval: null, calendar: { Weekday: 1, Hour: 9, Minute: 0 }, log: 'digest.log', path: ['gh', 'node', 'self'], root: 'clone',
    keep: ['GH_CONFIG_DIR', 'FACTORY_STATE', 'FACTORY_HUMAN', 'FACTORY_ROOT', 'AGENT_PROFILES'], checkout: 'off-host', runsAs: 'daemon',
  },
  relay: {
    label: `${PREFIX}relay`, node: 'macbook', tool: 'bin/factory-relay', verb: 'run', args: [], flags: [],
    interval: 60, calendar: null, log: 'relay.log', path: ['node', 'ssh'], root: 'installed',
    keep: ['FACTORY_STATE', 'FACTORY_HOST_USER', 'FACTORY_HOST_NAME', 'XDG_DATA_HOME'], checkout: 'always', runsAs: 'always',
  },
};

/** The name of the job whose label is `label`, or null. */
export const nameOf = (label) => Object.keys(JOBS).find((name) => JOBS[name].label === label) ?? null;

/** The first `name` that PATH names, as PATH names it (a link stays a link: brew upgrade keeps /opt/homebrew/bin/node and removes the
 * Cellar path behind it), or null. Only absolute folders and executable files count. */
export function which(name, path) {
  for (const dir of (path ?? '').split(':')) {
    if (!isAbsolute(dir)) continue;
    const found = join(dir, name);
    try {
      accessSync(found, constants.X_OK);
      if (statSync(found).isFile()) return found;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * The job `name` of JOBS, for `repos` (the queue's and the digest's take repositories): its program from the root the table names, a PATH
 * that leads with the folders of the programs it runs as this shell finds them, the variables it keeps from `env`, and its log. launchd
 * starts a job with a bare PATH. A node found through a link (Homebrew's /opt/homebrew/bin) keeps the link's folder, which an upgrade does
 * not remove. `daemon` prints a LaunchDaemon, which runs as the account that printed it (#24). `place` and `installed` are where it is
 * printed and the node's installed copy (placeOf and installedRoot, bin/lib/node.mjs).
 */
export function job(name, { repos = [], env = process.env, daemon = false, place, installed }) {
  const spec = JOBS[name];
  const node = which('node', env.PATH) ?? process.execPath;
  const gh = spec.path.includes('gh') ? which('gh', env.PATH) : null;
  if (spec.path.includes('gh') && !gh) throw new Error('gh is not on PATH, so the job could not run it');
  const folder = { gh: () => dirname(gh), node: () => dirname(node), self: () => dirname(process.execPath), ssh: () => dirname(which('ssh', env.PATH) ?? '/usr/bin/ssh') };
  const path = [...new Set([...spec.path.map((p) => folder[p]()), ...SYSTEM])].join(':');
  if (gh) {
    const found = which('node', path);
    if (!found || realpathSync(found) !== realpathSync(node))
      throw new Error(`${dirname(gh)}, where gh is, holds another node than this shell's ${node}; put both on one folder first`);
  }
  const kept = Object.fromEntries(spec.keep.filter((k) => env[k]).map((k) => [k, env[k]]));
  const root = spec.root === 'installed' ? installed : FACTORY;
  const copy = spec.checkout === 'always' ? { FACTORY_CHECKOUT: installed }
    : place === 'factory' ? {} : { FACTORY_CHECKOUT: installed, FACTORY_EVENTS_SHARE: MACBOOK_SHARE };
  const asUser = spec.runsAs === 'always' || daemon;
  const home = asUser ? { HOME: env.HOME } : {};
  return {
    label: spec.label,
    interval: spec.calendar ? null : spec.interval,
    calendar: spec.calendar,
    program: [join(root, spec.tool), ...(spec.verb ? [spec.verb] : []), ...spec.args, ...repos.flatMap((repo) => ['--repo', repo])],
    cwd: root,
    env: spec.runsAs === 'always' ? { PATH: path, ...home, ...kept, ...copy } : { PATH: path, ...kept, ...copy, ...home },
    log: join(env.HOME, 'Library/Logs/factory', spec.log),
    user: asUser ? userInfo().username : null,
  };
}

/** The job as a property list, for ~/Library/LaunchAgents/<label>.plist, or with a user for /Library/LaunchDaemons/, which the Human
 * loads with sudo. Never KeepAlive: a run exits after it is done. */
export function plist(j) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const str = (s) => `<string>${esc(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(j.label)}
${j.user ? `  <key>UserName</key>\n  ${str(j.user)}\n` : ''}  <key>ProgramArguments</key>
  <array>
${j.program.map((a) => `    ${str(a)}`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  ${str(j.cwd)}
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(j.env).map(([k, v]) => `    <key>${esc(k)}</key>\n    ${str(v)}`).join('\n')}
  </dict>
${j.calendar
    ? `  <key>StartCalendarInterval</key>\n  <dict>\n${Object.entries(j.calendar).map(([k, v]) => `    <key>${esc(k)}</key>\n    <integer>${v}</integer>`).join('\n')}\n  </dict>\n  <key>RunAtLoad</key>\n  <false/>`
    : `  <key>StartInterval</key>\n  <integer>${j.interval ?? 60}</integer>\n  <key>RunAtLoad</key>\n  <true/>`}
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  ${str(j.log)}
  <key>StandardErrorPath</key>
  ${str(j.log)}
</dict>
</plist>
`;
}

/** What a job's check runs in before the Human loads it: what launchd gives every job (HOME, USER, TMPDIR), then the job's own
 * variables, and nothing else of the shell's. */
export const runEnv = (j, env = process.env) => ({ HOME: env.HOME, USER: env.USER ?? '', TMPDIR: env.TMPDIR ?? '/tmp', ...j.env });
