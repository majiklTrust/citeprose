// ═══════════════════════════════════════════════════════════════
// Step 5 Group 1: Session Creation
// Tests createSession() — encrypts tokens into httpOnly cookie
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

// ── Import the module under test ─────────────────────────────
// createSession is the function that takes an Express response object
// and a tokens payload, encrypts the payload using AES-256-GCM,
// and sets the result as an httpOnly cookie on the response.
//
// SESSION_COOKIE_NAME is the constant cookie name used across
// all session operations — create, read, and clear must agree.
//
// SESSION_MAX_AGE_MS is the cookie lifetime, read from env or defaulted.
import {
  createSession,
  readSession,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS
} from '../../../src/auth/session.js';

// ── Environment setup ────────────────────────────────────────
// SESSION_SECRET must be a hex string of at least 64 characters (32 bytes).
// The session module derives an AES-256 key from this via HKDF.
// We set a known test value here — production uses a cryptographically
// random value from .env.
const TEST_SECRET = 'a'.repeat(64);
process.env.SESSION_SECRET = TEST_SECRET;

// ── Mock helpers ─────────────────────────────────────────────
// Express res.cookie(name, value, options) is what createSession calls.
// We capture the arguments to verify cookie attributes.
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
      return cookies.find(c => c.name === SESSION_COOKIE_NAME) || null;
    }
  };
}

// Standard token payload — simulates what Auth0 returns after code exchange
// plus user claims from getUserInfo
var validTokens = {
  accessToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.fake-sig',
  refreshToken: 'v1.refresh-token-value',
  expiresIn: 3600,
  user: {
    sub: 'auth0|user_001',
    email: 'test@example.com',
    name: 'Test User'
  }
};

// ── Group 1: Session creation ────────────────────────────────
group('Group 1: Session creation', `
  Impact: If these tests fail, users who successfully authenticate
  with Auth0 never receive a session cookie. Every page load
  after login redirects back to Auth0. The dashboard is
  unusable even though authentication works.

  Module under test: src/auth/session.js
  Function: createSession(res, tokens)
  Dependencies: SESSION_SECRET env var, Node crypto module (AES-256-GCM)
`);

var before1 = getCounters();

await testAsync('3.5.1.1', 'Session cookie set on response', async () => {
  console.log('  Calling createSession() from src/auth/session.js');
  console.log('  Input: mock Express response object + token payload with accessToken, refreshToken, expiresIn, user');
  console.log('  createSession encrypts the payload using AES-256-GCM with SESSION_SECRET from env');
  console.log('  The encrypted result is set as a cookie on the response via res.cookie()');
  console.log('  Checking: res.getCookies() contains at least one cookie after the call');
  var res = mockRes();
  createSession(res, validTokens);
  var cookies = res.getCookies();
  check('Session cookie set on response', cookies.length >= 1, '≥1 cookie', String(cookies.length) + ' cookies');
});

await testAsync('3.5.1.2', 'Cookie name matches constant', async () => {
  console.log('  Calling createSession() and reading the cookie name from the response');
  console.log('  The cookie name must match SESSION_COOKIE_NAME exported from session.js');
  console.log('  This ensures readSession() and clearSession() look for the same cookie');
  console.log('  Comparing: res.getSessionCookie().name === SESSION_COOKIE_NAME');
  var res = mockRes();
  createSession(res, validTokens);
  var cookie = res.getSessionCookie();
  check('Cookie name matches constant', cookie !== null, 'cookie named ' + SESSION_COOKIE_NAME, cookie ? cookie.name : 'no session cookie');
});

await testAsync('3.5.1.3', 'Cookie value is encrypted', async () => {
  console.log('  Calling createSession() and reading the raw cookie value');
  console.log('  The value must NOT contain plaintext JSON, token strings, or user data');
  console.log('  AES-256-GCM produces opaque ciphertext — no readable fragments');
  console.log('  Checking: cookie value does not contain "accessToken", "sub", or "email"');
  var res = mockRes();
  createSession(res, validTokens);
  var cookie = res.getSessionCookie();
  var val = cookie ? cookie.value : '';
  var containsPlaintext = val.includes('accessToken') || val.includes('auth0|user_001') || val.includes('test@example.com');
  check('Cookie value is not plaintext', !containsPlaintext, 'opaque ciphertext', 'contains plaintext fragments');
});

await testAsync('3.5.1.4', 'Cookie has httpOnly flag', async () => {
  console.log('  Reading cookie options from the mock response');
  console.log('  httpOnly:true prevents JavaScript from accessing the cookie via document.cookie');
  console.log('  This is the primary defense against XSS-based session theft');
  console.log('  Comparing: cookie.options.httpOnly === true');
  var res = mockRes();
  createSession(res, validTokens);
  var cookie = res.getSessionCookie();
  check('httpOnly flag is true', cookie?.options?.httpOnly === true, 'true', String(cookie?.options?.httpOnly));
});

await testAsync('3.5.1.5', 'Cookie has sameSite=lax', async () => {
  console.log('  Reading cookie options.sameSite from the mock response');
  console.log('  sameSite:lax prevents the cookie from being sent on cross-origin POST requests');
  console.log('  This blocks CSRF attacks where a malicious site submits forms to our API');
  console.log('  "lax" allows normal navigation (clicking links) while blocking cross-origin POSTs');
  console.log('  Comparing: cookie.options.sameSite lowercased === "lax"');
  var res = mockRes();
  createSession(res, validTokens);
  var cookie = res.getSessionCookie();
  var sameSite = String(cookie?.options?.sameSite || '').toLowerCase();
  check('sameSite is lax', sameSite === 'lax', 'lax', sameSite);
});

