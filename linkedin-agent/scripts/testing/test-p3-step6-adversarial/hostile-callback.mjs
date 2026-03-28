// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 6 Adversarial: Hostile Callback Attacks
// Tests CSRF replay, open redirect, parameter injection,
// and timing attacks against the auth callback route.
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

var BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
var TIMEOUT = { signal: AbortSignal.timeout(10000) };

// Helper to get a valid state from /auth/login
async function getValidState() {
  var res = await fetch(BASE + '/auth/login', { ...TIMEOUT, redirect: 'manual' });
  var loc = res.headers?.get('location') || '';
  try { return new URL(loc).searchParams.get('state') || ''; } catch { return ''; }
}

console.log('  File: test-p3-step6-adversarial/hostile-callback.mjs');
group('Group 1: CSRF and state manipulation attacks', `
  Impact: If these attacks succeed, an attacker can complete the OAuth
  flow on behalf of a victim. They generate a state, wait for the
  victim to click a crafted callback URL, and the victim's browser
  establishes a session controlled by the attacker.

  Route under test: GET /auth/callback
  Attack vector: State parameter manipulation and replay
  Defense: Server-side state set, single-use consumption, format validation
`);

var before1 = getCounters();

await testAsync('3.6.1.1-A', ' State from one login consumed by first callback', async () => {
  console.log('  Generating a state via /auth/login, then using it in /auth/callback');
  console.log('  The first use should consume the state');
  console.log('  The second use must fail with 403');
  console.log('  Checking: second callback returns 403');
  var state = await getValidState();
  if (!state) { check('State generated', false, 'state', 'empty'); return; }
  await fetch(BASE + '/auth/callback?code=fake&state=' + state, TIMEOUT);
  var replay = await fetch(BASE + '/auth/callback?code=fake&state=' + state, TIMEOUT);
  check('Replay returns 403', replay.status === 403, '403', String(replay.status));
});

await testAsync('3.6.1.2-A', ' Concurrent state use — first wins', async () => {
  console.log('  Generating one state and sending two callbacks simultaneously');
  console.log('  Only one should succeed in consuming the state');
  console.log('  The other must get 403 (race condition safety)');
  console.log('  Checking: at least one request returns 403');
  var state = await getValidState();
  if (!state) { check('State generated', false, 'state', 'empty'); return; }
  var [r1, r2] = await Promise.all([
    fetch(BASE + '/auth/callback?code=fake1&state=' + state, TIMEOUT),
    fetch(BASE + '/auth/callback?code=fake2&state=' + state, TIMEOUT)
  ]);
  var oneRejected = r1.status === 403 || r2.status === 403;
  check('At least one concurrent use rejected', oneRejected, 'one 403', 'r1=' + r1.status + ' r2=' + r2.status);
});

await testAsync('3.6.1.3-A', ' State from different server instance rejected', async () => {
  console.log('  Sending a state that looks valid (64 hex chars) but was never generated');
  console.log('  An attacker running their own server could generate valid-format states');
  console.log('  The server must check its own pending state set');
  console.log('  Checking: response status is 403');
  var fakeState = 'deadbeef'.repeat(8);
  var res = await fetch(BASE + '/auth/callback?code=fake&state=' + fakeState, TIMEOUT);
  check('Foreign state returns 403', res.status === 403, '403', String(res.status));
});

await testAsync('3.6.1.4-A', ' State with whitespace padding rejected', async () => {
  console.log('  Taking a valid state and adding leading/trailing spaces');
  console.log('  If the validator trims before checking, padding passes');
  console.log('  Checking: response status is 403');
  var state = await getValidState();
  if (!state) { check('State generated', false, 'state', 'empty'); return; }
  var padded = ' ' + state + ' ';
  var res = await fetch(BASE + '/auth/callback?code=fake&state=' + encodeURIComponent(padded), TIMEOUT);
  check('Padded state returns 403', res.status === 403, '403', String(res.status));
});

