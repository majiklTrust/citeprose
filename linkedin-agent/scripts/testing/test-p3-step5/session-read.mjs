// ═══════════════════════════════════════════════════════════════
// Step 5 Group 2: Session Reading
// Tests readSession() — decrypts cookie and returns payload
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

import {
  createSession,
  readSession,
  SESSION_COOKIE_NAME,
} from '../../../src/auth/session.js';

// ── Environment setup ────────────────────────────────────────
const TEST_SECRET = 'b'.repeat(64);
process.env.SESSION_SECRET = TEST_SECRET;

// ── Mock helpers ─────────────────────────────────────────────
function mockRes() {
  var cookies = [];
  return {
    cookie(name, value, options) {
      cookies.push({ name, value, options: options || {} });
    },
    getCookies() { return cookies; },
    getSessionCookie() {
      return cookies.find(c => c.name === SESSION_COOKIE_NAME) || null;
    }
  };
}

// Build a mock request with a Cookie header containing the session cookie.
// readSession parses req.headers.cookie to find the session value.
// This simulates what the browser sends on subsequent requests.
function mockReqFromRes(res) {
  var cookie = res.getSessionCookie();
  if (!cookie) return { headers: {} };
  return {
    headers: {
      cookie: SESSION_COOKIE_NAME + '=' + cookie.value
    }
  };
}

function mockReqWithCookie(value) {
  return {
    headers: {
      cookie: SESSION_COOKIE_NAME + '=' + value
    }
  };
}

function mockReqNoCookie() {
  return { headers: {} };
}

var validTokens = {
  accessToken: 'eyJhbGciOiJSUzI1NiJ9.test-access-token',
  refreshToken: 'v1.test-refresh-token',
  expiresIn: 3600,
  user: {
    sub: 'auth0|read_test_001',
    email: 'reader@example.com',
    name: 'Read Tester'
  }
};

// ── Group 2: Session reading ─────────────────────────────────
group('Group 2: Session reading', `
  Impact: If these tests fail, the server cannot read the session
  cookie it set during login. Every request after login appears
  unauthenticated. The user is stuck in an infinite login loop.

  Module under test: src/auth/session.js
  Function: readSession(req)
  Dependencies: SESSION_SECRET env var (same key used for encryption)
  Input: Express request object with Cookie header
  Output: { accessToken, refreshToken, expiresAt, user } or null
`);

var before2 = getCounters();

await testAsync('3.5.2.1', 'readSession decrypts a cookie set by createSession', async () => {
  console.log('  Step 1: Calling createSession(res, tokens) to encrypt tokens into a cookie');
  console.log('  Step 2: Extracting the encrypted cookie value from the mock response');
  console.log('  Step 3: Building a mock request with that cookie in the Cookie header');
  console.log('  Step 4: Calling readSession(req) to decrypt the cookie');
  console.log('  The roundtrip tests that encryption and decryption use the same key and format');
  console.log('  Checking: readSession returns a non-null object');
  var res = mockRes();
  createSession(res, validTokens);
  var req = mockReqFromRes(res);
  var session = readSession(req);
  check('readSession returns session object', session !== null && typeof session === 'object',
    'non-null object', String(session));
});

await testAsync('3.5.2.2', 'Decrypted payload contains accessToken', async () => {
  console.log('  After roundtrip: createSession → set cookie → readSession');
  console.log('  The decrypted session must contain the original accessToken string');
  console.log('  This is the token the middleware can use for Auth0 API calls');
  console.log('  Comparing: session.accessToken === original tokens.accessToken');
  var res = mockRes();
  createSession(res, validTokens);
  var session = readSession(mockReqFromRes(res));
  check('accessToken matches', session?.accessToken === validTokens.accessToken,
    validTokens.accessToken.substring(0, 30) + '...', String(session?.accessToken).substring(0, 30) + '...');
});

await testAsync('3.5.2.3', 'Decrypted payload contains refreshToken', async () => {
  console.log('  Checking that the refresh token survives the encryption roundtrip');
  console.log('  The refresh token is used to obtain new access tokens without re-login');
  console.log('  Comparing: session.refreshToken === original tokens.refreshToken');
  var res = mockRes();
  createSession(res, validTokens);
  var session = readSession(mockReqFromRes(res));
  check('refreshToken matches', session?.refreshToken === validTokens.refreshToken,
    validTokens.refreshToken, String(session?.refreshToken));
});

await testAsync('3.5.2.4', 'Decrypted payload contains expiresAt as number', async () => {
  console.log('  createSession receives expiresIn (seconds from now)');
  console.log('  It converts to expiresAt (absolute timestamp) for storage');
  console.log('  readSession returns expiresAt so the middleware can check expiry');
  console.log('  Checking: session.expiresAt is a number (milliseconds since epoch)');
  var res = mockRes();
  createSession(res, validTokens);
  var session = readSession(mockReqFromRes(res));
  check('expiresAt is a number', typeof session?.expiresAt === 'number',
    'number', typeof session?.expiresAt);
});

