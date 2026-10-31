// packs/pstack/scripts/lib/driver.mjs (#288): main's way to run a change as a user, .gate/driver.json, which scripts/ship and
// scripts/live-verify both read. Until #264, packs/pstack/INSTALL.md lays scripts/ship without live-verify, so ship reads
// the driver here and imports nothing of live-verify's.
import { execFileSync } from 'node:child_process';

/** Main's driver, read from the base commit, never the candidate's: a pull request cannot redefine its own proof. */
export function driverAt(base) {
  try {
    const d = JSON.parse(execFileSync('git', ['show', `${base}:.gate/driver.json`], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] }));
    return String(d.name ?? '').trim() && String(d.drive ?? '').trim() ? { name: d.name, start: d.start ?? '', drive: d.drive, network: d.network === true } : null;
  } catch {
    return null;
  }
}