await testAsync('3.5.1.6', 'Cookie has path=/', async () => {
  console.log('  Reading cookie options.path from the mock response');
  console.log('  path:/ makes the cookie available on all routes');
  console.log('  Without this, the cookie might only be sent on the route that set it');
  console.log('  Comparing: cookie.options.path === "/"');
  var res = mockRes();
  createSession(res, validTokens);
  var cookie = res.getSessionCookie();
  check('Path is /', cookie?.options?.path === '/', '/', String(cookie?.options?.path));
});

await testAsync('3.5.1.7', 'Cookie secure=false in non-production', async () => {
  console.log('  Current NODE_ENV: ' + (process.env.NODE_ENV || '(unset)'));
  console.log('  When NODE_ENV is not "production", secure must be false');
  console.log('  secure:true requires HTTPS — local development uses HTTP');
  console.log('  Comparing: cookie.options.secure === false');
  delete process.env.NODE_ENV;
  var res = mockRes();
  createSession(res, validTokens);
  var cookie = res.getSessionCookie();
  check('Secure is false in dev', cookie?.options?.secure === false, 'false', String(cookie?.options?.secure));
});

await testAsync('3.5.1.8', 'Cookie secure=true in production', async () => {
  console.log('  Setting NODE_ENV=production temporarily');
  console.log('  In production, secure:true ensures the cookie is only sent over HTTPS');
  console.log('  Without this, the cookie could be intercepted on an unencrypted connection');
  console.log('  Comparing: cookie.options.secure === true');
  process.env.NODE_ENV = 'production';
  var res = mockRes();
  createSession(res, validTokens);
  var cookie = res.getSessionCookie();
  check('Secure is true in production', cookie?.options?.secure === true, 'true', String(cookie?.options?.secure));
  delete process.env.NODE_ENV;
});

await testAsync('3.5.1.9', 'Cookie maxAge matches SESSION_MAX_AGE_MS', async () => {
  console.log('  Reading cookie options.maxAge from the mock response');
  console.log('  SESSION_MAX_AGE_MS is exported from session.js (default 86400000 = 24 hours)');
  console.log('  The cookie maxAge must match — mismatch means the browser discards');
  console.log('  the cookie before or after the server considers it valid');
  console.log('  Comparing: cookie.options.maxAge === SESSION_MAX_AGE_MS');
  var res = mockRes();
  createSession(res, validTokens);
  var cookie = res.getSessionCookie();
  check('maxAge matches constant', cookie?.options?.maxAge === SESSION_MAX_AGE_MS,
    String(SESSION_MAX_AGE_MS), String(cookie?.options?.maxAge));
});

await testAsync('3.5.1.10', 'Two sessions produce different ciphertext', async () => {
  console.log('  Calling createSession() twice with the same token payload');
  console.log('  AES-256-GCM requires a unique 12-byte IV per encryption');
  console.log('  If the IV is reused, an attacker can XOR two ciphertexts to recover plaintext');
  console.log('  Different IVs produce different ciphertext even for identical input');
  console.log('  Comparing: cookie1.value !== cookie2.value');
  var res1 = mockRes();
  var res2 = mockRes();
  createSession(res1, validTokens);
  createSession(res2, validTokens);
  var val1 = res1.getSessionCookie()?.value;
  var val2 = res2.getSessionCookie()?.value;
  check('Different ciphertext per call', val1 !== val2 && val1 && val2,
    'different values', val1 === val2 ? 'identical values (IV reuse)' : 'different values');
});

await testAsync('3.5.1.11', 'Missing accessToken throws', async () => {
  console.log('  Calling createSession() with tokens that have no accessToken field');
  console.log('  A session without an access token is useless — the middleware cannot authorize');
  console.log('  createSession must throw rather than create a broken session');
  console.log('  Checking: createSession throws an error');
  var res = mockRes();
  var threw = false;
  try {
    createSession(res, { refreshToken: 'x', expiresIn: 3600, user: { sub: 'a' } });
  } catch (e) {
    threw = true;
  }
  check('Throws without accessToken', threw, 'throws', 'did not throw');
});

await testAsync('3.5.1.12', 'Missing SESSION_SECRET throws', async () => {
  console.log('  Temporarily removing SESSION_SECRET from process.env');
  console.log('  Without a secret, there is no encryption key — the session is unprotectable');
  console.log('  createSession must refuse to produce an unencrypted cookie');
  console.log('  Checking: createSession throws an error');
  var saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  var res = mockRes();
  var threw = false;
  try {
    createSession(res, validTokens);
  } catch (e) {
    threw = true;
  }
  process.env.SESSION_SECRET = saved;
  check('Throws without SESSION_SECRET', threw, 'throws', 'did not throw');
});

await testAsync('3.5.1.13', 'Missing user claims throws', async () => {
  console.log('  Calling createSession() with tokens that have no user field');
  console.log('  The session stores user claims (sub, email, name) for req.user');
  console.log('  Without user claims, the middleware cannot identify who is logged in');
  console.log('  Checking: createSession throws an error');
  var res = mockRes();
  var threw = false;
  try {
    createSession(res, { accessToken: 'x', expiresIn: 3600 });
  } catch (e) {
    threw = true;
  }
  check('Throws without user claims', threw, 'throws', 'did not throw');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Cleanup ──────────────────────────────────────────────────
process.env.SESSION_SECRET = TEST_SECRET;
var summary = getCounters();
process.exit(summary.fail);
