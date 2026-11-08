// The caller's identity and credentials reach no test scripts/verify runs, nor a child it starts. Since the agents' account
// moved to nami9288 (2026-11-08) every session sets FACTORY_AGENT, and a caller's FACTORY_AGENT or FACTORY_HUMAN met fakes that
// answer as the commands' defaults: bin/onboard refused the fake gh's agents' login, and the kit's CODEOWNERS named the caller's
// login. GH_TOKEN and GITHUB_TOKEN go with them, so no real token reaches a child. A test that needs one gives it in the
// environment of the child it starts. scripts/verify loads this file into each test file's process (`node --test --import`);
// test/helpers.mjs and test/ledger.test.mjs import it as well, so a `node --test` of a file that imports them is covered without
// the flag.
for (const name of ['FACTORY_AGENT', 'FACTORY_HUMAN', 'GH_TOKEN', 'GITHUB_TOKEN']) delete process.env[name];
