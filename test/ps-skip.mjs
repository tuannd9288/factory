// The skip of the tests that run the real `ps` (#183). The worker's and the reviewer's Bash runs in Claude Code's sandbox, which
// refuses ps. A test skips only inside the factory's sandbox (FACTORY_SANDBOX=1, set by bin/seat) and only when ps on this very
// process fails with EPERM; without the marker a ps failure stays a failure. A test that uses a fake ps never takes the skip.
import { execFileSync } from 'node:child_process';

export const PS_SKIP_REASON = 'ps is refused in the factory\'s sandbox (#183)';

const realPs = (pid) => execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { stdio: ['ignore', 'pipe', 'pipe'] });

/** The skip reason, or false. ps is the seam: it runs ps on a pid and throws as execFileSync does when ps fails. */
export function psSkip({ env = process.env, ps = realPs, pid = process.pid } = {}) {
  if (env.FACTORY_SANDBOX !== '1') return false;
  try {
    ps(pid);
    return false;
  } catch (e) {
    return e.code === 'EPERM' || /EPERM|operation not permitted/i.test(String(e.stderr ?? e.message)) ? PS_SKIP_REASON : false;
  }
}

/** Decided once per file, when the file loads: pass it as a test's `skip` option. */
export const skipPs = psSkip();
