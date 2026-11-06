// #177: the hidden prompt of `factory account add`, driven with a stand-in for a raw-mode terminal. In raw mode the terminal sends
// Return as "\r" (ICRNL is off), and a paste may bring its own line ends. No real terminal runs here: none could be
// started without a pty tool, which the factory does not take as a dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { QUIET_MS, readSecret, tokenOf } from '../bin/lib/token.mjs';

const TOKEN = 'sk-ant-oat01-Hh4Jj8Kk2Ll6Mm0Nn3Pp7Qq1Rr5Ss9Tt';

/** The terminal: each string is a chunk the program reads, each number a pause of that many ms. A chunk that comes once the program
 * paused its input is not read: it stays in the terminal (`left`), where the shell reads it after the command exits. */
function fakeTty(...steps) {
  const tty = new EventEmitter();
  tty.isTTY = true;
  tty.raw = [];
  tty.paused = false;
  tty.left = [];
  tty.setRawMode = (on) => tty.raw.push(on);
  tty.setEncoding = () => {};
  tty.resume = () => {
    tty.sent = new Promise((done) => setImmediate(async () => {
      for (const step of steps) {
        if (typeof step === 'number') await new Promise((later) => setTimeout(later, step));
        else if (tty.paused) tty.left.push(step);
        else tty.emit('data', step);
      }
      done();
    }));
  };
  tty.pause = () => { tty.paused = true; };
  return tty;
}

const prompt = () => ({ shown: '', write(t) { this.shown += t; } });

async function typed(...steps) {
  const tty = fakeTty(...steps);
  const out = prompt();
  const text = await readSecret(tty, out);
  await tty.sent;
  return { text, tty, out, read: tokenOf(text) };
}

test('Return is Enter whichever way the terminal sends it: "\\r", "\\r\\n" or "\\n"', async () => {
  for (const keys of [`${TOKEN}\r`, `${TOKEN}\r\n`, `${TOKEN}\n`]) {
    const r = await typed(keys);
    assert.deepEqual(r.read, { token: TOKEN }, JSON.stringify(keys));
    assert.deepEqual(r.tty.raw, [true, false], 'raw mode on, then off');
    assert.ok(r.tty.paused);
  }
});

test('a token typed in pieces, with a backspace, then Return', async () => {
  const r = await typed('sk-ant-', 'oat01-Hh4Jj', 'XX\u007f\u007f', '8Kk2Ll6Mm0Nn3Pp7Qq1Rr5Ss9Tt', '\r');
  assert.deepEqual(r.read, { token: TOKEN });
});

test('the prompt shows nothing of what is typed', async () => {
  const r = await typed(`${TOKEN}\r`);
  assert.ok(!r.out.shown.includes(TOKEN.slice(0, 8)), r.out.shown);
});

test('a token pasted from a wrapped line is read whole, also when a line break ends a chunk, and nothing is left for the shell (#366)', async () => {
  const [a, b, c] = [TOKEN.slice(0, 17), TOKEN.slice(17, 33), TOKEN.slice(33)];
  for (const steps of [
    [`${a}\r${b}\r${c}\r`],
    [`  ${a}\r\n  ${b}\r\n  ${c}\r\n`],
    [`${a}\n`, 20, `${b}\n`, 20, `${c}\n`],
    // A terminal with bracketed paste: the paste ends at its end marker however long its chunks take, and a marker may be split.
    ['\x1b[200~', `${a}\n`, QUIET_MS + 100, `${b}\n${c}\x1b[20`, '1~', 20, '\r'],
    [`\x1b[200~${a}\n${b}\n${c}\n\x1b[201~`],
  ]) {
    const r = await typed(...steps);
    assert.deepEqual(r.read, { token: TOKEN }, JSON.stringify(steps));
    assert.deepEqual(r.tty.left, [], JSON.stringify(steps));
    assert.deepEqual(r.tty.raw, [true, false], 'raw mode on, then off');
  }
});

test('an empty Return is refused as empty', async () => {
  for (const keys of ['\r', '\n', ' \t\r']) assert.match((await typed(keys)).read.error, /empty/, JSON.stringify(keys));
});

test('Ctrl-C ends the prompt, puts the terminal back and gives no text', async () => {
  for (const steps of [['sk-ant-oat01-partial', '\u0003'], ['\x1b[200~sk-ant-oat01-partial', '\u0003']]) {
    const tty = fakeTty(...steps);
    const out = prompt();
    await assert.rejects(readSecret(tty, out), /interrupted/);
    assert.deepEqual(tty.raw, [true, false]);
    assert.ok(tty.paused);
    assert.ok(out.shown.lastIndexOf('\x1b[?2004l') > out.shown.lastIndexOf('\x1b[?2004h'), 'bracketed paste is off again');
  }
});

test('tokenOf takes every whitespace character out, so a wrapped token comes back whole; only one with nothing else is refused (#366)', () => {
  for (const text of [`${TOKEN}\r`, `${TOKEN}\r\n`, ` \t${TOKEN}  \n`, TOKEN, `\n${TOKEN}\n\n`, `${TOKEN.slice(0, 20)}\r\n  ${TOKEN.slice(20)}\n`, `${TOKEN.slice(0, 9)} ${TOKEN.slice(9, 30)}\t${TOKEN.slice(30)}`]) {
    assert.deepEqual(tokenOf(text), { token: TOKEN }, JSON.stringify(text));
  }
  for (const text of ['', '\n', '\r', ' \t \n', '\n\n']) assert.ok(tokenOf(text).error, JSON.stringify(text));
});
