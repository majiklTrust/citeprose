// ═══════════════════════════════════════════════════════════════
// Step 2 Groups 7, 8: Auth0 Integration
// Multi-provider coexistence + shutdown/cleanup
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { _resetForTesting, initRegistry, getProviders, getProvider,
         getDefaultProvider } from '../../../src/auth/index.js';
import auth0 from '../../../src/auth/providers/auth0.js';

// ── Group 7: Multi-provider coexistence ──────────────────────

console.log('  File: test-p3-step2/auth0-integration.mjs');
group('Group 7: Multi-provider coexistence', `
  If these tests fail, adding WorkOS for enterprise SSO breaks
  Auth0 login. The platform cannot serve both individual and
  enterprise customers — blocking growth.
`);

var before7 = getCounters();

await testAsync('3.2.7.1', ' Configuring both Auth0 and mock providers simultaneously', async () => {
  console.log('  Configuring both Auth0 and mock providers simultaneously');
  _resetForTesting();
  process.env.AUTH0_DOMAIN = 'test.auth0.com'; process.env.AUTH0_CLIENT_ID = 'cid';
  process.env.AUTH0_CLIENT_SECRET = 'secret'; process.env.MOCK_AUTH_ENABLED = 'true';
  await initRegistry(() => {});
  console.log('  Auth0 priority=10, mock priority=999 — Auth0 should be default');
  check('Both providers loaded', getProviders().length === 2, '2', '' + getProviders().length);
});

test('3.2.7.2', ' Default should be Auth0 (priority 10 beats mock 999)', () => {
  console.log('  Default should be Auth0 (priority 10 beats mock 999)');
  check('Auth0 is default', getDefaultProvider()?.name === 'auth0', 'auth0', String(getDefaultProvider()?.name));
});

test('3.2.7.3', ' Mock accessible alongside Auth0', () => {
  check('Mock accessible alongside Auth0', getProvider('mock') !== null, 'non-null', String(getProvider('mock')));
});

test('3.2.7.4', ' Auth0 accessible by name', () => {
  check('Auth0 accessible by name', getProvider('auth0') !== null, 'non-null', String(getProvider('auth0')));
});

test('3.2.7.5', ' Priority order correct', () => {
  console.log('  Providers must be sorted by priority for predictable default selection');
  var providers = getProviders();
  check('Priority order correct',
    providers.length >= 2 && providers[0].priority < providers[1].priority,
    'ascending', providers.map(p => p.name + '=' + p.priority).join(', '));
});

await testAsync('3.2.7.6', ' Disabling mock — Auth0 should operate alone', async () => {
  console.log('  Disabling mock — Auth0 should operate alone');
  _resetForTesting(); delete process.env.MOCK_AUTH_ENABLED;
  await initRegistry(() => {});
  check('Auth0 alone', getProviders().length === 1 && getDefaultProvider()?.name === 'auth0',
    'only auth0', getProviders().map(p => p.name).join(', '));
});

await testAsync('3.2.7.7', ' Disabling Auth0 — mock should operate alone', async () => {
  console.log('  Disabling Auth0 — mock should operate alone');
  _resetForTesting(); delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID;
  delete process.env.AUTH0_CLIENT_SECRET; process.env.MOCK_AUTH_ENABLED = 'true';
  await initRegistry(() => {});
  check('Mock alone', getProviders().length === 1 && getDefaultProvider()?.name === 'mock',
    'only mock', getProviders().map(p => p.name).join(', '));
});

await testAsync('3.2.7.8', ' Disabling everything — zero providers', async () => {
  console.log('  Disabling everything — zero providers');
  _resetForTesting(); delete process.env.MOCK_AUTH_ENABLED;
  await initRegistry(() => {});
  check('No providers', getProviders().length === 0, '0', '' + getProviders().length);
});

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET; delete process.env.MOCK_AUTH_ENABLED;
var after7 = getCounters();
groupEnd(after7.pass - before7.pass, after7.fail - before7.fail);

// ── Group 8: Shutdown and cleanup ────────────────────────────

console.log('  File: test-p3-step2/auth0-integration.mjs');
group('Group 8: Shutdown and cleanup', `
  If these tests fail, stale CSRF states and cached keys persist
  after restart. Expired states could be replayed and rotated
  signing keys never picked up.
`);

var before8 = getCounters();
process.env.AUTH0_DOMAIN = 'test.auth0.com'; process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'secret';

await testAsync('3.2.8.1', '  auth0.init() to establish provider state', async () => {
  console.log('  Calling auth0.init() to establish provider state');
  await auth0.init();
  check('Provider initialized', auth0._isInitialized(), 'true', String(auth0._isInitialized()));
});

test('3.2.8.2', ' Generating 2 CSRF states to populate the state map', () => {
  console.log('  Generating 2 CSRF states to populate the state map');
  auth0._generateState(); auth0._generateState();
  check('CSRF states exist', auth0._getStateCount() >= 2, '≥2', auth0._getStateCount() + ' states');
});

await testAsync('3.2.8.3', '  auth0.shutdown() — must clear all state', async () => {
  console.log('  Calling auth0.shutdown() — must clear all state');
  await auth0.shutdown();
  check('Not initialized after shutdown', !auth0._isInitialized(), 'false', String(auth0._isInitialized()));
});

test('3.2.8.4', ' All CSRF states cleared', () => {
  console.log('  CSRF state map should be empty — prevents replay of old states');
  check('All CSRF states cleared', auth0._getStateCount() === 0, '0', auth0._getStateCount() + ' states');
});

test('3.2.8.5', ' Discovery cache cleared', () => {
  console.log('  Discovery cache should be null — forces fresh key fetch on restart');
  check('Discovery cache cleared', auth0._getDiscoveryCache() === null, 'null', String(auth0._getDiscoveryCache()));
});

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
var after8 = getCounters();
groupEnd(after8.pass - before8.pass, after8.fail - before8.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
