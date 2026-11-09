// The one way the gate's Node code, the pack's scripts/ship and the factory's own code run gh (FAC-85): one output ceiling and one default
// timeout, so no caller stops at Node's 1 MiB of output or waits forever on a gh that never answers. A caller whose call takes
// longer passes its own timeout.
import { execFileSync } from 'node:child_process';

/** The most gh may print: a ceiling, not memory taken up front. */
export const GH_BUFFER = 256 << 20;
export const GH_TIMEOUT_MS = 60_000;

/** gh's stdout for args, as text; throws as execFileSync does (a non-zero exit, a timeout, more output than GH_BUFFER). input,
 * when given, is gh's stdin; env, when given, its whole environment. */
export function gh(args, { input, env, timeout = GH_TIMEOUT_MS } = {}) {
  return execFileSync('gh', args, {
    input,
    env,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: GH_BUFFER,
    timeout,
  });
}
