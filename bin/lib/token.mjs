// The token store of `factory login` (#177): one file for each account, ~/.agent-profiles/tokens/<account>, mode 600, in a
// folder of mode 700. This file holds the checks of a name and of a token, the write, the list of the files and the read of a
// token from stdin. It never prints a token, and no error it raises holds one.
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ACCOUNT = /^[a-z0-9][a-z0-9._-]*$/;

/** The reason a name is refused, or null. The name is never quoted: a token pasted by mistake must not come back. */
export const accountRefusal = (name) => (typeof name === 'string' && ACCOUNT.test(name) && !name.includes('..')
  ? null
  : 'the account name is refused: lowercase letters, digits, ".", "_" and "-", starting with a letter or digit, and no ".."');

/** { token } from what stdin held, once a single trailing newline is removed; or { error } for an empty token or more than one line. */
export function tokenOf(text) {
  const token = text.replace(/\r?\n$/, '');
  if (!token.trim()) return { error: 'the token is empty' };
  if (/[\r\n]/.test(token)) return { error: 'the token is more than one line' };
  return { token };
}

export const tokenDir = (agentProfiles) => join(agentProfiles, 'tokens');

/** Writes the token to a temporary file in the store and renames it over <account>. The caller has checked both. */
export function writeToken(agentProfiles, account, token) {
  const dir = tokenDir(agentProfiles);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.${account}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(dir, account));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The accounts that have a token file, sorted; a file whose name is not an account name (a temporary file, say) is not one. */
export function tokenAccounts(agentProfiles) {
  let entries = [];
  try {
    entries = readdirSync(tokenDir(agentProfiles), { withFileTypes: true });
  } catch {
    // no store yet
  }
  return entries.filter((e) => e.isFile() && accountRefusal(e.name) === null).map((e) => e.name).sort();
}

/** All of stdin, as text. On a terminal, with echo off, up to the first Enter; the text after it in the same paste is kept, so a
 * paste of more than one line is refused like any other. Not a terminal: stdin as it is, which is how a pipe or a test feeds it. */
export function readSecret(stdin = process.stdin, prompt = process.stderr) {
  if (!stdin.isTTY) return readAll(stdin);
  return new Promise((resolve, reject) => {
    prompt.write('Paste the token and press Enter (nothing is shown): ');
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let text = '';
    const end = (settle) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      prompt.write('\n');
      settle();
    };
    function onData(chunk) {
      for (let i = 0; i < chunk.length; i += 1) {
        const ch = chunk[i];
        if (ch === '\r' || ch === '\n') return end(() => resolve(text + chunk.slice(i)));
        if (ch === '\u0003') return end(() => reject(new Error('interrupted')));
        text = ch === '\u007f' || ch === '\b' ? text.slice(0, -1) : text + ch;
      }
    }
    stdin.on('data', onData);
  });
}

async function readAll(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
