// The token store of `factory login` (#177): one file for each account, ~/.agent-profiles/tokens/<account>, mode 600, in a
// folder of mode 700. This file holds the checks of a name and of a token, the write, the list of the files and the read of a
// token from stdin. It never prints a token, and no error it raises holds one.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ACCOUNT = /^[a-z0-9][a-z0-9._-]*$/;

/** Names that are folders of the store, not Claude accounts (#403): the Factory app's Linear credentials and token live in
 * tokens/linear-app/, which tokenAccounts skips because it is no file. No account may take the name. */
export const APP_FOLDERS = ['linear-app'];

/** The reason a name is refused, or null. The name is never quoted: a token pasted by mistake must not come back. */
export const accountRefusal = (name) => {
  if (typeof name === 'string' && APP_FOLDERS.includes(name)) return 'the account name is refused: it is a folder of the store for an app, not an account';
  return typeof name === 'string' && ACCOUNT.test(name) && !name.includes('..')
    ? null
    : 'the account name is refused: lowercase letters, digits, ".", "_" and "-", starting with a letter or digit, and no ".."';
};

/** { token } from what stdin held: a carriage return is a line end (a terminal in raw mode sends Return as one), a single trailing
 * newline is removed and spaces and tabs around the token are trimmed; or { error } for an empty token, more than one line, or
 * whitespace inside the token. */
export function tokenOf(text) {
  let token = text.replace(/\r\n?/g, '\n');
  if (token.endsWith('\n')) token = token.slice(0, -1);
  if (!token.trim()) return { error: 'the token is empty' };
  if (token.includes('\n')) return { error: 'the token is more than one line' };
  token = token.replace(/^[ \t]+|[ \t]+$/g, '');
  if (/\s/.test(token)) return { error: 'the token has whitespace inside it' };
  return { token };
}

export const tokenDir = (agentProfiles) => join(agentProfiles, 'tokens');

/** What a token file holds, for the seats and the Leads: { token } with trailing newlines stripped, or { error: 'missing' } for no
 * such file, or { error: 'unprintable' } for an empty file or any byte outside printable ASCII (0x21-0x7E), since Node's error for
 * such a value in an environment quotes it. The error never holds the value. */
export function readTokenFile(path) {
  let text = '';
  try {
    text = readFileSync(path, 'latin1').replace(/[\r\n]+$/, '');
  } catch (e) {
    if (e.code === 'ENOENT') return { error: 'missing' };
  }
  return /^[\x21-\x7e]+$/.test(text) ? { token: text } : { error: 'unprintable' };
}

/** Writes the token to a temporary file in the store and renames it over <account>. The caller has checked both. */
export function writeToken(agentProfiles, account, token) {
  const dir = tokenDir(agentProfiles);
  let st = null;
  try {
    st = lstatSync(dir);
  } catch {
    // no store yet: made below
  }
  if (st?.isSymbolicLink()) throw new Error(`${dir} is a symlink; nothing was stored`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.${account}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, join(dir, account));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** An app's folder in the store (#403): tokens/<app>/, mode 700, holding one file for each secret (mode 600). */
export const appDir = (agentProfiles, app) => join(tokenDir(agentProfiles), app);

/** Writes one file of an app's folder through a temporary file and a rename, mode 600. `app` is one of APP_FOLDERS and `name` a plain
 * file name; the caller has checked the text. */
export function writeAppFile(agentProfiles, app, name, text) {
  if (!APP_FOLDERS.includes(app) || !/^[a-z][a-z0-9.-]*$/.test(name)) throw new Error('that is not a file of an app folder');
  const dir = tokenDir(agentProfiles);
  let st = null;
  try {
    st = lstatSync(dir);
  } catch {
    // no store yet: made below
  }
  if (st?.isSymbolicLink()) throw new Error(`${dir} is a symlink; nothing was stored`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const folder = appDir(agentProfiles, app);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const tmp = join(folder, `.${name}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, join(folder, name));
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

const letterOf = (i) => (i >= 26 ? letterOf(Math.floor(i / 26) - 1) : '') + String.fromCharCode(97 + (i % 26));

/** The lettered accounts, sorted: every account the accounts file names, and every token file's name. Names come from the file and
 * from readdir; no token file is read. */
export function accountList({ state, agentProfiles }) {
  const names = [...new Set([...Object.values(readAccounts(state)), ...tokenAccounts(agentProfiles)])].sort();
  return names.map((name, i) => ({ name, letter: letterOf(i) }));
}

/** The accounts file (#178), $FACTORY_STATE/accounts: "<profile>=<account>" a line, the one source of every row's account. It is
 * read as { profile: account }; a comment, a blank line or a line with no name is skipped. No file is no rows. */
export function readAccounts(state) {
  let text = '';
  try {
    text = readFileSync(join(state, 'accounts'), 'utf8');
  } catch {
    // no file: no row has an account
  }
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#') && line.slice(i + 1).trim()) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** The old seat rows (#311), as { 1, 2 } from the file. No start reads them: they only name the account of a run, or of a record, from
 * before a session wrote its own account. */
export function seatAccounts(state) {
  const rows = readAccounts(state);
  return Object.fromEntries([1, 2].filter((n) => rows[`factory/seat-${n}`]).map((n) => [n, rows[`factory/seat-${n}`]]));
}

/** Sets one row's account: the file is written to a temporary name in its folder, mode 600, and renamed over the old one. The other
 * lines, comments included, stay as they were. */
export function setAccount(state, profile, account) {
  mkdirSync(state, { recursive: true });
  const file = join(state, 'accounts');
  let lines = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
  } catch {
    // a new file
  }
  const at = lines.findIndex((l) => !l.trimStart().startsWith('#') && l.indexOf('=') > 0 && l.slice(0, l.indexOf('=')).trim() === profile);
  if (at >= 0) lines[at] = `${profile}=${account}`;
  else lines.push(`${profile}=${account}`);
  const tmp = join(state, `.accounts.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const stampOf = (at) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Moves a file into a folder of mode 700 under the archive, by rename, as <UTC stamp>-<name>; a name taken that second gets a
 * counter, so nothing archived is overwritten. Returns the new path. */
function archive(agentProfiles, kind, from, name, at) {
  const dir = join(agentProfiles, 'archive', kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of [join(agentProfiles, 'archive'), dir]) chmodSync(d, 0o700);
  let to = join(dir, `${stampOf(at)}-${name}`);
  for (let n = 1; existsSync(to); n += 1) to = join(dir, `${stampOf(at)}-${name}.${n}`);
  renameSync(from, to);
  return to;
}

/** `factory logout`: tokens/<account> goes to archive/tokens/<UTC stamp>-<account>, never deleted. */
export function archiveToken(agentProfiles, account, at = new Date()) {
  const from = join(tokenDir(agentProfiles), account);
  if (!existsSync(from)) throw new Error(`there is no token file for ${account}`);
  return archive(agentProfiles, 'tokens', from, account, at);
}

export const seat1File = (agentProfiles) => join(agentProfiles, 'seats/1/oauth-token');

/** Seat 1's old token file moves to archive/seat-1/<UTC stamp>-oauth-token once seat 1's account has a token in tokens/. Returns the
 * new path, or null when nothing moved (no such file, no row, or no token for the account yet). */
export function retireSeat1File(agentProfiles, state, at = new Date()) {
  const account = readAccounts(state)['factory/seat-1'];
  const old = seat1File(agentProfiles);
  if (!account || !existsSync(old) || !existsSync(join(tokenDir(agentProfiles), account))) return null;
  return archive(agentProfiles, 'seat-1', old, 'oauth-token', at);
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
