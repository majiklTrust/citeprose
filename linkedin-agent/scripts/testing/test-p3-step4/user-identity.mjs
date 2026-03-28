// ═══════════════════════════════════════════════════════════════
// Step 4 Group 7: User Identity in Route Handlers
//
// The middleware attaches req.user, but if the route handler
// never receives it, user-scoped actions silently break. This
// group tests that the user object survives the full Express
// pipeline from middleware through to response.
//
// Strategy: We add a test-only route that echoes back req.user
// and req.authProvider. This avoids coupling to route handler
// internals while proving the middleware→handler handoff works.
// ═══════════════════════════════════════════════════════════════

import http from 'node:http';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { clearJwksCache } from '../../../src/auth/jwt-verifier.js';
import { _resetForTesting, initRegistry, getProviders, _patchSnapshotForTesting } from '../../../src/auth/index.js';
import { createAuthMiddleware } from '../../../src/auth/middleware.js';

// ── Setup ────────────────────────────────────────────────────

var helper = await createTestJWKS({ issuer: 'https://mock-auth.test/' });
_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
var mp = getProviders().find(p => p.name === 'mock');
Object.defineProperty(mp, 'jwksUri', { get: () => helper.jwksUri, configurable: true });
Object.defineProperty(mp, 'audience', { get: () => helper.audience, configurable: true });
_patchSnapshotForTesting('mock', { jwksUri: helper.jwksUri, audience: helper.audience });

var { requireAuth, optionalAuth } = createAuthMiddleware(() => {});
var express = (await import('express')).default;
var app = express();
app.use(express.json());

// Test route: echoes req.user back as JSON
app.get('/test/echo-user', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    authProvider: req.authProvider,
    authSkipped: req.authSkipped || false
  });
});

// Test route: optionalAuth — echoes user if present, null if not
app.get('/test/optional-user', optionalAuth, (req, res) => {
  res.json({
    user: req.user,
    authProvider: req.authProvider || null,
    authSkipped: req.authSkipped || false
  });
});

var server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
var BASE = 'http://127.0.0.1:' + server.address().port;

