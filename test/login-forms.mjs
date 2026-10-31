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
];

export const HARMLESS = ['factory', 'factory --json', 'bin/factory --all', `${bin} --json`, 'node bin/lib/factory.mjs --json', 'ls -la bin'];
