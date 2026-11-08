// The caller's identity and credentials reach no test scripts/verify runs, nor a child it starts. Since the agents' account
// moved to nami9288 (2026-11-08) every session sets FACTORY_AGENT, and a caller's FACTORY_AGENT or FACTORY_HUMAN met fakes that
// answer as the commands' defaults: bin/onboard refused the fake gh's agents' login, and the kit's CODEOWNERS named the caller's
// login. GH_TOKEN and GITHUB_TOKEN go with them, so no real token reaches a child. A test that needs one gives it in the
// environment of the child it starts. scripts/verify unsets the four for its whole run; test/helpers.mjs and test/ledger.test.mjs
// import this file as well, so a `node --test` of a file that imports them is covered without scripts/verify. A preload
// (`node --test --import`) would also run in a test's worker threads and forks and drop a token a test gives one.
for (const name of ['FACTORY_AGENT', 'FACTORY_HUMAN', 'GH_TOKEN', 'GITHUB_TOKEN']) delete process.env[name];
