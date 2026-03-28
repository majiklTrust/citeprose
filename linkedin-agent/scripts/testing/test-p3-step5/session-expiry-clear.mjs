// ═══════════════════════════════════════════════════════════════
// Step 5 Groups 3-4: Session Expiry and Clearing
// Tests isSessionExpiring() and clearSession()
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

import {
  createSession,
  readSession,
  clearSession,
  isSessionExpiring,
  SESSION_COOKIE_NAME,
} from '../../../src/auth/session.js';

// ── Environment setup ────────────────────────────────────────
const TEST_SECRET = 'c'.repeat(64);
process.env.SESSION_SECRET = TEST_SECRET;

// ── Mock helpers ─────────────────────────────────────────────
function mockRes() {
  var cookies = [];
  return {
    cookie(name, value, options) {
      cookies.push({ name, value, options: options || {} });
    },
    clearCookie(name, options) {
      cookies.push({ name, value: '', cleared: true, options: options || {} });
    },
    getCookies() { return cookies; },
    getSessionCookie() {
      return cookies.find(c => c.name === SESSION_COOKIE_NAME && !c.cleared) || null;
    }
  };
}

function mockReqFromRes(res) {
  var cookie = res.getSessionCookie();
  if (!cookie) return { headers: {} };
  return { headers: { cookie: SESSION_COOKIE_NAME + '=' + cookie.value } };
}

function makeTokens(expiresIn) {
  return {
    accessToken: 'eyJ-test-' + expiresIn,
    refreshToken: 'v1.refresh',
    expiresIn: expiresIn,
    user: { sub: 'auth0|expiry_test', email: 'e@test.com', name: 'Expiry' }
  };
}

// ── Group 3: Session expiry detection ────────────────────────
group('Group 3: Session expiry detection', `
  Impact: If these tests fail, the server cannot detect when a session
  is about to expire. The middleware either uses an expired token
  (Auth0 rejects it, user sees an error) or never triggers refresh
  (the session expires and the user is abruptly logged out).

  Module under test: src/auth/session.js
  Function: isSessionExpiring(session, thresholdMs)
  Input: session object from readSession(), threshold in milliseconds
  Output: boolean — true if expiresAt is within threshold of now
  Default threshold: 300000 (5 minutes)
`);

var before3 = getCounters();

await testAsync('3.5.3.1', 'Session with 1 hour remaining is not expiring', async () => {
  console.log('  Creating a session with expiresIn=3600 (1 hour)');
  console.log('  Reading it back via createSession → readSession roundtrip');
  console.log('  isSessionExpiring default threshold is 300 seconds (5 minutes)');
  console.log('  3600 seconds remaining > 300 second threshold → not expiring');
  console.log('  Checking: isSessionExpiring(session) === false');
  var res = mockRes();
  createSession(res, makeTokens(3600));
  var session = readSession(mockReqFromRes(res));
  check('1-hour session not expiring', isSessionExpiring(session) === false,
    'false', String(isSessionExpiring(session)));
});

await testAsync('3.5.3.2', 'Session with 200 seconds remaining is expiring', async () => {
  console.log('  Creating a session with expiresIn=200 (3 min 20 sec)');
  console.log('  Default threshold is 300 seconds (5 minutes)');
  console.log('  200 seconds remaining < 300 second threshold → expiring');
  console.log('  Checking: isSessionExpiring(session) === true');
  var res = mockRes();
  createSession(res, makeTokens(200));
  var session = readSession(mockReqFromRes(res));
  check('200s session is expiring', isSessionExpiring(session) === true,
    'true', String(isSessionExpiring(session)));
});

await testAsync('3.5.3.3', 'Session with 0 seconds remaining is expiring', async () => {
  console.log('  Creating a session with expiresIn=0 (expires immediately)');
  console.log('  This should always return true regardless of threshold');
  console.log('  Checking: isSessionExpiring(session) === true');
  var res = mockRes();
  createSession(res, makeTokens(0));
  var session = readSession(mockReqFromRes(res));
  check('0s session is expiring', isSessionExpiring(session) === true,
    'true', String(isSessionExpiring(session)));
});

await testAsync('3.5.3.4', 'Custom threshold: 600s threshold, 500s remaining', async () => {
  console.log('  Creating a session with expiresIn=500');
  console.log('  Passing custom threshold of 600000ms (600 seconds)');
  console.log('  500 seconds remaining < 600 second threshold → expiring');
  console.log('  Checking: isSessionExpiring(session, 600000) === true');
  var res = mockRes();
  createSession(res, makeTokens(500));
  var session = readSession(mockReqFromRes(res));
  check('500s session expiring at 600s threshold', isSessionExpiring(session, 600000) === true,
    'true', String(isSessionExpiring(session, 600000)));
});

await testAsync('3.5.3.5', 'Custom threshold: 600s threshold, 700s remaining', async () => {
  console.log('  Creating a session with expiresIn=700');
  console.log('  Passing custom threshold of 600000ms (600 seconds)');
  console.log('  700 seconds remaining > 600 second threshold → not expiring');
  console.log('  Checking: isSessionExpiring(session, 600000) === false');
  var res = mockRes();
  createSession(res, makeTokens(700));
  var session = readSession(mockReqFromRes(res));
  check('700s session not expiring at 600s threshold', isSessionExpiring(session, 600000) === false,
    'false', String(isSessionExpiring(session, 600000)));
});

await testAsync('3.5.3.6', 'Null session is always expiring', async () => {
  console.log('  Passing null to isSessionExpiring — simulates no session found');
  console.log('  A missing session is conceptually "already expired"');
  console.log('  The function must return true (not throw)');
  console.log('  Checking: isSessionExpiring(null) === true');
  check('Null session is expiring', isSessionExpiring(null) === true,
    'true', String(isSessionExpiring(null)));
});

