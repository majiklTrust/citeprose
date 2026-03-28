// ═══════════════════════════════════════════════════════════════
// Step 3 Groups 3, 4, 5: Middleware Auth
// requireAuth (enabled) + dev mode + optionalAuth
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { clearJwksCache } from '../../../src/auth/jwt-verifier.js';
import { _resetForTesting, initRegistry, getProviders, _patchSnapshotForTesting } from '../../../src/auth/index.js';
import { createAuthMiddleware } from '../../../src/auth/middleware.js';

function mReq(headers) { return { headers: headers || {}, path: '/api/test' }; }
function mRes() {
  var _s = null, _j = null;
  return { status(s) { _s = s; return this; }, json(j) { _j = j; return this; }, getStatus() { return _s; }, getJson() { return _j; } };
}

// ── Group 3: requireAuth with auth enabled ───────────────────

console.log('  File: test-p3-step3/middleware-auth.mjs');
group('Group 3: Middleware — requireAuth blocks unauthorized', `
  If these tests fail, API endpoints are accessible without
  authentication. Anyone who discovers the URL can read data,
  publish to LinkedIn, and exhaust API credits.
`);

var before3 = getCounters();
var helper = await createTestJWKS({ issuer: 'https://mock-auth.test/' });
_resetForTesting(); process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
var mp = getProviders().find(p => p.name === 'mock');
Object.defineProperty(mp, 'jwksUri', { get: () => helper.jwksUri, configurable: true });
Object.defineProperty(mp, 'audience', { get: () => helper.audience, configurable: true });
_patchSnapshotForTesting('mock', { jwksUri: helper.jwksUri, audience: helper.audience });
var { requireAuth } = createAuthMiddleware(() => {});

await testAsync('3.3.3.1', '  request with valid Bearer token', async () => {
  console.log('  Sending request with valid Bearer token');
  var token = await helper.signToken({ sub: 'user1', email: 'u@test.com' });
  var req = mReq({ authorization: 'Bearer ' + token }); var res = mRes(); var nc = false;
  await requireAuth(req, res, () => { nc = true; });
  check('Valid token — request passes', nc, 'next() called', 'blocked');
  check('User identity attached', req.user?.sub === 'user1', 'user1', String(req.user?.sub));
  check('User email attached', req.user?.email === 'u@test.com', 'u@test.com', String(req.user?.email));
  check('Auth provider identified', req.authProvider === 'mock', 'mock', String(req.authProvider));
});

await testAsync('3.3.3.5', ' No Authorization header', async () => {
  console.log('  No Authorization header');
  var req = mReq({}); var res = mRes(); var nc = false;
  await requireAuth(req, res, () => { nc = true; });
  check('No header — blocked', !nc, 'blocked', 'allowed');
  check('Returns 401', res.getStatus() === 401, '401', String(res.getStatus()));
  check('User-friendly message', res.getJson()?.error === 'Authentication required.', 'Authentication required.', res.getJson()?.error);
});

await testAsync('3.3.3.8', ' Malformed Authorization header', async () => {
  console.log('  Malformed Authorization header');
  var req = mReq({ authorization: 'NotBearer token' }); var res = mRes(); var nc = false;
  await requireAuth(req, res, () => { nc = true; });
  check('Malformed — blocked', !nc, 'blocked', 'allowed');
  check('Returns 401', res.getStatus() === 401, '401', String(res.getStatus()));
});

await testAsync('3.3.3.11', ' Expired token — valid signature but past exp', async () => {
  console.log('  Expired token — valid signature but past exp');
  var expired = await helper.signExpiredToken();
  var req = mReq({ authorization: 'Bearer ' + expired }); var res = mRes(); var nc = false;
  await requireAuth(req, res, () => { nc = true; });
  check('Expired — blocked', !nc, 'blocked', 'allowed');
  check('Re-login message', res.getJson()?.error === 'Token expired. Please log in again.', 'Token expired...', res.getJson()?.error);
});

await testAsync('3.3.3.14', ' Fabricated signature', async () => {
  console.log('  Fabricated signature');
  var fake = helper.fabricateToken();
  var req = mReq({ authorization: 'Bearer ' + fake }); var res = mRes(); var nc = false;
  await requireAuth(req, res, () => { nc = true; });
  check('Forged — blocked', !nc, 'blocked', 'allowed');
  check('Generic message', res.getJson()?.error === 'Invalid token.', 'Invalid token.', res.getJson()?.error);
});

await testAsync('3.3.3.17', ' Token with unknown issuer', async () => {
  console.log('  Token with unknown issuer');
  var wrongIss = await helper.signToken({}, { issuer: 'https://unknown.com/' });
  var req = mReq({ authorization: 'Bearer ' + wrongIss }); var res = mRes(); var nc = false;
  await requireAuth(req, res, () => { nc = true; });
  check('Unknown issuer — blocked', !nc, 'blocked', 'allowed');
  check('Safe message', res.getJson()?.error === 'Token issuer not recognized.', 'Token issuer not recognized.', res.getJson()?.error);
});

