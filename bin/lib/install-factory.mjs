// bin/lib/install-factory.mjs root|place|follow|daemons (#390): the parts of bin/install-factory that are not shell.
//   root     prints where this machine's installed copy of the factory is (installedRoot, bin/lib/factory.mjs)
//   place    prints `factory` on the factory host and `macbook` anywhere else (placeOf)
//   follow   brings the installed copy to origin/main by followMain (bin/lib/checkout.mjs), by the rules the Mac mini's sweep keeps ~/WORKSPACES
//            by: never under a live run, a refusal is in queue-checkout.failed and told here. Prints one line; exit 1 on a refusal.
//   daemons  on the MacBook (#366), as its `factory` user alone (any other user is refused, exit 1): the relay's and the queue's jobs,
//            LaunchDaemons run by this user as the Mac mini's queue is, so they run with nobody logged in. Each one's `check` runs, then its
//            plist, as this copy renders it, goes to $FACTORY_STATE/plist-wanted/<label>.plist (the folder the sweep leaves a wanted plist in)
//            through a temporary name and a rename, and three lines say its sha256, the user it runs as and what it runs. Then numbered
//            steps for the Human's own terminal install and load those that differ from the installed ones (/Library/LaunchDaemons, read
//            only), one at a time: his own user's LaunchAgents from before #366 out; the loaded jobs booted out; the queue's daemon stopped
//            by hand; one `sudo sh -c` that installs only copies it checked against those sha256 (sudoLine). It loads nothing itself.
//            Exit 1 when a plist or a check fails.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quote } from '../../packs/pstack/bin/lead.mjs';
import { ROOT, followMain } from './checkout.mjs';
import { contextOf, installedRoot, placeOf } from './factory.mjs';
import { JOBS, PREFIX } from './launchd.mjs';
import { isAgentsUser } from './node.mjs';
import { liveRuns } from './seat.mjs';

/** The MacBook's jobs, in the order they are installed: each label, the tool that prints and checks it, and the flags its `plist` takes for
 * the LaunchDaemon, from the table (bin/lib/launchd.mjs). */
const MACBOOK = ['relay', 'queue'];
export const DAEMONS = MACBOOK.map((name) => ({ label: JOBS[name].label, tool: JOBS[name].tool, flags: JOBS[name].flags }));

/** The line for one `follow`, and its exit code. */
export function follow(env = process.env, move = followMain) {
  const root = installedRoot(env);
  const ctx = contextOf(env);
  const r = move({ root, state: ctx.state, live: () => liveRuns(ctx.runs), env });
  if (r.status === 'refused') return { code: 1, line: `install-factory: ${root} is not moved: ${r.why}` };
  if (r.status === 'updated') return { code: 0, line: `install-factory: ${root} moved ${r.from.slice(0, 7)}..${r.to.slice(0, 7)} (${r.behind} commits)` };
  return { code: 0, line: `install-factory: ${root} is ${r.status}` };
}

const readOr = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const unxml = (s) => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
/** What a plist runs, as root will install it: its UserName and its ProgramArguments, read from the text itself. */
const whatRuns = (text) => ({
  user: unxml(/<key>UserName<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1] ?? '(none: root)'),
  program: [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1])),
});

/** The install step the Human runs (#366). The wanted plists sit in a folder the agents' user can write, so as root it takes nothing it has
 * not checked: a folder of its own (mktemp -d, mode 700), a copy of each plist into it, the copies checked against the sha256 this run printed
 * (shasum -a 256 -c), and only then, for each, the install from its copy and the load. Checking the copy, not the file in the agents' folder,
 * leaves nothing to swap between the check and the install; a failed check installs nothing. */
export function sudoLine(jobs) {
  // A path of plain characters goes in as it is, so the line reads plainly; any other is quoted.
  const arg = (s) => (/^[\w./@%+=:,-]+$/.test(s) ? s : quote(s));
  const copy = (i) => `$d/${i}.plist`;
  const script = [
    'set -e', 'd=$(mktemp -d)', 'trap "rm -rf $d" EXIT',
    ...jobs.map((j, i) => `cp ${arg(j.file)} ${copy(i)}`),
    `printf "%s  %s\\n" ${jobs.map((j, i) => `${j.sha} ${copy(i)}`).join(' ')} | shasum -a 256 -c`,
    ...jobs.flatMap((j, i) => [`install -o root -g wheel -m 644 ${copy(i)} ${arg(j.target)}`, `launchctl bootstrap system ${arg(j.target)}`]),
  ].join('; ');
  return `sudo sh -c ${quote(script)}`;
}

