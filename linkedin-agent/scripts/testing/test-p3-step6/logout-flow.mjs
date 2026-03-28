// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 6 Group 4: Logout Flow
// Verifies GET /auth/logout clears the session cookie and
// redirects to Auth0's logout endpoint.
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { SESSION_COOKIE_NAME } from '../../../src/auth/session.js';

var BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
var TIMEOUT = { signal: AbortSignal.timeout(10000) };

console.log('  File: test-p3-step6/logout-flow.mjs');
group('Group 4: Logout clears session and redirects', `
  Impact: If these tests fail, clicking "Logout" does not actually
  end the session. The cookie remains valid, and on a shared
  device, the next person has full access to the dashboard.
  The redirect to Auth0's logout endpoint is also required to
  invalidate the Auth0 session — without it, clicking "Log In"
  immediately re-authenticates without a password prompt.

  Route under test: GET /auth/logout
  Expected: Clear session cookie, 302 redirect to Auth0 logout
`);

var before4 = getCounters();

await testAsync('3.6.4.1', ' Logout route returns a redirect', async () => {
  console.log('  Sending GET /auth/logout with redirect:manual');
  console.log('  The route must return 302, not 200');
  console.log('  Checking: response status is 302');
  var res = await fetch(BASE + '/auth/logout', { ...TIMEOUT, redirect: 'manual' });
  check('Logout returns 302', res.status === 302, '302', String(res.status));
});

await testAsync('3.6.4.2', ' Logout redirects to Auth0 logout endpoint', async () => {
  console.log('  The Location header should point to Auth0 /v2/logout');
  console.log('  This tells Auth0 to clear its own session for this user');
  console.log('  Without this, the next login attempt skips the password prompt');
  console.log('  Checking: Location contains /v2/logout or /logout');
  var res = await fetch(BASE + '/auth/logout', { ...TIMEOUT, redirect: 'manual' });
  var location = res.headers?.get('location') || '';
  var hasLogout = location.includes('/v2/logout') || location.includes('/logout');
  check('Redirects to Auth0 logout', hasLogout, 'contains /logout', location.substring(0, 80) || 'missing');
});

await testAsync('3.6.4.3', ' Logout redirect includes returnTo parameter', async () => {
  console.log('  After Auth0 clears its session, it redirects back to our app');
  console.log('  The returnTo parameter tells Auth0 where to send the user');
  console.log('  Checking: Location URL contains returnTo= or client_id=');
  var res = await fetch(BASE + '/auth/logout', { ...TIMEOUT, redirect: 'manual' });
  var location = res.headers?.get('location') || '';
  var hasReturn = location.includes('returnTo=') || location.includes('return_to=') ||
    location.includes('post_logout_redirect_uri=');
  check('returnTo in logout redirect', hasReturn, 'present', location.substring(0, 80) || 'missing');
});

await testAsync('3.6.4.4', ' Logout sets session cookie to expire', async () => {
  console.log('  The Set-Cookie header must clear the session cookie');
  console.log('  Clearing is done by setting maxAge=0 or Expires in the past');
  console.log('  Checking: Set-Cookie header contains ' + SESSION_COOKIE_NAME + ' with Max-Age=0 or Expires');
  var res = await fetch(BASE + '/auth/logout', { ...TIMEOUT, redirect: 'manual' });
  var setCookie = res.headers?.get('set-cookie') || '';
  var clearsSession = setCookie.includes(SESSION_COOKIE_NAME) &&
    (setCookie.includes('Max-Age=0') || setCookie.includes('max-age=0') ||
     setCookie.includes('Expires=Thu, 01 Jan 1970'));
  check('Session cookie cleared', clearsSession, 'cleared', 'Set-Cookie: ' + setCookie.substring(0, 80) || 'missing');
});

await testAsync('3.6.4.5', ' Logout does not crash without active session', async () => {
  console.log('  Sending GET /auth/logout without a session cookie');
  console.log('  A user who visits /auth/logout without being logged in');
  console.log('  should still get a redirect, not a 500');
  console.log('  Checking: response status is 302 (not 500)');
  var res = await fetch(BASE + '/auth/logout', { ...TIMEOUT, redirect: 'manual' });
  check('Logout without session succeeds', res.status === 302, '302', String(res.status));
});

await testAsync('3.6.4.6', ' Logout does not include client_secret', async () => {
  console.log('  The logout redirect URL must not contain the client_secret');
  console.log('  Checking: Location header does not contain client_secret=');
  var res = await fetch(BASE + '/auth/logout', { ...TIMEOUT, redirect: 'manual' });
  var location = res.headers?.get('location') || '';
  check('No client_secret in logout URL', !location.includes('client_secret'), 'absent', 'CLIENT_SECRET IN URL');
});

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

var summary = getCounters();
process.exit(summary.fail);
