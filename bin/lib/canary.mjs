// The Claude canary (#24): Claude Code updates itself on the stable channel, installing each version under
// <versions>/<version> and leaving a launcher we wrote alone (code.claude.com/docs/en/setup). The launcher decides
// which version runs. One run probes the newest version with the pack probe and moves the launcher to it only if the
// probe passes, so a new version runs only after it has been measured. A version that fails is rejected until a newer
// one arrives; the launcher stays. A failure leaves claude-canary.failed in the state folder for bin/factory-alerts.
// It runs once and exits: launchd repeats it. See bin/claude-canary for the arguments.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { job, plist } from './queue.mjs';

const clone = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE_MS = 45 * 60_000;

/** Dotted versions compared part by part as numbers, so 2.1.10 follows 2.1.9. */
export const compare = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const unq = (s) => s.replace(/'\\''/g, "'");
const same = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
};
const readOr = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
};

/** The launcher text this tool writes, and the one thing it parses back out of it. */
export const launcherText = (versions, version) => `#!/bin/sh\nexec ${q(join(versions, version))} "$@"\n`;

/** The version the launcher runs: the installer's symlink into `versions`, or a script this tool wrote. Anything else
 * throws, and the run writes that to the failed file. */
export function currentOf(launcher, versions) {
  let st;
  try {
    st = lstatSync(launcher);
  } catch {
    throw new Error(`the launcher ${launcher} does not exist`);
  }
  let target;
  if (st.isSymbolicLink()) target = resolve(dirname(launcher), readlinkSync(launcher));
  else target = /^#!\/bin\/sh\nexec '((?:[^']|'\\'')*)' "\$@"\n$/.exec(readFileSync(launcher, 'utf8'))?.[1];
  if (target === undefined || !same(dirname(unq(target)), versions) || !/^\d+(\.\d+)*$/.test(basename(unq(target))))
    throw new Error(`the launcher ${launcher} is neither the installer's symlink into ${versions} nor a script this tool wrote`);
  return basename(unq(target));
}

/** Writes the launcher through a temp file beside it and a rename, so a session never meets half of it. */
function writeLauncher(launcher, versions, version) {
  mkdirSync(dirname(launcher), { recursive: true });
  const tmp = join(dirname(launcher), `.${basename(launcher)}.${process.pid}.tmp`);
  writeFileSync(tmp, launcherText(versions, version), { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, launcher);
}

/** One run. Returns the exit code: 0 for a pass or nothing to do, 1 when the probe failed the version, 2 when the
 * run could not judge. */
export function run({ repo, probe, env }) {
  const home = env.HOME ?? homedir();
  const state = env.FACTORY_STATE ?? join(home, '.local/state/factory');
  const versions = env.CLAUDE_VERSIONS ?? join(home, '.local/share/claude/versions');
  const launcher = env.CLAUDE_LAUNCHER ?? join(home, '.local/bin/claude');
  const failedFile = join(state, 'claude-canary.failed');
  const stamp = () => new Date().toISOString();
  mkdirSync(state, { recursive: true });
  const fail = (text, code) => {
    writeFileSync(failedFile, `${stamp()} claude${text}\n`);
    console.error(`claude-canary: claude${text}`);
    return code;
  };

  let current;
  let all;
  try {
    all = readdirSync(versions).filter((n) => /^\d+(\.\d+)*$/.test(n)).sort(compare);
    current = currentOf(launcher, versions);
  } catch (error) {
    return fail(`: ${error.message}`, 2);
  }
  const rejected = readOr(join(state, 'claude-rejected'));
  const probed = readOr(join(state, 'claude-probed'));
  const candidate = all.filter((v) => v !== rejected).at(-1);
  if (!candidate || compare(candidate, current) < 0 || (candidate === current && probed === current)) {
    console.log(`claude-canary: nothing to do; the launcher runs ${current}, probed ${probed || 'never'}, newest version ${candidate ?? 'none'}${rejected ? `, rejected ${rejected}` : ''}`);
    return 0;
  }

  const claude = `direnv exec . ${join(versions, candidate)}`;
  const command = `${probe ?? `node ${q(join(clone, 'probes/pack-probe.mjs'))} --repo ${repo} --no-pr`} --claude ${q(claude)}`;
  console.log(`claude-canary: probing ${candidate} (the launcher runs ${current})`);
  const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...env, FACTORY_NO_ALERTS: '1' }, maxBuffer: 256 << 20, timeout: PROBE_MS, killSignal: 'SIGKILL' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(out);

  if (r.status === 0) {
    writeLauncher(launcher, versions, candidate);
    writeFileSync(join(state, 'claude-probed'), `${candidate}\n`);
    rmSync(failedFile, { force: true });
    rmSync(join(state, 'claude-rejected'), { force: true });
    for (const v of all) if (compare(v, current) < 0) rmSync(join(versions, v), { recursive: true, force: true });
    console.log(`claude-canary: the launcher now runs ${candidate}`);
    return 0;
  }
  if (r.status === 1) {
    writeFileSync(join(state, 'claude-rejected'), `${candidate}\n`);
    const bad = out.split('\n').filter((l) => /^\s*(FAIL|INCONCLUSIVE)\b/.test(l)).slice(0, 10);
    writeFileSync(failedFile, [`${stamp()} claude ${candidate} failed the probe; the launcher stays on ${current}`, ...bad].join('\n') + '\n');
    console.error(`claude-canary: ${candidate} failed the probe; the launcher stays on ${current}`);
    return 1;
  }
  return fail(` ${candidate}: the probe could not run (exit ${r.status ?? r.signal ?? r.error?.code})`, 2);
}

function main(argv) {
  const [command, ...rest] = argv;
  let repo;
  let probe;
  let daemon = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--daemon' && command === 'plist') daemon = true;
    else if (rest[i] === '--repo') {
      if (repo) throw new Error('--repo is given once');
      repo = rest[++i];
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`--repo needs owner/name, not ${JSON.stringify(repo ?? '')}`);
    } else if (rest[i] === '--probe' && command === 'run') {
      probe = rest[++i];
      if (!probe) throw new Error('--probe needs a command');
    } else throw new Error(`unknown argument ${rest[i]}`);
  }
  if (!['run', 'plist'].includes(command) || !repo) throw new Error('usage: claude-canary run|plist --repo owner/name [--probe <command>] [--daemon]');
  if (command === 'plist') {
    const as = { label: 'com.tuanhub.factory.claude-canary', tool: 'bin/claude-canary', verb: 'run', log: 'claude-canary.log', interval: 21600, keep: ['CLAUDE_VERSIONS', 'CLAUDE_LAUNCHER', 'AGENT_PROFILES', 'FACTORY_ROOT'], tools: ['direnv'] };
    return void process.stdout.write(plist(job([repo], process.env, daemon, as)));
  }
  return run({ repo, probe, env: process.env });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2)) ?? 0;
  } catch (error) {
    console.error(`claude-canary: ${String(error.message).trim()}`);
    process.exitCode = 2;
  }
}
