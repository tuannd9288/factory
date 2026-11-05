// Only the owning branch may be rewritten, under origin/main's forcePush switch.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function forcePushOn(driver) {
  const value = driver?.forcePush;
  if (value !== undefined && value !== 'pstack' && value !== 'off') throw new Error('forcePush must be pstack or off');
  return value !== 'off';
}

export function pushAllowed(command, cwd, seat = true) {
  const words = command.replace(/[\\'"]/g, '');
  if (!/\bgit\b[\s\S]*\bpush\b/.test(words)) return true;
  if (!seat && !/(?:--f|(?:^|\s)-[a-zA-Z]*f|--m|\+)/.test(words)) return true;
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['rev-parse', '--verify', 'origin/main^{commit}']);
    const present = git(['ls-tree', 'origin/main', '--', '.gate/driver.json']);
    const driver = present ? JSON.parse(git(['show', 'origin/main:.gate/driver.json'])) : {};
    const branch = git(['symbolic-ref', '--short', 'HEAD']);
    return forcePushOn(driver) && branch !== 'main' && !branch.startsWith('claim/') &&
      /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) && command === `git push --force-with-lease origin ${branch}`;
  } catch {
    return false;
  }
}

export function pushHook(seat = true, node = process.execPath) {
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  return [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${quote(node)} ${quote(fileURLToPath(import.meta.url))} ${seat ? 'seat' : 'lead'}` }] }];
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (!pushAllowed(input.tool_input?.command ?? '', input.cwd, process.argv[2] !== 'lead')) {
      console.error('forcePush: only git push --force-with-lease origin <current branch> is allowed when origin/main enables it; never main or claim refs');
      process.exitCode = 2;
    }
  } catch { process.exitCode = 2; }
}
