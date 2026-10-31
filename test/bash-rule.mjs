// How a Bash rule matches a command, read the way Claude Code's permissions page says it is read (see seat-rules.test.mjs): a
// rule matches the whole command text; `*` stands for any text, spaces included; a trailing ` *`, or `:*`, also matches the
// bare command.
const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function matches(rule, command) {
  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return false;
  const p = m[1].endsWith(':*') ? `${m[1].slice(0, -2)} *` : m[1];
  if (p.endsWith(' *') && p.indexOf('*') === p.length - 1 && command === p.slice(0, -2)) return true;
  return new RegExp(`^${p.split('*').map(esc).join('.*')}$`, 's').test(command);
}

/** The rules that follow a flag in a list of arguments, up to the next flag. */
export function rulesAfter(args, flag) {
  const from = args.indexOf(flag) + 1;
  let to = from;
  while (to < args.length && !args[to].startsWith('--')) to++;
  return args.slice(from, to);
}