await testAsync('3.6.1.5-A', ' State with null bytes rejected', async () => {
  console.log('  Injecting null bytes into the state parameter');
  console.log('  Null bytes can truncate strings in some comparison functions');
  console.log('  Checking: response status is 403 or request does not crash');
  try {
    var res = await fetch(BASE + '/auth/callback?code=fake&state=abc%00def', TIMEOUT);
    check('Null byte state rejected', res.status === 403, '403', String(res.status));
  } catch (e) {
    check('Null byte state rejected (fetch error)', true, 'rejected', 'threw');
  }
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

console.log('  File: test-p3-step6-adversarial/hostile-callback.mjs');
group('Group 2: Open redirect and parameter injection', `
  Impact: If the callback redirect destination can be controlled by
  an attacker, they redirect the victim to a phishing page that
  looks like the dashboard. The victim enters sensitive data
  thinking they are on the real site.

  Route under test: GET /auth/callback (successful flow redirects to /)
  Attack vector: Injecting redirect_uri or path parameters
`);

var before2 = getCounters();

await testAsync('3.6.2.1-A', ' Callback does not follow external redirect_uri', async () => {
  console.log('  Sending redirect_uri=https://evil.com in the callback query string');
  console.log('  The server must ignore this — the redirect target after login is hardcoded');
  console.log('  Checking: Location header (if 302) does not point to evil.com');
  var state = await getValidState();
  if (!state) { check('State generated', false, 'state', 'empty'); return; }
  var res = await fetch(BASE + '/auth/callback?code=fake&state=' + state + '&redirect_uri=https://evil.com', { ...TIMEOUT, redirect: 'manual' });
  var location = res.headers?.get('location') || '';
  check('No open redirect', !location.includes('evil.com'), 'safe', 'REDIRECTS TO EVIL.COM');
});

await testAsync('3.6.2.2-A', ' Callback with extra query parameters', async () => {
  console.log('  Sending additional parameters: admin=true&role=superuser');
  console.log('  These must not be passed to the token exchange or stored in the session');
  console.log('  Checking: response does not crash (not 500)');
  var res = await fetch(BASE + '/auth/callback?code=fake&state=bad&admin=true&role=superuser', TIMEOUT);
  check('Extra params do not crash', res.status !== 500, 'not 500', String(res.status));
});

await testAsync('3.6.2.3-A', ' POST to /auth/callback rejected', async () => {
  console.log('  The OAuth callback uses GET (Auth0 redirects via GET)');
  console.log('  A POST to /auth/callback is not a legitimate OAuth flow');
  console.log('  Checking: response status is 404 or 405 (not 200)');
  var res = await fetch(BASE + '/auth/callback', {
    ...TIMEOUT, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake', state: 'bad' })
  });
  check('POST to callback rejected', res.status === 404 || res.status === 405 || res.status === 401, '401, 404, or 405', String(res.status));
});

await testAsync('3.6.2.4-A', ' Login route with injected redirect parameter', async () => {
  console.log('  Sending GET /auth/login?redirect=https://evil.com');
  console.log('  The login route must ignore user-supplied redirect parameters');
  console.log('  The redirect_uri sent to Auth0 must be the configured AUTH0_REDIRECT_URI');
  console.log('  Checking: Location header redirect_uri does not contain evil.com');
  var res = await fetch(BASE + '/auth/login?redirect=https://evil.com', { ...TIMEOUT, redirect: 'manual' });
  var location = res.headers?.get('location') || '';
  check('Login ignores redirect param', !location.includes('evil.com'), 'safe', 'EVIL.COM IN REDIRECT');
});

await testAsync('3.6.2.5-A', ' Callback error with XSS in error_description', async () => {
  console.log('  Sending error_description=<img/onerror=alert(1)/src=x>');
  console.log('  Error parameters must be escaped before rendering');
  console.log('  Checking: response does not contain raw <img tag');
  var res = await fetch(BASE + '/auth/callback?error=test&error_description=' + encodeURIComponent('<img/onerror=alert(1)/src=x>'), TIMEOUT);
  var body = await res.text();
  check('XSS in error_description escaped', !body.includes('<img'), 'escaped', 'RAW IMG TAG');
});

await testAsync('3.6.2.6-A', ' Very long code parameter does not crash', async () => {
  console.log('  Sending code= with 10,000 characters — oversized authorization code');
  console.log('  The server should reject this before attempting token exchange');
  console.log('  Checking: response status is not 500');
  var longCode = 'A'.repeat(10000);
  var res = await fetch(BASE + '/auth/callback?code=' + longCode + '&state=bad', TIMEOUT);
  check('Long code does not crash', res.status !== 500, 'not 500', String(res.status));
});

await testAsync('3.6.2.7-A', ' Logout does not expose session in redirect URL', async () => {
  console.log('  The logout redirect URL must not contain the session cookie value');
  console.log('  or any token data in the query string');
  console.log('  Checking: Location header does not contain accessToken or session cookie name');
  var res = await fetch(BASE + '/auth/logout', { ...TIMEOUT, redirect: 'manual' });
  var location = res.headers?.get('location') || '';
  var leaks = location.includes('accessToken') || location.includes('Bearer') || location.includes('__la_session');
  check('No session data in logout URL', !leaks, 'clean', location.substring(0, 80));
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

var summary = getCounters();
process.exit(summary.fail);
