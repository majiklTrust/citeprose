// ═══════════════════════════════════════════════════════════════
// Step 1 Groups 5-7: Enforcement & Configuration
// Production enforcement + shutdown + env var gating
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { initRegistry, getProviders, isAuthEnabled, isAuthRequired,
         shutdownRegistry, _resetForTesting } from '../../../src/auth/index.js';

// ── Group 5: Production mode enforcement ─────────────────────

group('Group 5: Production mode enforcement', `
  If these tests fail, the application could deploy to production
  with no authentication. Every API endpoint and all customer
  data would be publicly accessible.
`);

var before5 = getCounters();

await testAsync('3.1.5.1', '', async () => {
  console.log('  Setting NODE_ENV=production, clearing all provider env vars');
  console.log('  Calling initRegistry() — this MUST throw, not succeed silently');
  _resetForTesting();
  process.env.NODE_ENV = 'production';
  delete process.env.MOCK_AUTH_ENABLED;
  var threw = false;
  var errMsg = '';
  try { await initRegistry(() => {}); }
  catch (e) { threw = true; errMsg = e.message; }
  check('Server refuses to start without auth in production',
    threw, 'initRegistry() throws', 'initRegistry() succeeded silently');
});

await testAsync('3.1.5.2', '', async () => {
  console.log('  The error message should tell the operator exactly what to configure');
  _resetForTesting();
  process.env.NODE_ENV = 'production';
  delete process.env.MOCK_AUTH_ENABLED;
  var errMsg = '';
  try { await initRegistry(() => {}); }
  catch (e) { errMsg = e.message; }
  check('Error message names the problem',
    errMsg.includes('No auth providers configured'), 'mentions missing providers', errMsg.substring(0, 60));
});

await testAsync('3.1.5.3', '', async () => {
  console.log('  The error should mention specific env vars so the fix is obvious');
  _resetForTesting();
  process.env.NODE_ENV = 'production';
  delete process.env.MOCK_AUTH_ENABLED;
  var errMsg = '';
  try { await initRegistry(() => {}); }
  catch (e) { errMsg = e.message; }
  check('Error tells operator what env vars to set',
    errMsg.includes('AUTH0_DOMAIN') || errMsg.includes('WORKOS_API_KEY'),
    'mentions AUTH0_DOMAIN or WORKOS_API_KEY', errMsg.substring(0, 60));
});

test('3.1.5.4', '', () => {
  console.log('  isAuthRequired() reflects the NODE_ENV policy');
  check('Registry knows auth is mandatory',
    isAuthRequired(), 'true', String(isAuthRequired()));
});

await testAsync('3.1.5.5', '', async () => {
  console.log('  Setting MOCK_AUTH_ENABLED=true in production');
  console.log('  Mock returns false from isConfigured() in production');
  console.log('  Production still has zero providers — startup must fail');
  _resetForTesting();
  process.env.NODE_ENV = 'production';
  process.env.MOCK_AUTH_ENABLED = 'true';
  var threw = false;
  try { await initRegistry(() => {}); }
  catch { threw = true; }
  check('Mock provider refuses to load in production',
    threw, 'mock blocks itself → startup fails', 'mock loaded in production');
});

delete process.env.NODE_ENV;
delete process.env.MOCK_AUTH_ENABLED;

var after5 = getCounters();
groupEnd(after5.pass - before5.pass, after5.fail - before5.fail);

// ── Group 6: Shutdown and reset ──────────────────────────────

group('Group 6: Shutdown and reset', `
  If these tests fail, the server cannot restart cleanly.
  Stale auth state persists across restarts, causing lockouts
  or incorrect access grants.
`);

var before6 = getCounters();

_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});

test('3.1.6.1', '', () => {
  console.log('  Confirming mock provider is loaded before we test shutdown');
  check('Provider loaded before shutdown',
    getProviders().length === 1, '1 provider', getProviders().length + ' providers');
});

await testAsync('3.1.6.2', '', async () => {
  console.log('  Calling shutdownRegistry() — should clear all providers');
  console.log('  After shutdown, no provider should be active and no keys cached');
  await shutdownRegistry(() => {});
  check('All providers cleared',
    getProviders().length === 0, '0 providers', getProviders().length + ' providers');
});

test('3.1.6.3', '', () => {
  console.log('  isAuthEnabled() should now be false');
  check('Auth disabled after shutdown',
    isAuthEnabled() === false, 'false', String(isAuthEnabled()));
});

await testAsync('3.1.6.4', '', async () => {
  console.log('  Calling initRegistry() again after shutdown');
  console.log('  The registry should re-discover and reload providers');
  var r = await initRegistry(() => {});
  check('Registry re-initializes after shutdown',
    r.authEnabled === true, 'true', String(r.authEnabled));
});

test('3.1.6.5', '', () => {
  console.log('  Provider should be available again after re-init');
  check('Provider reloaded after re-init',
    getProviders().length === 1, '1 provider', getProviders().length + ' providers');
});

await testAsync('3.1.6.6', '', async () => {
  console.log('  Calling initRegistry() a second time without shutdown');
  console.log('  Should return cached result — not re-scan the directory');
  var r1 = await initRegistry(() => {});
  var r2 = await initRegistry(() => {});
  check('Double init returns cached result',
    r1.providers === r2.providers, 'same Map reference', 'different reference');
});

var after6 = getCounters();
groupEnd(after6.pass - before6.pass, after6.fail - before6.fail);

// ── Group 7: Env var gating ──────────────────────────────────

group('Group 7: Env var gating', `
  If these tests fail, providers activate or deactivate
  unpredictably. A misconfigured deployment could silently
  run without auth or with the wrong provider.
`);

var before7 = getCounters();

await testAsync('3.1.7.1', '', async () => {
  console.log('  mock.js exists in providers/ but MOCK_AUTH_ENABLED is not set');
  console.log('  The file should be discovered but reported as inactive');
  _resetForTesting();
  delete process.env.MOCK_AUTH_ENABLED;
  var r1 = await initRegistry(() => {});
  check('Provider file stays inactive without env var',
    !isAuthEnabled(), 'auth disabled', 'auth enabled');
});

await testAsync('3.1.7.2', '', async () => {
  console.log('  Checking the discovery result status for mock.js');
  _resetForTesting();
  delete process.env.MOCK_AUTH_ENABLED;
  var r1 = await initRegistry(() => {});
  check('Discovery reports provider as inactive',
    r1.results[0]?.status === 'inactive', 'inactive', String(r1.results[0]?.status));
});

await testAsync('3.1.7.3', '', async () => {
  console.log('  Setting MOCK_AUTH_ENABLED=false — explicit false should not activate');
  _resetForTesting();
  process.env.MOCK_AUTH_ENABLED = 'false';
  await initRegistry(() => {});
  check('Provider stays inactive with false',
    !isAuthEnabled(), 'auth disabled', 'auth enabled');
});

await testAsync('3.1.7.4', '', async () => {
  console.log('  Setting MOCK_AUTH_ENABLED=true — now the provider should activate');
  _resetForTesting();
  process.env.MOCK_AUTH_ENABLED = 'true';
  await initRegistry(() => {});
  check('Provider activates with true',
    isAuthEnabled(), 'auth enabled', 'auth disabled');
});

delete process.env.MOCK_AUTH_ENABLED;

var after7 = getCounters();
groupEnd(after7.pass - before7.pass, after7.fail - before7.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