await testAsync('3.3.3.20', ' Garbage token', async () => {
  console.log('  Garbage token');
  var req = mReq({ authorization: 'Bearer totalnonsense' }); var res = mRes(); var nc = false;
  await requireAuth(req, res, () => { nc = true; });
  check('Garbage — blocked', !nc, 'blocked', 'allowed');
  check('Returns 401', res.getStatus() === 401, '401', String(res.getStatus()));
});

await helper.close(); clearJwksCache(); delete process.env.MOCK_AUTH_ENABLED;
var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Group 4: requireAuth — dev mode ──────────────────────────

console.log('  File: test-p3-step3/middleware-auth.mjs');
group('Group 4: Middleware — dev mode passthrough', `
  If these tests fail, developers cannot test API endpoints
  locally without Auth0 credentials — destroying velocity.
`);

var before4 = getCounters();
_resetForTesting(); delete process.env.MOCK_AUTH_ENABLED; delete process.env.AUTH0_DOMAIN;
await initRegistry(() => {});
var { requireAuth: reqDev } = createAuthMiddleware(() => {});

await testAsync('3.3.4.1', ' No providers — sending request without token', async () => {
  console.log('  No providers — sending request without token');
  var req = mReq({}); var res = mRes(); var nc = false;
  await reqDev(req, res, () => { nc = true; });
  check('Passes through in dev mode', nc, 'next() called', 'blocked');
  check('User is null', req.user === null, 'null', String(req.user));
  check('authSkipped flag set', req.authSkipped === true, 'true', String(req.authSkipped));
});

await testAsync('3.3.4.4', ' Garbage token in dev mode — should still pass', async () => {
  console.log('  Garbage token in dev mode — should still pass');
  var req = mReq({ authorization: 'Bearer garbage' }); var res = mRes(); var nc = false;
  await reqDev(req, res, () => { nc = true; });
  check('Bad token passes in dev mode', nc, 'next() called', 'blocked');
  check('authSkipped set', req.authSkipped === true, 'true', String(req.authSkipped));
});

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Group 5: optionalAuth ────────────────────────────────────

console.log('  File: test-p3-step3/middleware-auth.mjs');
group('Group 5: Middleware — optionalAuth', `
  If these tests fail, public endpoints that should work for
  both logged-in and anonymous users either block everyone
  or crash on invalid tokens.
`);

var before5 = getCounters();
var helper5 = await createTestJWKS({ issuer: 'https://mock-auth.test/' });
_resetForTesting(); process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
var mp5 = getProviders().find(p => p.name === 'mock');
Object.defineProperty(mp5, 'jwksUri', { get: () => helper5.jwksUri, configurable: true });
Object.defineProperty(mp5, 'audience', { get: () => helper5.audience, configurable: true });
_patchSnapshotForTesting('mock', { jwksUri: helper5.jwksUri, audience: helper5.audience });
var { optionalAuth } = createAuthMiddleware(() => {});

await testAsync('3.3.5.1', ' Valid token — user attached', async () => {
  var token = await helper5.signToken({ sub: 'opt_user' });
  var req = mReq({ authorization: 'Bearer ' + token }); var res = mRes(); var nc = false;
  await optionalAuth(req, res, () => { nc = true; });
  check('Valid token — user attached', nc && req.user?.sub === 'opt_user', 'next + sub=opt_user', 'next=' + nc + ' sub=' + String(req.user?.sub));
});

await testAsync('3.3.5.2', ' No token — passes with null user', async () => {
  var req = mReq({}); var res = mRes(); var nc = false;
  await optionalAuth(req, res, () => { nc = true; });
  check('No token — passes with null user', nc && req.user === null, 'next + null', 'next=' + nc + ' user=' + String(req.user));
});

await testAsync('3.3.5.3', ' Bad token — passes silently, no error response', async () => {
  console.log('  Bad token — passes silently, no error response');
  var req = mReq({ authorization: 'Bearer bad' }); var res = mRes(); var nc = false;
  await optionalAuth(req, res, () => { nc = true; });
  check('Bad token passes silently', nc && req.user === null, 'next + null', 'next=' + nc + ' user=' + String(req.user));
  check('No error status', res.getStatus() === null, 'no status', String(res.getStatus()));
});

await testAsync('3.3.5.5', ' Expired passes silently', async () => {
  var expired = await helper5.signExpiredToken();
  var req = mReq({ authorization: 'Bearer ' + expired }); var res = mRes(); var nc = false;
  await optionalAuth(req, res, () => { nc = true; });
  check('Expired passes silently', nc && req.user === null, 'next + null', 'next=' + nc + ' user=' + String(req.user));
});

await helper5.close(); clearJwksCache(); delete process.env.MOCK_AUTH_ENABLED;
var after5 = getCounters();
groupEnd(after5.pass - before5.pass, after5.fail - before5.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
