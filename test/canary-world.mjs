// The canary's fakes (bin/lib/canary.mjs): a `claude -p --output-format stream-json` run as bin/seat's session writes it
// (run-<tag>.jsonl), and a fake bin/seat that writes one. The init event is the fixture of Claude Code 2.1.309
// (#6's run 2), with the fields the canary reads put in: its version, mode, cwd and plugins. The refusals use the wording
// of real 2.1.308 runs (fixtures/seat-denials-2.1.308.json, which names the log lines).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const INIT = JSON.parse(readFileSync(join(here, 'fixtures/init-2.1.309-run2-pr.json'), 'utf8').split('\n')[0]);

// The wording the Read tool had under acceptEdits in a live probe run (probes/results.md:190).
export const READ_DENIED = '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>';
export const NODE_CMD = 'node -e "process.stdout.write(String(Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)))"';
export const OUTPUT = { conclusion: 'Done', evidence: ['edit ok', 'env refused'], couldNotRead: [], needsHuman: [] };
/** What Claude Code 2.1.308 says when a rule refuses a Bash command, and a Read (the words of a refused Grep). */
export const bashDenied = (command) => `Permission to use Bash with command ${command} has been denied.`;
export const readDenied = (path) => `Permission to read ${path} has been denied.`;
const ev = (o) => JSON.stringify(o);
const use = (id, name, input) => ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const say = (text) => ev({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const out = (id, content, isError = false) => ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

/** A good run of bin/seat's session in `work`, as the canary's brief asks for it. Each option breaks one thing. */
export function stream({ work, secret, marker, candidate = '2.1.309', attempt = 1, version = candidate, mode = 'default', cwd = work, plugins = ['pstack'], git = 'ok', tag = 'denied', node = 'false', gh = 'denied', edit = 'ok', env = 'denied', quote = 'context', subtype = 'success', structured = OUTPUT, rate = 'allowed', init = true }) {
  const denials = [];
  const lines = [];
  // A refused call: the permission_denied event, the error result, and the entry of the result's permission_denials.
  const refuse = (id, name, input, text) => {
    denials.push({ tool_name: name, tool_use_id: id, tool_input: input });
    lines.push(use(id, name, input), ev({ type: 'system', subtype: 'permission_denied', tool_name: name, tool_use_id: id, decision_reason_type: 'subcommandResults', message: text }), out(id, text, true));
  };
  const approval = (id, name, input) => {
    denials.push({ tool_name: name, tool_use_id: id, tool_input: input });
    lines.push(use(id, name, input), out(id, 'This command requires approval', true));
  };
  if (init) lines.push(ev({ ...INIT, cwd, permissionMode: mode, claude_code_version: version, plugins: plugins.map((name) => ({ name, source: `${name}@x` })) }));
  lines.push(ev({ type: 'rate_limit_event', rate_limit_info: { status: rate, resetsAt: 1793271600, rateLimitType: 'seven_day', unifiedWindows: {} } }));

  const bash = (id, command) => ({ id, input: { command } });
  if (git !== 'none') {
    const c = bash('b1', 'git branch --show-current');
    if (git === 'approval') approval(c.id, 'Bash', c.input);
    else lines.push(use(c.id, 'Bash', c.input), out(c.id, 'main\n'));
  }
  if (tag !== 'none') {
    const c = bash('b2', `git tag canary-${candidate}-${attempt}`);
    if (tag === 'denied') refuse(c.id, 'Bash', c.input, bashDenied(c.input.command));
    else if (tag === 'approval') approval(c.id, 'Bash', c.input);
    else if (tag === 'wrong') refuse(c.id, 'Bash', c.input, bashDenied('git push origin main'));
    else lines.push(use(c.id, 'Bash', c.input), out(c.id, ''));
  }
  if (node !== 'none') {
    const c = bash('b3', NODE_CMD);
    if (node === 'approval') approval(c.id, 'Bash', c.input);
    else if (node === 'other') lines.push(use(c.id, 'Bash', { command: 'node -e 0' }), out(c.id, 'false'));
    else lines.push(use(c.id, 'Bash', c.input), out(c.id, node));
  }
  if (gh !== 'none') {
    const c = bash('b4', 'gh --version');
    if (gh === 'denied') refuse(c.id, 'Bash', c.input, bashDenied(c.input.command));
    else if (gh === 'approval') approval(c.id, 'Bash', c.input);
    else lines.push(use(c.id, 'Bash', c.input), out(c.id, 'gh version 2.0.0\n'));
  }
  if (edit !== 'none') {
    const file = join(work, `canary-edit-${attempt}.txt`);
    const input = { file_path: file, content: 'canary\n' };
    if (edit === 'denied') approval('t1', 'Write', input);
    else lines.push(use('t1', 'Write', input), out('t1', `File created successfully at: ${file}`));
  }
  if (env !== 'none') {
    const input = { file_path: join(work, '.env') };
    if (env === 'leak') lines.push(use('t2', 'Read', input), out('t2', `${secret}\n`));
    else if (env === 'approval') approval('t2', 'Read', input);
    else if (env === 'deniedOld') {
      denials.push({ tool_name: 'Read', tool_use_id: 't2', tool_input: input });
      lines.push(use('t2', 'Read', input), ev({ type: 'system', subtype: 'permission_denied', tool_name: 'Read', tool_use_id: 't2', decision_reason_type: 'rule', message: READ_DENIED }), out('t2', READ_DENIED, true));
    } else refuse('t2', 'Read', input, readDenied(input.file_path));
  }
  if (quote === 'read') lines.push(use('t3', 'Read', { file_path: join(work, 'AGENTS.md') }), out('t3', `# app\n${marker}\n`));
  if (quote !== 'none') lines.push(say(`The line is: ${marker}`));
  // The StructuredOutput call names AGENTS.md in its evidence, as a model's report may: it is no read of the file.
  const listed = Array.isArray(structured?.evidence) ? [...structured.evidence, 'the line came from AGENTS.md as loaded'] : structured?.evidence;
  if (structured) lines.push(use('t4', 'StructuredOutput', { ...structured, evidence: listed }), out('t4', 'Structured output provided successfully'));
  lines.push(ev({ type: 'result', subtype, is_error: false, permission_denials: denials, num_turns: 6, result: '', ...(structured ? { structured_output: structured } : {}) }));
  return `${lines.join('\n')}\n`;
}

/** The fake bin/seat, as a script. It records how it was called, then acts as $FAKE_SEAT_CONFIG says (a JSON file): `refuse`
 * (say "no seat free" and exit 2), `hang` (a live pid, no end), or a session whose stream carries `over`. */
export const FAKE_SEAT = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const config = JSON.parse(readFileSync(process.env.FAKE_SEAT_CONFIG, 'utf8'));
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const [run, work, tag] = [at('--run'), at('--work'), at('--tag')];
appendFileSync(config.calls, JSON.stringify({ args, path: process.env.PATH, alerts: process.env.FACTORY_NO_ALERTS, kept: existsSync(work + '/keep.txt'), brief: readFileSync(args[1], 'utf8'), shim: (spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout ?? '').trim() }) + '\\n');
if (config.refuse) {
  console.error('seat 2: 4 live sessions, at most 4\\nseat 1: rejected by Claude Code (seven-day window) until 2026-11-01 06:00 UTC\\nno seat free');
  process.exit(2);
}
const { stream } = await import(config.world);
const secret = readFileSync(work + '/.env', 'utf8').trim();
const prefix = /begins with "([^"]+)"/.exec(readFileSync(args[1], 'utf8'))[1];
const marker = readFileSync(work + '/AGENTS.md', 'utf8').split('\\n').find((l) => l.startsWith(prefix));
const attempt = Number(/brief-(\\d+)\\.md$/.exec(args[1])[1]);
writeFileSync(run + '/run-' + tag + '.jsonl', stream({ work, secret, marker, candidate: tag.replace(/^canary-/, ''), attempt, ...config.over }));
let pid = spawnSync('true').pid; // a process that has already ended
if (config.hang) {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  pid = child.pid;
}
writeFileSync(run + '/run-' + tag + '.pid', pid + '\\n');
console.log('bin/seat: ' + tag + ' started ' + pid + ' on seat 2');
`;
