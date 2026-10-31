// packs/pstack/bin/install-lead (#166): puts `lead` on the factory account's PATH, for ssh and for Herdr's panes. Run once as the
// factory host user, and again after a move of the clone; a second run changes nothing. It makes ~/.local/bin/lead a symlink to this
// clone's packs/pstack/bin/lead and keeps one marked block in ~/.zshenv (the only file a non-interactive ssh shell reads). It reads
// no credential and runs nothing but itself. HOME comes from the environment, so a test runs on a fixture home.
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN = '# >>> factory: lead on PATH (packs/pstack/bin/install-lead) >>>\n';
const END = '# <<< factory: lead on PATH <<<\n';
// Each folder goes in front only when PATH lacks it, so a shim `bin/seat` or the canary put first stays first, and a child zsh that
// reads this file again changes nothing. The loop runs in reverse so the result keeps ~/.zprofile's order. It prints nothing.
export const BLOCK = `${BEGIN}for d in /opt/homebrew/sbin /opt/homebrew/bin "$HOME/.local/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
unset d
export PATH
${END}`;

class Refusal extends Error {}

const lstatOrNull = (p) => {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

/** The new text of ~/.zshenv: the block appended, or the old block replaced in place. Throws a Refusal on markers that are not
 * exactly one begin line then one end line. */
export function withBlock(text, path) {
  const begins = text.split(BEGIN).length - 1;
  const ends = text.split(END).length - 1;
  if (begins === 0 && ends === 0) return text === '' || text.endsWith('\n') ? text + BLOCK : `${text}\n${BLOCK}`;
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (begins !== 1 || ends !== 1 || b < a) throw new Refusal(`${path} holds the factory's markers more than once, or only one, or in the wrong order; fix it by hand`);
  return text.slice(0, a) + BLOCK + text.slice(b + END.length);
}

// Write through a temporary name and a rename, so a reader never sees half a file.
function replace(path, make) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    make(tmp);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Plans and does the work; returns the lines to print. */
export function install({ home, launcher }) {
  const link = join(home, '.local/bin/lead');
  const zshenv = join(home, '.zshenv');
  const lines = [];

  // Decide everything before writing anything.
  const have = lstatOrNull(link);
  let relink = false;
  if (have) {
    const old = have.isSymbolicLink() ? readlinkSync(link) : null;
    if (old === launcher) {
      // already ours
    } else if (old !== null && isAbsolute(old) && old.endsWith('/packs/pstack/bin/lead')) {
      relink = true; // an earlier place of this launcher: the clone moved
    } else {
      throw new Refusal(`${link} is ${old === null ? 'a file' : `a symlink to ${old}`} that is not this launcher; install-lead replaces neither`);
    }
  } else {
    relink = true;
  }
  const st = lstatOrNull(zshenv);
  if (st && !st.isFile()) throw new Refusal(`${zshenv} is a symlink or not a regular file; install-lead writes neither`);
  const oldText = st ? readFileSync(zshenv, 'utf8') : '';
  const newText = withBlock(oldText, zshenv);

  if (relink) {
    mkdirSync(dirname(link), { recursive: true });
    replace(link, (tmp) => symlinkSync(launcher, tmp));
    lines.push(`linked ${link} -> ${launcher}`);
  }
  if (newText !== oldText) {
    replace(zshenv, (tmp) => writeFileSync(tmp, newText, { mode: st ? st.mode & 0o777 : 0o644 }));
    lines.push(`wrote the PATH block in ${zshenv}`);
  }
  return lines.length ? lines : ['nothing changed'];
}

function main(env) {
  const host = env.FACTORY_HOST_USER || 'factory';
  const who = userInfo().username;
  if (who !== host) {
    process.stderr.write(`install-lead: runs only as ${host} (FACTORY_HOST_USER), not as ${who}\n`);
    return 1;
  }
  const home = env.HOME;
  if (!home || !isAbsolute(home)) {
    process.stderr.write('install-lead: HOME is not an absolute path\n');
    return 1;
  }
  const launcher = join(realpathSync(dirname(fileURLToPath(import.meta.url))), 'lead');
  try {
    realpathSync(launcher);
    for (const line of install({ home, launcher })) process.stdout.write(`${line}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`install-lead: ${e instanceof Refusal || e.code === 'ENOENT' ? e.message : e.stack}\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.env);
}
