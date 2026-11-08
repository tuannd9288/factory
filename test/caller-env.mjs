// The caller's identity and credentials never reach a test or a child it starts. Since the agents' account moved to nami9288
// (2026-11-08) every session sets FACTORY_AGENT, and a caller's FACTORY_AGENT or FACTORY_HUMAN met fakes that answer as the
// commands' defaults: bin/onboard refused the fake gh's agents' login, and the kit's CODEOWNERS named the caller's login. GH_TOKEN
// and GITHUB_TOKEN go with them, so no real token reaches a child. A test that needs one gives it in the environment of the child it
// starts. Imported for its effect, first, by test/helpers.mjs and by the test files that do not import it.
for (const name of ['FACTORY_AGENT', 'FACTORY_HUMAN', 'GH_TOKEN', 'GITHUB_TOKEN']) delete process.env[name];
