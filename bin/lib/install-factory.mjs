// bin/lib/install-factory.mjs root|place|follow|daemons (#390): the parts of bin/install-factory that are not shell.
//   root     prints where this machine's installed copy of the factory is (installedRoot, bin/lib/factory.mjs)
//   place    prints `factory` on the factory host and `macbook` anywhere else (placeOf)
//   follow   brings the installed copy to origin/main by followMain (bin/lib/checkout.mjs), by the rules the Mac mini's sweep keeps ~/WORKSPACES
//            by: never under a live run, a refusal is in queue-checkout.failed and told here. Prints one line; exit 1 on a refusal.
//   daemons  on the MacBook (#366): the relay's and the queue's jobs, LaunchDaemons run by this user as the Mac mini's queue is, so they run
//            with nobody logged in. Each one's `check` runs, then its plist, as this copy renders it, goes to
//            $FACTORY_STATE/plist-wanted/<label>.plist (the folder the sweep leaves a wanted plist in) through a temporary name and a
//            rename; then one line says what the Human
//            runs with sudo to install and load those that differ from the installed ones (/Library/LaunchDaemons, read only), a loaded job
//            booted out first. It loads nothing itself. Exit 1 when a plist or a check fails.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quote } from '../../packs/pstack/bin/lead.mjs';
import { ROOT, followMain } from './checkout.mjs';
import { contextOf, installedRoot, placeOf } from './factory.mjs';
import { liveRuns } from './seat.mjs';

/** The MacBook's jobs: each label, the tool that prints and checks it, and the flags its `plist` takes for the LaunchDaemon. */
export const DAEMONS = [
  { label: 'io.github.tuannd9288.factory.relay', tool: 'bin/factory-relay', flags: [] },
  { label: 'io.github.tuannd9288.factory.queue', tool: 'bin/factory-queue', flags: ['--daemon'] },
];

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

/** `daemons`: the lines it says, through `say`, and its exit code. */
export function daemons(env = process.env, { root = ROOT, plistDir = env.FACTORY_PLIST_DIR ?? '/Library/LaunchDaemons', say = console.log } = {}) {
  const wantedDir = join(contextOf(env).state, 'plist-wanted');
  const steps = [];
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
    say(`install-factory: wrote ${file}`);
    if (spawnSync('launchctl', ['print', `system/${label}`], { stdio: 'ignore', env }).status === 0) {
      steps.push(`launchctl bootout system/${label}`);
      if (label.endsWith('.queue')) queueLoaded = true;
    }
    steps.push(`install -o root -g wheel -m 644 ${quote(file)} ${quote(target)}`, `launchctl bootstrap system ${quote(target)}`);
  }
  if (!steps.length) return 0;
  say(`install-factory: to install and load them, run: ${steps.map((s) => `sudo ${s}`).join(' && ')}`);
  // As bin/factory-queue's header has it: a daemon started by the old job keeps its environment while the new job's pings keep it alive.
  if (queueLoaded) say(`install-factory: between the bootout and the install, stop the daemon: check that the pid in ${join(contextOf(env).state, 'daemon.lock')} is the daemon (ps -p <pid> -o command= ends in bin/lib/daemon.mjs) and send it SIGTERM`);
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
