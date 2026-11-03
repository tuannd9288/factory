// The server of the overview page (#369), run through bin/factory-page, whose header says what it serves. The page itself is built by
// page.mjs, which knows nothing of this file: handlerOf only asks for a snapshot, turns it into the view and answers.
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { snapshot as readSnapshot } from './top.mjs';
import { pageOf, viewOf } from './page.mjs';
import { job, plist } from './queue.mjs';

/** The port of the page, and of the one `tailscale serve` line. Not 443, 8765 or 18790. */
export const PORT = 9437;
export const HOST = '127.0.0.1';
export const LABEL = 'io.github.tuannd9288.factory.page';
/** The snapshot is read at most once in this long, and only when someone asks (the same minute as top.mjs's GH_MS). */
export const CACHE_MS = 60_000;

/** The request handler. Requests within CACHE_MS of the last read share its view, and requests that arrive while a read runs share that
 * read; nothing polls. `snapshot` and `now` are injected so that a test needs neither the machine nor the clock. */
export function handlerOf({ snapshot = readSnapshot, now = Date.now } = {}) {
  const cache = {}; // top.mjs's own cache of GitHub's last read, kept between snapshots
  let last = null;
  let running = null;
  const viewNow = () => {
    const t = now();
    if (last && t - last.at < CACHE_MS) return Promise.resolve(last.view);
    running ??= Promise.resolve()
      .then(() => snapshot({ cache, now: t }))
      .then((snap) => {
        last = { at: t, view: viewOf(snap) };
        return last.view;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const send = (req, res, status, type, body, extra = {}) => {
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'text/plain; charset=utf-8', 'method not allowed\n', { allow: 'GET, HEAD' });
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/' && path !== '/view.json') return send(req, res, 404, 'text/plain; charset=utf-8', 'not found\n');
    let view;
    try {
      view = await viewNow();
    } catch (error) {
      console.error(`factory-page: ${String(error?.message ?? error).split('\n')[0]}`);
      return send(req, res, 503, 'text/plain; charset=utf-8', 'could not read the factory; try again\n');
    }
    if (path === '/') return send(req, res, 200, 'text/html; charset=utf-8', pageOf(view));
    return send(req, res, 200, 'application/json; charset=utf-8', `${JSON.stringify(view)}\n`);
  };
}

/** The job as a LaunchDaemon (or agent), printed for the Human to install. Unlike the queue's it is a server: it starts at load and is kept
 * alive, with no interval. */
export function pagePlist({ env = process.env, daemon = false } = {}) {
  const text = plist(job([], env, daemon, { label: LABEL, tool: 'bin/factory-page', verb: 'serve', log: 'page.log' }));
  const timed = '  <key>StartInterval</key>\n  <integer>60</integer>\n  <key>RunAtLoad</key>\n  <true/>';
  if (!text.includes(timed)) throw new Error('the queue job changed shape; the page job no longer fits it');
  return text.replace(timed, '  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>');
}

function main(argv) {
  const [command, ...rest] = argv;
  let port = PORT;
  let daemon = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--daemon' && command === 'plist') daemon = true;
    else if (rest[i] === '--port' && command === 'serve') {
      port = Number(rest[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port needs a number from 1 to 65535');
    } else throw new Error(`unknown argument ${rest[i]}`);
  }
  if (command === 'plist') return void process.stdout.write(pagePlist({ daemon }));
  if (command !== 'serve') throw new Error('usage: factory-page serve [--port N] | plist [--daemon]');
  const server = createServer(handlerOf());
  server.on('error', (error) => {
    console.error(`factory-page: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, HOST, () => console.log(`factory-page: serving http://${HOST}:${port}/`));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`factory-page: ${String(error.message).trim()}`);
    process.exitCode = 2;
  }
}
