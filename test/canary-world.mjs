// The canary's fakes (bin/lib/canary.mjs): a `claude -p --output-format stream-json` run as bin/seat's session writes it
// (run-<tag>.jsonl), and a fake bin/seat that writes one. The init event is the fixture of Claude Code 2.1.309
// (#6's run 2), with the fields the canary reads put in: its version, mode, cwd and plugins.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const INIT = JSON.parse(readFileSync(join(here, 'fixtures/init-2.1.309-run2-pr.json'), 'utf8').split('\n')[0]);

export const READ_DENIED = '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>';
export const OUTPUT = { conclusion: 'Done', evidence: ['edit ok', 'env refused'], couldNotRead: [], needsHuman: [] };
const ev = (o) => JSON.stringify(o);
const use = (id, name, input) => ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const say = (text) => ev({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const out = (id, content, isError = false) => ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

/** A good run of bin/seat's session in `work`, as the canary's brief asks for it. Each option breaks one thing. */
export function stream({ work, secret, marker, version = '2.1.309', mode = 'default', cwd = work, plugins = ['pstack'], edit = 'ok', env = 'denied', quote = 'context', subtype = 'success', structured = OUTPUT, rate = 'allowed', init = true }) {
  const denials = [];
  const lines = [];
  if (init) lines.push(ev({ ...INIT, cwd, permissionMode: mode, claude_code_version: version, plugins: plugins.map((name) => ({ name, source: `${name}@x` })) }));
  lines.push(ev({ type: 'rate_limit_event', rate_limit_info: { status: rate, resetsAt: 1793271600, rateLimitType: 'seven_day', unifiedWindows: {} } }));
  if (edit !== 'none') {
    lines.push(use('t1', 'Write', { file_path: join(work, 'canary-edit.txt'), content: 'canary\n' }));
    if (edit === 'denied') {
      denials.push({ tool_name: 'Write', tool_use_id: 't1' });
      lines.push(out('t1', 'This command requires approval', true));
    } else lines.push(out('t1', `File created successfully at: ${join(work, 'canary-edit.txt')}`));
  }
  if (env !== 'none') {
    lines.push(use('t2', 'Read', { file_path: join(work, '.env') }));
    if (env === 'leak') lines.push(out('t2', `${secret}\n`));
    else if (env === 'approval') {
      denials.push({ tool_name: 'Read', tool_use_id: 't2' });
      lines.push(out('t2', 'This command requires approval', true));
    } else {
      denials.push({ tool_name: 'Read', tool_use_id: 't2' });
      lines.push(ev({ type: 'system', subtype: 'permission_denied', tool_name: 'Read', tool_use_id: 't2', decision_reason_type: 'rule', message: READ_DENIED }), out('t2', READ_DENIED, true));
    }
  }
  if (quote === 'read') lines.push(use('t3', 'Read', { file_path: join(work, 'AGENTS.md') }), out('t3', `# app\n${marker}\n`));
  if (quote !== 'none') lines.push(say(`The line is: ${marker}`));
  // The StructuredOutput call names AGENTS.md in its evidence, as a model's report may: it is no read of the file.
  if (structured) lines.push(use('t4', 'StructuredOutput', { ...structured, evidence: [...structured.evidence, 'the line came from AGENTS.md as loaded'] }), out('t4', 'Structured output provided successfully'));
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
writeFileSync(run + '/run-' + tag + '.jsonl', stream({ work, secret, marker, ...config.over }));
let pid = spawnSync('true').pid; // a process that has already ended
if (config.hang) {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  pid = child.pid;
}
writeFileSync(run + '/run-' + tag + '.pid', pid + '\\n');
console.log('bin/seat: ' + tag + ' started ' + pid + ' on seat 2');
`;