/** The jobs his own user ran before #366, LaunchAgents of his: out, with their plists, so they do not run beside the daemons. Run in his own
 * terminal, where $(id -u) and ~ are his; a job that is not loaded is skipped quietly. */
const OLD_AGENTS = `for j in ${MACBOOK.join(' ')}; do launchctl bootout gui/$(id -u)/${PREFIX}$j 2>/dev/null; rm -f ~/Library/LaunchAgents/${PREFIX}$j.plist; done`;

/** `daemons`: the lines it says, through `say`, and its exit code. */
export function daemons(env = process.env, { root = ROOT, plistDir = env.FACTORY_PLIST_DIR ?? '/Library/LaunchDaemons', say = console.log } = {}) {
  // The jobs run as the user that prints their plists (UserName), so only the agents' user may: under the Human's own user they would run
  // with his files and Keychain (#366 (a)).
  if (!isAgentsUser(env)) {
    say(`install-factory: this account, ${userInfo().username}, is not the agents' user ${env.FACTORY_HOST_USER || 'factory'}: the relay's and the queue's jobs run as that user (#366), so run install-factory as it; no job was written`);
    return 1;
  }
  const wantedDir = join(contextOf(env).state, 'plist-wanted');
  const jobs = [];
  let queueLoaded = false;
  for (const { label, tool, flags } of DAEMONS) {
    const printed = spawnSync(join(root, tool), ['plist', ...flags], { encoding: 'utf8', env });
    if (printed.status !== 0) {
      say(`install-factory: ${tool} plist failed: ${(printed.stderr || `exit ${printed.status}`).trim().split('\n')[0]}`);
      return 1;
    }
    const target = join(plistDir, `${label}.plist`);
    if (readOr(target) === printed.stdout) {
      say(`install-factory: ${target} is installed as this copy renders it`);
      continue;
    }
    if (spawnSync(join(root, tool), ['check'], { stdio: 'inherit', env }).status !== 0) {
      say(`install-factory: ${tool} check failed; once what it says is fixed, run this same line again`);
      return 1;
    }
    // After the check: the queue's runs a sweep, whose plist comparison writes this folder too.
    mkdirSync(wantedDir, { recursive: true });
    const file = join(wantedDir, `${label}.plist`);
    writeFileSync(`${file}.tmp-${process.pid}`, printed.stdout);
    renameSync(`${file}.tmp-${process.pid}`, file);
    const sha = createHash('sha256').update(printed.stdout).digest('hex');
    const { user, program } = whatRuns(printed.stdout);
    say(`install-factory: wrote ${file}, sha256 ${sha}`);
    say(`install-factory: ${label} runs as the user ${user}`);
    say(`install-factory: ${label} runs ${program.join(' ')}`);
    const loaded = spawnSync('launchctl', ['print', `system/${label}`], { stdio: 'ignore', env }).status === 0;
    if (loaded && label.endsWith('.queue')) queueLoaded = true;
    jobs.push({ label, file, target, sha, loaded });
  }
  if (!jobs.length) return 0;
  // Steps, one at a time, in his own terminal: the factory user has no sudo.
  const loaded = jobs.filter((j) => j.loaded);
  const steps = [
    `step: ${OLD_AGENTS}`,
    ...(loaded.length ? [`step: ${loaded.map((j) => `sudo launchctl bootout system/${j.label}`).join('; ')}`] : []),
    // As bin/factory-queue's header has it: a daemon started by the old job keeps its environment while the new job's pings keep it alive.
    ...(queueLoaded ? [`by hand: stop the daemon: check that the pid in ${join(contextOf(env).state, 'daemon.lock')} is the daemon (ps -p <pid> -o command= ends in bin/lib/daemon.mjs) and send it SIGTERM`] : []),
    `step: ${sudoLine(jobs)}`,
  ];
  say('install-factory: to install and load them, run these in your own terminal, one at a time, after reading the lines above:');
  steps.forEach((s, i) => say(`install-factory: ${i + 1}, ${s}`));
  return 0;
}

export function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (rest.length) throw new Error('usage: install-factory.mjs root|place|follow|daemons');
  if (command === 'root') return { code: 0, line: installedRoot(env) };
  if (command === 'place') return { code: 0, line: placeOf(env) };
  if (command === 'follow') return follow(env);
  if (command === 'daemons') return { code: daemons(env), line: null };
  throw new Error('usage: install-factory.mjs root|place|follow|daemons');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = main(process.argv.slice(2));
    if (r.line !== null) (r.code === 0 ? console.log : console.error)(r.line);
    process.exitCode = r.code;
  } catch (error) {
    console.error(`install-factory: ${error.message}`);
    process.exitCode = 2;
  }
}
