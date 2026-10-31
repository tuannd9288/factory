// The forms a session could type to run `factory login` or `factory store` (#177), and some that it may run: the deny tests of
// every role (seat-login-deny.test.mjs) and of the Lead (packs/pstack/test/lead.test.mjs) check the same lists.
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const bin = join(factory, 'bin/factory');

export const FORMS = [
  'factory login ann', 'factory login ann --no-setup', 'bin/factory login ann', './bin/factory login ann', '~/.local/bin/factory login ann',
  `${bin} login ann`, '/Users/factory/WORKSPACES/bin/factory login ann --no-setup', 'cd ~/WORKSPACES && bin/factory login ann',
  'factory store ann', 'bin/factory store ann', './bin/factory store ann', `${bin} store ann`, 'echo x | factory store ann',
  // the library behind bin/factory, which a `node` grant would otherwise run
  'node bin/lib/factory.mjs login ann', `node ${join(factory, 'bin/lib/factory.mjs')} store ann`,
  // #178: the Human alone moves a row to another account and removes an account
  'factory use 2 b', 'factory use', 'bin/factory use 2 b', './bin/factory use 3 a', '~/.local/bin/factory use 1 a', `${bin} use 2 b`,
  'cd ~/WORKSPACES && bin/factory use 1 a', 'echo b | factory use 2',
  'factory logout ann', 'bin/factory logout ann', './bin/factory logout ann', '~/.local/bin/factory logout ann', `${bin} logout ann`,
  '/Users/factory/WORKSPACES/bin/factory logout ann', 'cd ~/WORKSPACES && bin/factory logout ann',
  'node bin/lib/factory.mjs use 2 b', `node ${join(factory, 'bin/lib/factory.mjs')} logout ann`,
];

export const HARMLESS = ['factory', 'factory --json', 'bin/factory --all', `${bin} --json`, 'node bin/lib/factory.mjs --json', 'ls -la bin'];