async function GET(path, token) {
  var headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var res = await fetch(BASE + path, { headers });
  var body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// ── Group 7: User identity available in route handlers ───────

group('Group 7: User identity available in route handlers', `
  If these tests fail, the middleware authenticates the user but
  the route handler never sees who they are. Activity logs show
  "unknown user", data filtering by user fails silently, and
  audit trails are meaningless.
`);

var before7 = getCounters();

await testAsync('3.4.7.1', '', async () => {
  console.log('  Sending request with sub=user_001 email=admin@company.com name=Admin');
  console.log('  The route handler echoes req.user back as JSON');
  console.log('  If the middleware sets req.user but Express resets it, this catches that');
  var token = await helper.signToken({ sub: 'user_001', email: 'admin@company.com', name: 'Admin' });
  var r = await GET('/test/echo-user', token);
  check('Route handler received req.user', r.status === 200 && r.body?.user !== null,
    '200 + user object', r.status + ' + ' + String(r.body?.user));
});

await testAsync('3.4.7.2', '', async () => {
  console.log('  Checking req.user.sub — the unique identifier for this user');
  console.log('  Route handlers use sub to determine who performed an action');
  var token = await helper.signToken({ sub: 'user_001', email: 'admin@company.com', name: 'Admin' });
  var r = await GET('/test/echo-user', token);
  check('req.user.sub is user_001', r.body?.user?.sub === 'user_001',
    'user_001', String(r.body?.user?.sub));
});

await testAsync('3.4.7.3', '', async () => {
  console.log('  Checking req.user.email — used for notifications and display');
  var token = await helper.signToken({ sub: 'user_001', email: 'admin@company.com', name: 'Admin' });
  var r = await GET('/test/echo-user', token);
  check('req.user.email is admin@company.com', r.body?.user?.email === 'admin@company.com',
    'admin@company.com', String(r.body?.user?.email));
});

await testAsync('3.4.7.4', '', async () => {
  console.log('  Checking req.user.name — displayed in the dashboard UI');
  var token = await helper.signToken({ sub: 'user_001', email: 'admin@company.com', name: 'Admin' });
  var r = await GET('/test/echo-user', token);
  check('req.user.name is Admin', r.body?.user?.name === 'Admin',
    'Admin', String(r.body?.user?.name));
});

await testAsync('3.4.7.5', '', async () => {
  console.log('  Checking req.authProvider — identifies which IDP authenticated the user');
  console.log('  When multiple providers are active, this tells you which one was used');
  var token = await helper.signToken({ sub: 'user_001' });
  var r = await GET('/test/echo-user', token);
  check('req.authProvider is mock', r.body?.authProvider === 'mock',
    'mock', String(r.body?.authProvider));
});

await testAsync('3.4.7.6', '', async () => {
  console.log('  Checking req.user.issuer — the iss claim from the token');
  console.log('  Used to validate which Auth0 tenant issued the token');
  var token = await helper.signToken({ sub: 'user_001' });
  var r = await GET('/test/echo-user', token);
  check('req.user.issuer is https://mock-auth.test/',
    r.body?.user?.issuer === 'https://mock-auth.test/',
    'https://mock-auth.test/', String(r.body?.user?.issuer));
});

await testAsync('3.4.7.7', '', async () => {
  console.log('  Checking req.user.expiresAt — when the token expires');
  console.log('  Route handlers may use this to warn users about approaching session expiry');
  var token = await helper.signToken({ sub: 'user_001' });
  var r = await GET('/test/echo-user', token);
  check('req.user.expiresAt is present',
    r.body?.user?.expiresAt !== null && r.body?.user?.expiresAt !== undefined,
    'non-null', String(r.body?.user?.expiresAt));
});

await testAsync('3.4.7.8', '', async () => {
  console.log('  Checking req.user.raw — the full decoded JWT payload');
  console.log('  Route handlers may need access to custom claims not in the standard fields');
  var token = await helper.signToken({ sub: 'user_001', customField: 'customValue' });
  var r = await GET('/test/echo-user', token);
  check('req.user.raw contains full payload',
    r.body?.user?.raw?.customField === 'customValue',
    'customValue', String(r.body?.user?.raw?.customField));
});

await testAsync('3.4.7.9', '', async () => {
  console.log('  optionalAuth route with valid token — user should be attached');
  var token = await helper.signToken({ sub: 'optional_user' });
  var r = await GET('/test/optional-user', token);
  check('Optional route has user with valid token',
    r.body?.user?.sub === 'optional_user',
    'optional_user', String(r.body?.user?.sub));
});

await testAsync('3.4.7.10', '', async () => {
  console.log('  optionalAuth route with no token — user should be null, not 401');
  var r = await GET('/test/optional-user');
  check('Optional route has null user without token',
    r.status === 200 && r.body?.user === null,
    '200 + null user', r.status + ' + ' + String(r.body?.user));
});

await testAsync('3.4.7.11', '', async () => {
  console.log('  optionalAuth route with bad token — user should be null, not 401');
  console.log('  Public-optional endpoints must never reject — they degrade gracefully');
  var r = await GET('/test/optional-user', 'garbage.token.here');
  check('Optional route handles bad token gracefully',
    r.status === 200 && r.body?.user === null,
    '200 + null user', r.status + ' + ' + String(r.body?.user));
});

await testAsync('3.4.7.12', '', async () => {
  console.log('  Two different users — verify the middleware is not caching user identity');
  console.log('  If middleware caches, the second request gets the first user\'s identity');
  var token1 = await helper.signToken({ sub: 'user_alice', name: 'Alice' });
  var token2 = await helper.signToken({ sub: 'user_bob', name: 'Bob' });
  var r1 = await GET('/test/echo-user', token1);
  var r2 = await GET('/test/echo-user', token2);
  check('First request is Alice', r1.body?.user?.sub === 'user_alice',
    'user_alice', String(r1.body?.user?.sub));
  check('Second request is Bob', r2.body?.user?.sub === 'user_bob',
    'user_bob', String(r2.body?.user?.sub));
});

var after7 = getCounters();
groupEnd(after7.pass - before7.pass, after7.fail - before7.fail);

// ── Cleanup ──────────────────────────────────────────────────
server.close();
await helper.close();
clearJwksCache();
delete process.env.MOCK_AUTH_ENABLED;

var summary = getCounters();
process.exit(summary.fail);
