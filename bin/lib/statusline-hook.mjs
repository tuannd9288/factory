// The status line of a MacBook Lead (`factory lead <repo> --here`, #365 B5), which Claude Code runs with its status-line input on stdin:
// node <copy of this file> <file>. When the input carries `rate_limits`, it keeps the newest of them, the five-hour and seven-day use and
// reset alone, as one { at, rate_limits } line in <file>, through a temporary name and a rename, so `factory account list` on the
// MacBook shows that team's quota (lastStatusLine, bin/lib/quota.mjs). It reads and writes no token and prints nothing, so the pane shows
// no status line, as before. Like socket-hook.mjs it imports only node: modules, so a hash-named copy of it runs alone.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const window = (w) => (w && typeof w === 'object' ? { used_percentage: w.used_percentage, resets_at: w.resets_at } : undefined);
try {
  const file = process.argv[2];
  const r = JSON.parse(readFileSync(0, 'utf8'))?.rate_limits;
  if (file && r && typeof r === 'object') {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ at: new Date().toISOString(), rate_limits: { five_hour: window(r.five_hour), seven_day: window(r.seven_day) } })}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }
} catch {
  // A status line never fails the session, and a record it could not write is the next one's to write.
}
