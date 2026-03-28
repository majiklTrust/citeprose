// ═══════════════════════════════════════════════════════════════
// Step 5 Groups 5-6: Middleware Session Integration
// Tests requireAuth cookie path and cookie+Bearer coexistence
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

import { createSession, SESSION_COOKIE_NAME } from '../../../src/auth/session.js';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { clearJwksCache } from '../../../src/auth/jwt-verifier.js';
import {
  _resetForTesting, initRegistry, getProviders, _patchSnapshotForTesting
} from '../../../src/auth/index.js';
import { createAuthMiddleware } from '../../../src/auth/middleware.js';

// ── Environment setup ────────────────────────────────────────
const TEST_SECRET = 'd'.repeat(64);
process.env.SESSION_SECRET = TEST_SECRET;

// Set up mock auth provider with local JWKS server
var helper = await createTestJWKS({ issuer: 'https://mock-auth.test/' });
_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
var mp = getProviders().find(p => p.name === 'mock');
Object.defineProperty(mp, 'jwksUri', { get: () => helper.jwksUri, configurable: true });
Object.defineProperty(mp, 'audience', { get: () => helper.audience, configurable: true });
_patchSnapshotForTesting('mock', { jwksUri: helper.jwksUri, audience: helper.audience });

var { requireAuth } = createAuthMiddleware(() => {});

// ── Mock helpers ─────────────────────────────────────────────
// Mock Express response that captures both cookies and JSON responses
function mockRes() {
  var cookies = [];
  var _status = null;
  var _json = null;
  return {
    cookie(name, value, options) {
      cookies.push({ name, value, options: options || {} });
    },
    status(s) { _status = s; return this; },
    json(j) { _json = j; return this; },
    getCookies() { return cookies; },
    getSessionCookie() {
      return cookies.find(c => c.name === SESSION_COOKIE_NAME) || null;
    },
    getStatus() { return _status; },
    getJson() { return _json; }
  };
}

// Create a valid session cookie value by encrypting tokens
function createSessionCookieValue(userOverrides) {
  var res = mockRes();
  var tokens = {
    accessToken: 'eyJ-session-test-token',
    refreshToken: 'v1.refresh',
    expiresIn: 3600,
    user: {
      sub: userOverrides?.sub || 'auth0|session_user',
      email: userOverrides?.email || 'session@example.com',
      name: userOverrides?.name || 'Session User',
      ...userOverrides
    }
  };
  createSession(res, tokens);
  return res.getSessionCookie()?.value;
}

// Build a mock request with a session cookie
function mockReqWithSession(cookieValue, extraHeaders) {
  var headers = { ...(extraHeaders || {}) };
  if (cookieValue) {
    headers.cookie = SESSION_COOKIE_NAME + '=' + cookieValue;
  }
  return { headers, path: '/api/test' };
}

// Build a mock request with a Bearer token
function mockReqWithBearer(token) {
  return {
    headers: { authorization: 'Bearer ' + token },
    path: '/api/test'
  };
}

// Build a mock request with both cookie and Bearer
function mockReqWithBoth(cookieValue, bearerToken) {
  return {
    headers: {
      cookie: SESSION_COOKIE_NAME + '=' + cookieValue,
      authorization: 'Bearer ' + bearerToken
    },
    path: '/api/test'
  };
}

// ── Group 5: Cookie authentication path ──────────────────────
group('Group 5: Middleware cookie authentication', `
  Impact: If these tests fail, the session cookie set during login
  is not recognized by the middleware on subsequent requests.
  The dashboard sends the cookie with every fetch() call,
  but the server ignores it and returns 401. The user appears
  logged out immediately after logging in.

  Module under test: src/auth/middleware.js (extended requireAuth)
  Integration: reads session via src/auth/session.js readSession()
  Flow: request → check cookie → decrypt → extract user → set req.user
`);

var before5 = getCounters();

await testAsync('3.5.5.1', 'Valid session cookie authenticates the request', async () => {
  console.log('  Creating a session cookie via createSession() with sub=auth0|session_user');
  console.log('  Building a request with that cookie in the Cookie header');
  console.log('  Passing the request through requireAuth middleware');
  console.log('  The middleware should call readSession(), find valid session data,');
  console.log('  set req.user from session.user, and call next()');
  console.log('  Checking: next() was called (request passed through)');
  var cookieValue = createSessionCookieValue();
  var req = mockReqWithSession(cookieValue);
  var res = mockRes();
  var nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  check('Request passes with session cookie', nextCalled, 'next() called', 'blocked');
});

