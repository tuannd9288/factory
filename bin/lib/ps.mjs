// This host's processes, from ps: the kernel's own record, which no launcher can change (argv it can). One ps, by absolute path,
// /bin/ps on macOS and on Linux with a merged /usr, so no caller's PATH picks it (FAC-85).
import { execFileSync } from 'node:child_process';

export const PS = '/bin/ps';

/** The uid and start time of a process, { uid, started } in ms (lstart has one-second precision); null when ps fails or there is no
 * such process. */
function processInfo(pid) {
  try {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(execFileSync(PS, ['-o', 'uid=,lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }));
    const started = m ? Date.parse(m[2]) : NaN;
    return Number.isNaN(started) ? null : { uid: Number(m[1]), started };
  } catch {
    return null;
  }
}

/** The process lister the liveness checks read (bin/lib/seat.mjs): `signal` sends signal 0 and throws as process.kill does, `info` is
 * processInfo. A test passes a lister of its own. */
export const PROCESSES = { signal: (pid) => process.kill(pid, 0), info: processInfo };
