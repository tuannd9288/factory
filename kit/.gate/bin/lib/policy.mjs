// The gate's policy files, read the same way by .gate/bin/tier, .gate/bin/verify-trusted and .gate/bin/verify (policy):
// .gate/protected (tier 3), .gate/load-bearing (tier 2), .github/CODEOWNERS. A file that is missing or does not
// parse throws: a policy nobody can read decides nothing.
//   node .gate/bin/lib/policy.mjs protected [--rules <dir>]   paths on stdin, the protected ones on stdout
//   node .gate/bin/lib/policy.mjs check [--rules <dir>]       CODEOWNERS ends with exactly the protected paths, owned
//   node .gate/bin/lib/policy.mjs checks [--rules <dir>]      the required checks of .gate/ruleset.json, one per line
// Exit 0 fine, 1 on a mismatch, 2 when a policy file cannot be read.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A gitignore-style pattern as a regex over repository paths. */
export function globToRegex(glob) {
  let g = glob.trim();
  const anchored = g.startsWith('/') || g.replace(/\/$/, '').includes('/');
  g = g.replace(/^\//, '');
  const dir = g.endsWith('/');
  g = g.replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${anchored ? '^' : '(^|/)'}${re}${dir ? '/' : '(/|$)'}`);
}

/** The non-comment lines of a policy file, each split on whitespace; throws when the file cannot be read. */
export function linesOf(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`could not read ${file}: ${error.code ?? error.message}`);
  }
  return text
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** One gitignore-style pattern per line, as { glob, re }. */
export function patternsOf(file) {
  return linesOf(file).map((l) => ({ glob: l.split(/\s+/)[0], re: globToRegex(l.split(/\s+/)[0]) }));
}

/** .gate/protected: { paths: [{ glob, re }], keys: [{ glob, re, line }] }. */
export function protectedOf(dir) {
  const file = join(dir, '.gate/protected');
  const paths = [];
  const keys = [];
  for (const l of linesOf(file)) {
    const key = /^key\s+(\S+)\s+(.+)$/.exec(l);
    if (!key) {
      paths.push({ glob: l, re: globToRegex(l) });
      continue;
    }
    try {
      keys.push({ glob: key[1], re: globToRegex(key[1]), line: new RegExp(key[2]) });
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
  }
  if (!paths.length) throw new Error(`${file} protects no path`);
  return { paths, keys };
}

/** The names of the checks .gate/ruleset.json requires on main. */
export function requiredChecks(dir) {
  const file = join(dir, '.gate/ruleset.json');
  let ruleset;
  try {
    ruleset = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${file}: ${error.code ?? error.message}`);
  }
  const names = (ruleset.rules ?? []).flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context);
  if (!names.length) throw new Error(`${file} requires no check`);
  return names;
}

/** The problems with .github/CODEOWNERS against .gate/protected: GitHub takes the last matching line, so the protected
 * paths come last, each with an owner, and nothing after them can take one back. No protected path ends in "/". */
export function ownersProblems(dir) {
  const { paths } = protectedOf(dir);
  const lines = linesOf(join(dir, '.github/CODEOWNERS')).map((l) => l.split(/\s+/));
  const tail = lines.slice(-paths.length);
  const globs = new Set(paths.map((p) => p.glob));
  const listed = new Set(tail.map((parts) => parts[0]));
  const out = [];
  for (const p of paths) if (!listed.has(p.glob)) out.push(`${p.glob} is not among the last lines of .github/CODEOWNERS`);
  // A trailing "/" matches only what is under the folder, in GitHub's CODEOWNERS and in globToRegex alike: the path itself,
  // a file or a link there, would be tier 1 and owned by no one.
  for (const p of paths) if (p.glob.endsWith('/')) out.push(`${p.glob} ends in "/", so the path ${p.glob.slice(0, -1)} itself, a file or a link there, is not protected; write it without the "/"`);
  for (const [glob, ...owners] of tail) {
    if (!globs.has(glob)) out.push(`${glob} is not a protected path, yet it sits among the protected lines at the end of .github/CODEOWNERS`);
    else if (!owners.some((o) => o.includes('@'))) out.push(`${glob} has no owner in .github/CODEOWNERS`);
  }
  return out;
}

function main(argv) {
  const [command, ...rest] = argv;
  const i = rest.indexOf('--rules');
  const dir = i >= 0 ? rest[i + 1] : '.';
  try {
    if (command === 'protected') {
      const { paths } = protectedOf(dir);
      for (const path of readFileSync(0, 'utf8').split('\n').filter(Boolean)) if (paths.some((p) => p.re.test(path))) console.log(path);
      return 0;
    }
    if (command === 'checks') {
      for (const name of requiredChecks(dir)) console.log(name);
      return 0;
    }
    if (command === 'check') {
      const problems = ownersProblems(dir);
      // The repository's own verify (GATE_NATIVE) decides what the gate runs, so it is a protected path or the check fails.
      const n = rest.indexOf('--native');
      const native = n >= 0 ? rest[n + 1] : '';
      // check_native runs "./$GATE_NATIVE": a value with .. or a leading / would be matched here as written and run elsewhere.
      if (native && (native.startsWith('/') || native.endsWith('/') || native.split('/').includes('..') || posix.normalize(native) !== native)) problems.push(`${native} is not a plain relative path, so it cannot be the native verify (GATE_NATIVE)`);
      else if (native && !protectedOf(dir).paths.some((p) => p.re.test(native))) problems.push(`${native} is the native verify (GATE_NATIVE) and no protected path in .gate/protected covers it`);
      for (const p of problems) console.log(`policy: ${p}`);
      if (problems.length) console.log('policy: .gate/protected and the end of .github/CODEOWNERS list the same paths, each owned by the Human');
      return problems.length ? 1 : 0;
    }
  } catch (error) {
    console.log(`policy: ${error.message}`);
    return 2;
  }
  console.log('usage: policy.mjs protected|check|checks [--rules <dir>]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
