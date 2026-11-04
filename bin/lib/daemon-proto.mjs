// The daemon's wire (#399), the client half, which bin/seat and bin/factory-queue load: it imports node:net and nothing else of the factory.
// The socket is $FACTORY_STATE/daemon.sock. One JSON line asks and one answers, matched by `id` (piggery v0.10.3, internal/proto/proto.go:136-157):
//   ask:    { id, verb, ...fields }              fields are flat, as the brief of #399 gives them: { verb: 'seat-ended', run, tag, session }
//   answer: { id, ok: true, result } or { id, ok: false, error: { code, message } }
// The verbs of slice 1 are `ping` (the daemon's pid, start and head) and `seat-ended`. An unknown verb gets an error answer, never a crash.
import { createConnection } from 'node:net';
import { join } from 'node:path';

/** The longest a socket path may be: sun_path holds 104 bytes on macOS, the last for the NUL. */
export const SOCKET_MAX = 103;
export const MAX_LINE = 64 * 1024;

export const socketPath = (state) => join(state, 'daemon.sock');

/** Whether a socket can be bound at `path`: a path of 104 bytes or more cannot. */
export const fits = (path) => Buffer.byteLength(path) <= SOCKET_MAX;

let next = 0;

/** Sends one request to the socket at `path` and resolves { ok: true, result } or { ok: false, why } (why: 'no socket', 'refused', 'timed out',
 * 'path too long', 'bad answer', or the daemon's own message). It never rejects and never waits longer than `timeoutMs`. */
export function ask(path, request, { timeoutMs = 2000 } = {}) {
  if (!fits(path)) return Promise.resolve({ ok: false, why: 'path too long' });
  return new Promise((done) => {
    let over = false;
    let text = '';
    const id = `${process.pid}-${(next += 1)}`;
    const finish = (r) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      socket.destroy();
      done(r);
    };
    const socket = createConnection(path);
    const timer = setTimeout(() => finish({ ok: false, why: 'timed out' }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error', (error) => finish({ ok: false, why: error.code === 'ENOENT' ? 'no socket' : 'refused' }));
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...request, id })}\n`));
    socket.on('data', (chunk) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end < 0) return text.length > MAX_LINE ? finish({ ok: false, why: 'bad answer' }) : undefined;
      try {
        const a = JSON.parse(text.slice(0, end));
        if (a?.id !== id) return finish({ ok: false, why: 'bad answer' });
        finish(a.ok === true ? { ok: true, result: a.result } : { ok: false, why: String(a.error?.message ?? 'refused') });
      } catch {
        finish({ ok: false, why: 'bad answer' });
      }
    });
    socket.on('close', () => finish({ ok: false, why: 'bad answer' }));
  });
}
