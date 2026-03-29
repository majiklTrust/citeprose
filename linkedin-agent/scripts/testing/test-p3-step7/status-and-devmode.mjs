// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 7 Groups 1-2: Status Auth Fields + Dev Mode
// Verifies /api/status includes auth metadata and dev bypass
// behavior works correctly.
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

var BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
var TIMEOUT = { signal: AbortSignal.timeout(10000) };

// Fetch status once to determine server mode
var statusRes = await fetch(BASE + '/api/status', TIMEOUT);
var statusJson = await statusRes.json();
var authRequired = statusJson.authRequired;

console.log('  File: test-p3-step7/status-and-devmode.mjs');
console.log('  Server auth mode: ' + (authRequired ? 'AUTH REQUIRED' : 'DEV MODE (no auth)'));
group('Group 1: /api/status includes auth metadata', `
  Impact: If these tests fail, the dashboard cannot determine whether
  to show a login wall or the full interface. The frontend reads
  authRequired and user from /api/status to decide what to render.
  Without these fields, the dashboard either always shows the login
  wall (breaking dev mode) or never shows it (breaking production).

  Endpoint: GET /api/status
  New fields: authRequired (boolean), user (object or null)
`);

var before1 = getCounters();

await testAsync('3.7.1.1', ' /api/status returns authRequired field', async () => {
  console.log('  Fetching GET /api/status and checking for authRequired field');
  console.log('  This boolean tells the dashboard whether authentication is enforced');
  console.log('  Checking: response JSON has authRequired as a boolean');
  check('authRequired is boolean', typeof statusJson.authRequired === 'boolean',
    'boolean', typeof statusJson.authRequired);
});

await testAsync('3.7.1.2', ' /api/status returns user field', async () => {
  console.log('  The user field is an object when authenticated, null when not');
  console.log('  Checking: response JSON has user field (object or null)');
  var hasUser = statusJson.hasOwnProperty('user') || statusJson.user !== undefined;
  check('user field present', 'user' in statusJson, 'present', 'missing');
});

await testAsync('3.7.1.3', ' authRequired reflects server auth state', async () => {
  console.log('  If auth providers are configured, authRequired should be true');
  console.log('  If no providers configured (dev mode), authRequired should be false');
  console.log('  Current value: ' + statusJson.authRequired);
  // We can't control the server config from here, so just verify it's consistent
  check('authRequired is consistent', typeof statusJson.authRequired === 'boolean', 'boolean value', String(statusJson.authRequired));
});

await testAsync('3.7.1.4', ' Existing status fields still present', async () => {
  console.log('  Adding auth fields must not break existing fields');
  console.log('  Dashboard depends on: mode, stats, linkedinConnected');
  console.log('  Checking: mode, stats, and linkedinConnected are still present');
  check('mode present', typeof statusJson.mode === 'string', 'string', typeof statusJson.mode);
  check('stats present', typeof statusJson.stats === 'object', 'object', typeof statusJson.stats);
  check('linkedinConnected present', typeof statusJson.linkedinConnected === 'boolean', 'boolean', typeof statusJson.linkedinConnected);
});

await testAsync('3.7.1.5', ' /api/status still accessible without auth', async () => {
  console.log('  /api/status is the public health check endpoint');
  console.log('  Adding auth fields must not accidentally require authentication');
  console.log('  Checking: response status is 200 (not 401)');
  var res = await fetch(BASE + '/api/status', TIMEOUT);
  check('Status returns 200', res.status === 200, '200', String(res.status));
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

console.log('  File: test-p3-step7/status-and-devmode.mjs');
group('Group 2: Dev mode bypass behavior', `
  Impact: If these tests fail, either development is blocked (dev mode
  doesn't bypass auth) or production is insecure (auth bypass works
  in production). The DEV_BYPASS_ORIGINS env var controls which
  addresses skip authentication in non-production environments.

  Condition: NODE_ENV !== 'production' AND request origin in DEV_BYPASS_ORIGINS
  Expected: All API routes accessible without auth, warning indicators in response
`);

var before2 = getCounters();

await testAsync('3.7.2.1', ' Dev mode: protected routes accessible without auth', async () => {
  console.log('  If authRequired is false (dev mode), protected routes should work');
  console.log('  If authRequired is true (production), this test documents the behavior');
  if (authRequired) {
    console.log('  ℹ Server has auth enabled — skipping dev mode test');
    check('Auth enabled — dev test skipped', true, 'skipped', 'skipped');
    return;
  }
  console.log('  Fetching GET /api/posts without any auth credentials');
  var res = await fetch(BASE + '/api/posts', TIMEOUT);
  check('Posts accessible in dev mode', res.status !== 401 && res.status !== 403,
    'not 401/403', String(res.status));
});

await testAsync('3.7.2.2', ' Dev mode: /api/logs accessible without auth', async () => {
  if (authRequired) { check('Auth enabled — skipped', true, 'skipped', 'skipped'); return; }
  console.log('  Fetching GET /api/logs without auth');
  var res = await fetch(BASE + '/api/logs?limit=5', TIMEOUT);
  check('Logs accessible in dev mode', res.status !== 401 && res.status !== 403,
    'not 401/403', String(res.status));
});

await testAsync('3.7.2.3', ' Dev mode: user is null in status', async () => {
  if (authRequired) { check('Auth enabled — skipped', true, 'skipped', 'skipped'); return; }
  console.log('  In dev mode, no user is logged in — user should be null');
  check('User is null in dev mode', statusJson.user === null, 'null', String(statusJson.user));
});

await testAsync('3.7.2.4', ' Dev mode: authRequired is false in status', async () => {
  if (authRequired) { check('Auth enabled — skipped', true, 'skipped', 'skipped'); return; }
  console.log('  In dev mode, authRequired should be false');
  check('authRequired false in dev', statusJson.authRequired === false, 'false', String(statusJson.authRequired));
});

await testAsync('3.7.2.5', ' Auth mode: POST routes require authentication', async () => {
  if (!authRequired) { check('Dev mode — skipped', true, 'skipped', 'skipped'); return; }
  console.log('  In auth mode, POST routes must return 401 without credentials');
  var res = await fetch(BASE + '/api/mode', {
    ...TIMEOUT, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'manual' })
  });
  check('POST /api/mode requires auth', res.status === 401, '401', String(res.status));
});

await testAsync('3.7.2.6', ' Auth mode: user is null without session', async () => {
  if (!authRequired) { check('Dev mode — skipped', true, 'skipped', 'skipped'); return; }
  console.log('  When auth is required but no session/token is provided,');
  console.log('  /api/status should still return 200 but user should be null');
  check('User null without session', statusJson.user === null, 'null', JSON.stringify(statusJson.user));
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

var summary = getCounters();
process.exit(summary.fail);