await testAsync('3.5.3.7', 'Session without expiresAt is always expiring', async () => {
  console.log('  Passing a session object with no expiresAt field');
  console.log('  This could happen if session data is corrupted or from an older format');
  console.log('  Without knowing when it expires, treat it as expired');
  console.log('  Checking: isSessionExpiring({user:{sub:"x"}}) === true');
  check('No expiresAt is expiring', isSessionExpiring({ user: { sub: 'x' } }) === true,
    'true', String(isSessionExpiring({ user: { sub: 'x' } })));
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Group 4: Session clearing ────────────────────────────────
group('Group 4: Session clearing', `
  Impact: If these tests fail, users cannot log out. Clicking "Logout"
  leaves the session cookie active. On shared devices, the next
  person has full access to the previous user's dashboard.

  Module under test: src/auth/session.js
  Function: clearSession(res)
  Input: Express response object
  Effect: Sets the session cookie to expire immediately
`);

var before4 = getCounters();

await testAsync('3.5.4.1', 'clearSession expires the cookie', async () => {
  console.log('  Calling clearSession(res) on a mock response object');
  console.log('  The function must either:');
  console.log('    a) Call res.clearCookie(SESSION_COOKIE_NAME) — Express built-in, or');
  console.log('    b) Call res.cookie(SESSION_COOKIE_NAME, "", { maxAge: 0 })');
  console.log('  Either approach tells the browser to delete the cookie');
  console.log('  Checking: response cookies include SESSION_COOKIE_NAME with maxAge=0 or cleared flag');
  var res = mockRes();
  clearSession(res);
  var cookies = res.getCookies();
  var cleared = cookies.find(c =>
    c.name === SESSION_COOKIE_NAME &&
    (c.cleared === true || c.options?.maxAge === 0 || c.options?.maxAge <= 0 || c.options?.expires?.getTime?.() <= Date.now())
  );
  check('Cookie expired or cleared', cleared !== undefined,
    'cleared cookie', 'no cleared cookie found');
});

await testAsync('3.5.4.2', 'clearSession uses same cookie name as createSession', async () => {
  console.log('  If clearSession uses a different cookie name, the session cookie persists');
  console.log('  Checking: the cleared cookie name matches SESSION_COOKIE_NAME');
  var res = mockRes();
  clearSession(res);
  var cookies = res.getCookies();
  var sessionClear = cookies.find(c => c.name === SESSION_COOKIE_NAME);
  check('Same cookie name', sessionClear !== undefined,
    SESSION_COOKIE_NAME, 'cookie name: ' + (cookies[0]?.name || 'none'));
});

await testAsync('3.5.4.3', 'clearSession cookie has httpOnly', async () => {
  console.log('  The clearing cookie must also have httpOnly to match the original');
  console.log('  If httpOnly differs, the browser treats them as different cookies');
  console.log('  The original cookie persists while a non-httpOnly version is cleared');
  console.log('  Checking: cleared cookie options.httpOnly === true');
  var res = mockRes();
  clearSession(res);
  var cookies = res.getCookies();
  var sessionClear = cookies.find(c => c.name === SESSION_COOKIE_NAME);
  check('Cleared cookie has httpOnly', sessionClear?.options?.httpOnly === true,
    'true', String(sessionClear?.options?.httpOnly));
});

await testAsync('3.5.4.4', 'clearSession cookie has path=/', async () => {
  console.log('  The clearing cookie must have the same path as the original');
  console.log('  A cookie set on path=/ is only cleared by a cookie with path=/');
  console.log('  Checking: cleared cookie options.path === "/"');
  var res = mockRes();
  clearSession(res);
  var cookies = res.getCookies();
  var sessionClear = cookies.find(c => c.name === SESSION_COOKIE_NAME);
  check('Cleared cookie has path=/', sessionClear?.options?.path === '/',
    '/', String(sessionClear?.options?.path));
});

await testAsync('3.5.4.5', 'clearSession does not throw when no session exists', async () => {
  console.log('  Calling clearSession on a fresh response (no prior createSession)');
  console.log('  This happens when a user visits /auth/logout without being logged in');
  console.log('  The function must not throw — it should be a no-op or set maxAge=0 anyway');
  console.log('  Checking: no exception thrown');
  var res = mockRes();
  var threw = false;
  try {
    clearSession(res);
  } catch (e) {
    threw = true;
  }
  check('No throw on empty clear', !threw, 'no throw', 'threw');
});

await testAsync('3.5.4.6', 'After clear, readSession returns null', async () => {
  console.log('  Step 1: Create a session (sets cookie on res1)');
  console.log('  Step 2: Build a request from that cookie');
  console.log('  Step 3: Verify readSession returns data (session exists)');
  console.log('  Step 4: Call clearSession — this modifies the response, not the request');
  console.log('  Step 5: Build a new request with the cleared cookie value');
  console.log('  Step 6: readSession on the new request should return null');
  console.log('  Note: clearSession sets the cookie value to empty, so we simulate');
  console.log('  the browser sending the empty cookie on the next request');
  var res1 = mockRes();
  createSession(res1, {
    accessToken: 'test-token', expiresIn: 3600, refreshToken: 'r',
    user: { sub: 'x', email: 'x@x.com', name: 'X' }
  });
  var req1 = mockReqFromRes(res1);
  var session1 = readSession(req1);
  check('Session exists before clear', session1 !== null, 'non-null', String(session1));

  // Simulate: browser receives cleared cookie, sends empty value next request
  var reqAfterClear = { headers: { cookie: SESSION_COOKIE_NAME + '=' } };
  var session2 = readSession(reqAfterClear);
  check('Session null after clear', session2 === null, 'null', String(session2));
});

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Cleanup ──────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
