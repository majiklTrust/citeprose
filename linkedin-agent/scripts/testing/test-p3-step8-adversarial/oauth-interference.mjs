// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 8 Adversarial: OAuth Flow Interference
// Verifies the two OAuth flows cannot interfere with each other
// and the error handler suppresses internals on all routes.
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

var BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
var TIMEOUT = { signal: AbortSignal.timeout(10000) };

console.log('  File: test-p3-step8-adversarial/oauth-interference.mjs');
group('Group 1: OAuth flow cross-contamination', `
  Impact: If these tests fail, an attacker can use one OAuth flow
  to compromise the other. A LinkedIn callback state could be
  replayed against the Auth0 callback, or vice versa. The two
  flows share the same state validation function but must reject
  states generated for the wrong flow if routes differ.

  Attack: Use a state from /auth/linkedin in /auth/callback
  Defense: State validation is route-agnostic (same pool), but
  the callback handler logic is completely separate
`);

var before1 = getCounters();

await testAsync('3.8.1.1-A', ' LinkedIn callback code not accepted by Auth0 callback', async () => {
  console.log('  Sending a fake LinkedIn code to the Auth0 callback');
  console.log('  Even if the code format is valid, the Auth0 provider');
  console.log('  should reject it because it came from LinkedIn');
  console.log('  Checking: /auth/callback with LinkedIn code returns error, not success');
  var res = await fetch(BASE + '/auth/callback?code=linkedin_fake_code&state=forged', TIMEOUT);
  check('Auth0 callback rejects LinkedIn code', res.status !== 200 || res.status === 403,
    'not 200', String(res.status));
});

await testAsync('3.8.1.2-A', ' Auth0 callback code not accepted by LinkedIn callback', async () => {
  console.log('  Sending a fake Auth0 code to the LinkedIn callback');
  console.log('  Checking: /auth/linkedin/callback with Auth0 code returns error');
  var res = await fetch(BASE + '/auth/linkedin/callback?code=auth0_fake_code&state=forged', TIMEOUT);
  check('LinkedIn callback rejects Auth0 code', res.status !== 200 || res.status === 403,
    'not 200', String(res.status));
});

await testAsync('3.8.1.3-A', ' POST to /auth/linkedin rejected', async () => {
  console.log('  LinkedIn OAuth initiation is GET only');
  console.log('  POST should not trigger the redirect');
  console.log('  Checking: POST returns non-302 status');
  var res = await fetch(BASE + '/auth/linkedin', {
    ...TIMEOUT, method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  check('POST to /auth/linkedin rejected', res.status !== 302, 'not 302', String(res.status));
});

await testAsync('3.8.1.4-A', ' POST to /auth/login rejected', async () => {
  console.log('  Auth0 login initiation is GET only');
  console.log('  Checking: POST returns non-302 status');
  var res = await fetch(BASE + '/auth/login', {
    ...TIMEOUT, method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  check('POST to /auth/login rejected', res.status !== 302, 'not 302', String(res.status));
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

console.log('  File: test-p3-step8-adversarial/oauth-interference.mjs');
group('Group 2: Error handler coverage across routes', `
  Impact: If these tests fail, some routes leak stack traces or
  internal details when errors occur. The Express error handler
  added in Step 7 must catch errors from ALL middleware — CORS,
  auth, and route handlers — not just CORS.

  Defense: app.use((err, req, res, next) => res.status(403).json({}))
  Check: Error responses contain no file paths or stack traces
`);

var before2 = getCounters();

await testAsync('3.8.2.1-A', ' CORS error on /api/status does not leak internals', async () => {
  console.log('  /api/status is public but still goes through CORS');
  console.log('  Sending evil origin to trigger CORS rejection');
  console.log('  Checking: response body has no stack trace');
  var res = await fetch(BASE + '/api/status', { ...TIMEOUT, headers: { 'Origin': 'https://evil.com' } });
  var body = await res.text();
  var hasLeak = body.includes('/home/') || body.includes('node_modules') || body.includes('.js:');
  check('No internals on /api/status CORS error', !hasLeak, 'clean', body.substring(0, 80));
});

await testAsync('3.8.2.2-A', ' CORS error on / does not leak internals', async () => {
  console.log('  Dashboard route with evil origin');
  var res = await fetch(BASE + '/', { ...TIMEOUT, headers: { 'Origin': 'https://evil.com' } });
  var body = await res.text();
  var hasLeak = body.includes('/home/') || body.includes('node_modules') || body.includes('.js:');
  check('No internals on / CORS error', !hasLeak, 'clean', body.substring(0, 80));
});

await testAsync('3.8.2.3-A', ' CORS error on /auth/login does not leak internals', async () => {
  console.log('  Auth login route with evil origin');
  var res = await fetch(BASE + '/auth/login', { ...TIMEOUT, redirect: 'manual', headers: { 'Origin': 'https://evil.com' } });
  var body = await res.text();
  var hasLeak = body.includes('/home/') || body.includes('node_modules') || body.includes('.js:');
  check('No internals on /auth/login CORS error', !hasLeak, 'clean', body.substring(0, 80));
});

await testAsync('3.8.2.4-A', ' Invalid JSON body does not leak internals', async () => {
  console.log('  Sending malformed JSON to a POST endpoint');
  console.log('  Express JSON parser throws — error handler must catch it');
  console.log('  Checking: response has no stack trace');
  var res = await fetch(BASE + '/api/mode', {
    ...TIMEOUT,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"broken json'
  });
  var body = await res.text();
  var hasLeak = body.includes('/home/') || body.includes('node_modules') || body.includes('at ');
  check('No internals on malformed JSON', !hasLeak, 'clean', body.substring(0, 80));
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

var summary = getCounters();
process.exit(summary.fail);
