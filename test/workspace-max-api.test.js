// Exercise the same real HTTP commands with MAX signing and separate identities.
// This does not publish to MAX or start polling.
process.env.WORKSPACE_TEST_PLATFORM = 'max';
await import('./workspace-api.test.js');