await testAsync('3.5.5.2', 'req.user.sub populated from session', async () => {
  console.log('  After successful cookie authentication, req.user should contain');
  console.log('  the user claims stored in the session at login time');
  console.log('  Checking: req.user.sub === "auth0|session_user"');
  var cookieValue = createSessionCookieValue({ sub: 'auth0|cookie_user_001' });
  var req = mockReqWithSession(cookieValue);
  var res = mockRes();
  await requireAuth(req, res, () => {});
  check('req.user.sub from session', req.user?.sub === 'auth0|cookie_user_001',
    'auth0|cookie_user_001', String(req.user?.sub));
});

await testAsync('3.5.5.3', 'req.user.email populated from session', async () => {
  console.log('  Checking: req.user.email matches the email stored in the session');
  var cookieValue = createSessionCookieValue({ email: 'cookie@test.com' });
  var req = mockReqWithSession(cookieValue);
  var res = mockRes();
  await requireAuth(req, res, () => {});
  check('req.user.email from session', req.user?.email === 'cookie@test.com',
    'cookie@test.com', String(req.user?.email));
});

await testAsync('3.5.5.4', 'No cookie and no Bearer returns 401', async () => {
  console.log('  Building a request with no Cookie header and no Authorization header');
  console.log('  The middleware checks session cookie first (none found),');
  console.log('  then checks Bearer token (none found), then returns 401');
  console.log('  Checking: response status === 401');
  var req = { headers: {}, path: '/api/test' };
  var res = mockRes();
  var nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  check('Returns 401', !nextCalled && res.getStatus() === 401,
    '401', 'next=' + nextCalled + ' status=' + res.getStatus());
});

await testAsync('3.5.5.5', 'Invalid cookie and no Bearer returns 401', async () => {
  console.log('  Building a request with a garbage cookie value (not valid ciphertext)');
  console.log('  readSession() returns null for invalid ciphertext');
  console.log('  No Bearer header fallback → 401');
  console.log('  Checking: response status === 401');
  var req = mockReqWithSession('this-is-not-encrypted');
  var res = mockRes();
  var nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  check('Invalid cookie returns 401', !nextCalled && res.getStatus() === 401,
    '401', 'next=' + nextCalled + ' status=' + res.getStatus());
});

await testAsync('3.5.5.6', 'Two different session users produce different req.user', async () => {
  console.log('  Creating two session cookies with different user claims');
  console.log('  Each request through requireAuth should get its own req.user');
  console.log('  If the middleware caches the session, the second request gets the first user');
  console.log('  Checking: req1.user.sub !== req2.user.sub');
  var cookie1 = createSessionCookieValue({ sub: 'alice' });
  var cookie2 = createSessionCookieValue({ sub: 'bob' });
  var req1 = mockReqWithSession(cookie1);
  var req2 = mockReqWithSession(cookie2);
  var res1 = mockRes();
  var res2 = mockRes();
  await requireAuth(req1, res1, () => {});
  await requireAuth(req2, res2, () => {});
  check('First request is Alice', req1.user?.sub === 'alice', 'alice', String(req1.user?.sub));
  check('Second request is Bob', req2.user?.sub === 'bob', 'bob', String(req2.user?.sub));
});

var after5 = getCounters();
groupEnd(after5.pass - before5.pass, after5.fail - before5.fail);

// ── Group 6: Cookie + Bearer coexistence ─────────────────────
group('Group 6: Cookie and Bearer token coexistence', `
  Impact: If these tests fail, the middleware cannot serve both browser
  users (cookies) and programmatic clients (Bearer tokens).
  Either the dashboard breaks or scripts/CI tools are locked out.

  Module under test: src/auth/middleware.js (extended requireAuth)
  Flow: cookie check → if null, Bearer check → if null, 401
  Priority: cookie first (browser path), Bearer fallback (script path)
`);

var before6 = getCounters();

await testAsync('3.5.6.1', 'Cookie present, no Bearer → cookie used', async () => {
  console.log('  Building a request with only a session cookie (no Authorization header)');
  console.log('  This is the normal browser path — fetch() sends cookies automatically');
  console.log('  The middleware should use the cookie and not look for a Bearer token');
  console.log('  Checking: req.user.sub matches the session user');
  var cookieValue = createSessionCookieValue({ sub: 'cookie_only' });
  var req = mockReqWithSession(cookieValue);
  var res = mockRes();
  await requireAuth(req, res, () => {});
  check('Cookie-only user', req.user?.sub === 'cookie_only',
    'cookie_only', String(req.user?.sub));
});

