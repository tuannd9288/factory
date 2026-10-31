// The SessionStart hook behind bin/factory-alerts (#24): a *.failed file in the state folder is a job (the queue, the
// digest) telling the Human it failed. A session in the agents' account says so before anything else, rather
// than the weekly digest. It also names a quota window Claude Code rejected or warns of (#63, #194). Claude Code reads the JSON on stdout (code.claude.com/docs/en/hooks): `systemMessage` is
// shown to the Human, `additionalContext` goes to Claude. It always exits 0, so a hook never blocks a session.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertLines, quotaRows } from './quota.mjs';

const pad = (n) => String(n).padStart(2, '0');
/** A time as the Human reads it, in the local zone: 2026-10-24 06:05. */
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The alert lines for a state folder: `factory: <file> (<mtime>): <first line, at most 200 characters>`, by file name.
 * A folder that does not exist has no failures; one that cannot be read gives the one line that says so. */
export function lines(state) {
  let names;
  try {
    names = readdirSync(state).filter((n) => n.endsWith('.failed')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return { lines: [], unreadable: false };
    return { lines: [`factory: cannot read the state folder ${state}: ${error.code ?? error.message}`], unreadable: true };
  }
  return {
    lines: names.map((name) => {
      let when = 'unknown time';
      let first = '(unreadable)';
      try {
        when = local(statSync(join(state, name)).mtime);
        first = readFileSync(join(state, name), 'utf8').split('\n')[0].slice(0, 200);
      } catch {}
      return `factory: ${name} (${when}): ${first}`;
    }),
    unreadable: false,
  };
}

/** The quota alerts (#63): the seats' newest rate_limit_event under FACTORY_RUNS (default ~/factory-runs). A status line
 * reports no rejection or warning, only a use, so the hook reads none (#194). A runs folder that cannot be read gives none:
 * the hook never fails a session. */
export function quotaLines(env) {
  try {
    const runs = env.FACTORY_RUNS ?? join(env.HOME ?? homedir(), 'factory-runs');
    return alertLines(quotaRows({ runs }));
  } catch {
    return [];
  }
}

/** What the hook prints for `argv`, or '' for nothing. */
export function output(argv, env) {
  if (env.FACTORY_NO_ALERTS === '1') return '';
  const { lines: failed, unreadable } = lines(env.FACTORY_STATE ?? join(env.HOME ?? homedir(), '.local/state/factory'));
  const found = [...failed, ...quotaLines(env)];
  if (!found.length) return '';
  if (argv.includes('--text')) return `${found.join('\n')}\n`;
  const text = found.join('\n');
  const say = { systemMessage: text };
  if (!unreadable)
    say.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: `Tell the Human these factory failures in your first reply, before anything else, then go on with what they asked:\n${text}`,
    };
  return `${JSON.stringify(say)}\n`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(output(process.argv.slice(2), process.env));
  } catch {}
  process.exitCode = 0;
}