await testAsync('3.5.2.5', 'expiresAt is in the future', async () => {
  console.log('  Token was created with expiresIn=3600 (1 hour from now)');
  console.log('  expiresAt should be approximately Date.now() + 3600000');
  console.log('  Allowing 5 seconds of tolerance for test execution time');
  console.log('  Checking: session.expiresAt > Date.now()');
  var res = mockRes();
  createSession(res, validTokens);
  var session = readSession(mockReqFromRes(res));
  var now = Date.now();
  check('expiresAt is in the future', session?.expiresAt > now,
    '> ' + now, String(session?.expiresAt));
});

await testAsync('3.5.2.6', 'Decrypted payload contains user claims', async () => {
  console.log('  The session stores user claims from getUserInfo: sub, email, name');
  console.log('  These populate req.user in the middleware — no JWT decoding needed per request');
  console.log('  Checking: session.user.sub, session.user.email, session.user.name');
  var res = mockRes();
  createSession(res, validTokens);
  var session = readSession(mockReqFromRes(res));
  check('User sub matches', session?.user?.sub === validTokens.user.sub,
    validTokens.user.sub, String(session?.user?.sub));
  check('User email matches', session?.user?.email === validTokens.user.email,
    validTokens.user.email, String(session?.user?.email));
  check('User name matches', session?.user?.name === validTokens.user.name,
    validTokens.user.name, String(session?.user?.name));
});

await testAsync('3.5.2.7', 'readSession returns null when no cookie present', async () => {
  console.log('  Building a request with no Cookie header at all');
  console.log('  This is the first request from a new browser — no prior session');
  console.log('  readSession must return null (not throw, not return empty object)');
  console.log('  Checking: readSession(req) === null');
  var req = mockReqNoCookie();
  var session = readSession(req);
  check('Returns null for no cookie', session === null, 'null', String(session));
});

await testAsync('3.5.2.8', 'readSession returns null for wrong cookie name', async () => {
  console.log('  Building a request with a cookie named "other_session" instead of SESSION_COOKIE_NAME');
  console.log('  readSession only reads the specific cookie name — ignores all others');
  console.log('  Checking: readSession returns null');
  var req = { headers: { cookie: 'other_session=some-encrypted-value' } };
  var session = readSession(req);
  check('Returns null for wrong name', session === null, 'null', String(session));
});

await testAsync('3.5.2.9', 'readSession returns null for empty cookie value', async () => {
  console.log('  Building a request where the session cookie exists but has an empty value');
  console.log('  This can happen if clearSession set the value to empty');
  console.log('  Checking: readSession returns null');
  var req = mockReqWithCookie('');
  var session = readSession(req);
  check('Returns null for empty value', session === null, 'null', String(session));
});

await testAsync('3.5.2.10', 'readSession with missing SESSION_SECRET throws or returns null', async () => {
  console.log('  Temporarily removing SESSION_SECRET from process.env');
  console.log('  Without the decryption key, the session cannot be read');
  console.log('  The function must either throw (fail-closed) or return null (deny access)');
  console.log('  Either behavior is acceptable — what is NOT acceptable is returning a session');
  var res = mockRes();
  createSession(res, validTokens);
  var req = mockReqFromRes(res);
  var saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  var result = 'unknown';
  try {
    var session = readSession(req);
    result = session === null ? 'null (safe)' : 'session returned (UNSAFE)';
  } catch (e) {
    result = 'threw (safe)';
  }
  process.env.SESSION_SECRET = saved;
  check('Missing secret fails safely', result !== 'session returned (UNSAFE)',
    'null or throw', result);
});

await testAsync('3.5.2.11', 'Full roundtrip preserves all fields', async () => {
  console.log('  Final integrity check: encrypt → decrypt → compare every field');
  console.log('  tokens.accessToken, tokens.refreshToken, computed expiresAt, user.sub/email/name');
  console.log('  Any field that does not survive the roundtrip means data loss in the session');
  var res = mockRes();
  createSession(res, validTokens);
  var session = readSession(mockReqFromRes(res));
  var allMatch =
    session?.accessToken === validTokens.accessToken &&
    session?.refreshToken === validTokens.refreshToken &&
    typeof session?.expiresAt === 'number' &&
    session?.user?.sub === validTokens.user.sub &&
    session?.user?.email === validTokens.user.email &&
    session?.user?.name === validTokens.user.name;
  check('All fields survive roundtrip', allMatch, 'all match', 'mismatch detected');
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Cleanup ──────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