await testAsync('3.5.6.2', 'No cookie, Bearer present → Bearer used', async () => {
  console.log('  Building a request with only a Bearer token (no Cookie header)');
  console.log('  This is the programmatic path — curl or scripts set Authorization header');
  console.log('  The middleware should skip the cookie check and validate the Bearer JWT');
  console.log('  Checking: req.user.sub matches the JWT payload');
  var bearerToken = await helper.signToken({ sub: 'bearer_only' });
  var req = mockReqWithBearer(bearerToken);
  var res = mockRes();
  await requireAuth(req, res, () => {});
  check('Bearer-only user', req.user?.sub === 'bearer_only',
    'bearer_only', String(req.user?.sub));
});

await testAsync('3.5.6.3', 'Both present → cookie takes priority', async () => {
  console.log('  Building a request with BOTH a session cookie AND a Bearer token');
  console.log('  The cookie belongs to "cookie_user", the Bearer token to "bearer_user"');
  console.log('  Cookie takes priority because it is the browser path — the primary use case');
  console.log('  Checking: req.user.sub === "cookie_user" (not "bearer_user")');
  var cookieValue = createSessionCookieValue({ sub: 'cookie_user' });
  var bearerToken = await helper.signToken({ sub: 'bearer_user' });
  var req = mockReqWithBoth(cookieValue, bearerToken);
  var res = mockRes();
  await requireAuth(req, res, () => {});
  check('Cookie takes priority', req.user?.sub === 'cookie_user',
    'cookie_user', String(req.user?.sub));
});

await testAsync('3.5.6.4', 'Invalid cookie, valid Bearer → Bearer used as fallback', async () => {
  console.log('  Building a request with a corrupted cookie AND a valid Bearer token');
  console.log('  readSession() returns null for the bad cookie');
  console.log('  The middleware falls through to the Bearer check, which succeeds');
  console.log('  This handles the case where the session is corrupted but the user');
  console.log('  also happens to have a Bearer token (e.g., from a script)');
  console.log('  Checking: req.user.sub === "bearer_fallback"');
  var bearerToken = await helper.signToken({ sub: 'bearer_fallback' });
  var req = mockReqWithBoth('corrupted-cookie-value', bearerToken);
  var res = mockRes();
  await requireAuth(req, res, () => {});
  check('Bearer used as fallback', req.user?.sub === 'bearer_fallback',
    'bearer_fallback', String(req.user?.sub));
});

await testAsync('3.5.6.5', 'Invalid cookie, invalid Bearer → 401', async () => {
  console.log('  Building a request with a corrupted cookie AND an invalid Bearer token');
  console.log('  Both authentication paths fail');
  console.log('  The middleware must return 401, not 500');
  console.log('  Checking: response status === 401');
  var req = mockReqWithBoth('bad-cookie', 'bad.bearer.token');
  var res = mockRes();
  var nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  check('Both invalid returns 401', !nextCalled && res.getStatus() === 401,
    '401', 'next=' + nextCalled + ' status=' + res.getStatus());
});

await testAsync('3.5.6.6', 'Dev mode bypasses both cookie and Bearer', async () => {
  console.log('  Shutting down all providers to simulate dev mode');
  console.log('  In dev mode, requireAuth passes through without checking anything');
  console.log('  req.user is null, req.authSkipped is true');
  _resetForTesting();
  delete process.env.MOCK_AUTH_ENABLED;
  await initRegistry(() => {});
  var devMiddleware = createAuthMiddleware(() => {});
  var req = { headers: {}, path: '/api/test' };
  var res = mockRes();
  var nextCalled = false;
  await devMiddleware.requireAuth(req, res, () => { nextCalled = true; });
  check('Dev mode passes through', nextCalled && req.authSkipped === true,
    'next + authSkipped', 'next=' + nextCalled + ' authSkipped=' + req.authSkipped);

  // Restore provider for any subsequent tests
  _resetForTesting();
  process.env.MOCK_AUTH_ENABLED = 'true';
  await initRegistry(() => {});
  var mp2 = getProviders().find(p => p.name === 'mock');
  Object.defineProperty(mp2, 'jwksUri', { get: () => helper.jwksUri, configurable: true });
  Object.defineProperty(mp2, 'audience', { get: () => helper.audience, configurable: true });
  _patchSnapshotForTesting('mock', { jwksUri: helper.jwksUri, audience: helper.audience });
});

var after6 = getCounters();
groupEnd(after6.pass - before6.pass, after6.fail - before6.fail);

// ── Cleanup ──────────────────────────────────────────────────
await helper.close();
clearJwksCache();
delete process.env.MOCK_AUTH_ENABLED;

var summary = getCounters();
process.exit(summary.fail);
