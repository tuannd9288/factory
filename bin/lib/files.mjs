// The file writes and reads the factory's parts repeated by hand, in one place (FAC-85, fix 8): a write through a temporary file and a
// rename, a private folder, a JSON object read that is absent only when there is no file, and the setting of one key in a JSON file. As
// agent-orchestrator's runfile package writes (backend/internal/runfile/runfile.go at 9dc1c14), the temporary file sits in the target's
// folder, so the rename replaces the target in one step and a reader sees the old file or the new one, never half of one; a write that
// fails removes it. It imports nothing but node: modules, so every part can load it without the rest of the factory. The hooks copied out
// to run alone (bin/lib/socket-hook.mjs, bin/lib/statusline-hook.mjs, packs/pstack/bin/transcript-copy.mjs) keep their own few lines.
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Writes `data` to `file` through `.<name>.<pid>.tmp` in its folder, made afresh (a leftover of an earlier run of this pid is removed and
 * the file made again), then a rename. With `mode`, the file gets exactly that mode, whatever the umask; without it, the default a new file
 * gets. The folder must exist. A failed write removes the temporary file and throws its error. */
export function writeAtomic(file, data, { mode } = {}) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  const make = () => writeFileSync(tmp, data, mode === undefined ? { flag: 'wx' } : { mode, flag: 'wx' });
  try {
    try {
      make();
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      rmSync(tmp, { force: true });
      make();
    }
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Makes `dir` and its parents, and sets mode 700 on `dir`. With refuseLink, a symlink at `dir` is refused first, before anything is made:
 * for a folder that holds secrets, where a link could lead them elsewhere. */
export function privateDir(dir, { refuseLink = false } = {}) {
  if (refuseLink) {
    let st = null;
    try {
      st = lstatSync(dir);
    } catch {
      // not there yet: made below
    }
    if (st?.isSymbolicLink()) throw new Error(`${dir} is a symlink; nothing was stored`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** The JSON object `file` holds, or undefined when there is no file (ENOENT, and nothing else). A file that cannot be read throws the read's
 * error; one that does not hold a JSON object (it does not parse, or it is an array, null or a scalar) throws an Error whose code is
 * 'ENOTOBJECT'. */
export function readJsonObject(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    // not JSON: refused below
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(`${file} does not hold a JSON object`), { code: 'ENOTOBJECT' });
  return value;
}

/** Sets `key` to `value` in the JSON object of `file`, every other key and the file's mode kept, and returns true; returns false, writing
 * nothing, when the key already holds that value. A missing file is an empty object, written with mode 600 in a folder made with mode 700.
 * Every error names the file: "could not read <file>: <code>", "<file> does not hold a JSON object; fix or move it" (the file is then
 * unchanged), or "could not write <file>: <code>". */
export function setJsonKey(file, key, value) {
  let json;
  let mode = 0o600;
  try {
    json = readJsonObject(file);
    if (json !== undefined) mode = statSync(file).mode & 0o777;
  } catch (e) {
    if (e.code === 'ENOTOBJECT') throw new Error(`${file} does not hold a JSON object; fix or move it`);
    throw new Error(`could not read ${file}: ${e.code ?? e.message}`);
  }
  if (json?.[key] === value) return false;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeAtomic(file, `${JSON.stringify({ ...json, [key]: value }, null, 2)}\n`, { mode });
  } catch (e) {
    throw new Error(`could not write ${file}: ${e.code ?? e.message}`);
  }
  return true;
}
