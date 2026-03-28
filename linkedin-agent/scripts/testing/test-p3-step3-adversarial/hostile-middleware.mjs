// ═══════════════════════════════════════════════════════════════
// Step 3 Adversarial Groups 4, 5, 6: Hostile Middleware
// Middleware bypass + error leakage + JWKS endpoint abuse
// ═══════════════════════════════════════════════════════════════

import http from 'node:http';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { verifyToken, clearJwksCache } from '../../../src/auth/jwt-verifier.js';
import { _resetForTesting, initRegistry, getProviders, _patchSnapshotForTesting } from '../../../src/auth/index.js';
import { createAuthMiddleware } from '../../../src/auth/middleware.js';

function mReq(headers, extras) {
  extras = extras || {};
  return { headers: headers || {}, path: '/api/test', query: extras.query || {}, cookies: extras.cookies || {} };
}
function mRes() {
  var _s = null, _j = null;
  return { status(s) { _s = s; return this; }, json(j) { _j = j; return this; }, getStatus() { return _s; }, getJson() { return _j; } };
}

// ── Group 4: Middleware bypass attempts ───────────────────────

group('Group 4: Middleware bypass attempts', `
  If the middleware can be bypassed through header tricks, case
  sensitivity, or token placement in cookies, authentication is
  decorative. Protected endpoints are accessible to anyone.
`);

var before4 = getCounters();
var helper = await createTestJWKS({ issuer: 'https://mock-auth.test/' });
_resetForTesting(); process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
var mp = getProviders().find(p => p.name === 'mock');
Object.defineProperty(mp, 'jwksUri', { get: () => helper.jwksUri, configurable: true });
Object.defineProperty(mp, 'audience', { get: () => helper.audience, configurable: true });
_patchSnapshotForTesting('mock', { jwksUri: helper.jwksUri, audience: helper.audience });
var { requireAuth } = createAuthMiddleware(() => {});
var vt = await helper.signToken({ sub: 'user1' });

async function expectBlock(label, req) {
  var res = mRes(); var next = false;
  await requireAuth(req, res, () => { next = true; });
  check(label, !next && res.getStatus() === 401, 'blocked 401', 'next=' + next + ' status=' + res.getStatus());
}
async function expectPass(label, req) {
  var res = mRes(); var next = false;
  await requireAuth(req, res, () => { next = true; });
  check(label, next && req.user?.sub, 'pass + user', 'next=' + next + ' sub=' + String(req.user?.sub));
}

await testAsync('3.3.4.1-A', '', async () => { await expectPass('Bearer correct case', mReq({ authorization: 'Bearer ' + vt })); });
await testAsync('3.3.4.2-A', '', async () => { await expectPass('bearer lowercase', mReq({ authorization: 'bearer ' + vt })); });
await testAsync('3.3.4.3-A', '', async () => { await expectPass('BEARER uppercase', mReq({ authorization: 'BEARER ' + vt })); });

await testAsync('3.3.4.4-A', '', async () => {
  console.log('  Double space after Bearer — split produces 3 parts');
  await expectBlock('Double space', mReq({ authorization: 'Bearer  ' + vt }));
});
await testAsync('3.3.4.5-A', '', async () => { await expectBlock('Leading space', mReq({ authorization: ' Bearer ' + vt })); });
await testAsync('3.3.4.6-A', '', async () => { await expectBlock('Basic scheme', mReq({ authorization: 'Basic ' + vt })); });
await testAsync('3.3.4.7-A', '', async () => { await expectBlock('Token scheme', mReq({ authorization: 'Token ' + vt })); });
await testAsync('3.3.4.8-A', '', async () => { await expectBlock('MAC scheme', mReq({ authorization: 'MAC ' + vt })); });

await testAsync('3.3.4.9-A', '', async () => {
  console.log('  Token in query string — appears in logs, history, referrer');
  await expectBlock('Query string token', mReq({}, { query: { access_token: vt } }));
});
await testAsync('3.3.4.10-A', '', async () => {
  console.log('  Token in cookie — vulnerable to CSRF');
  await expectBlock('Cookie token', mReq({}, { cookies: { access_token: vt } }));
});
await testAsync('3.3.4.11-A', '', async () => { await expectBlock('Empty bearer', mReq({ authorization: 'Bearer ' })); });
await testAsync('3.3.4.12-A', '', async () => { await expectBlock('Bearer spaces only', mReq({ authorization: 'Bearer    ' })); });

await testAsync('3.3.4.13-A', '', async () => {
  console.log('  Pre-set req.user — must be overwritten by verified token');
  var req = mReq({ authorization: 'Bearer ' + vt });
  req.user = { sub: 'pre-existing-attacker', isAdmin: true };
  var res = mRes(); var nc = false;
  await requireAuth(req, res, () => { nc = true; });
  check('Pre-set user overwritten', req.user?.sub === 'user1', 'user1', String(req.user?.sub));
});

await testAsync('3.3.4.14-A', '', async () => {
  var req = mReq({ authorization: 'Bearer ' + vt });
  req.user = { sub: 'attacker', isAdmin: true };
  var res = mRes();
  await requireAuth(req, res, () => {});
  check('Pre-set isAdmin not preserved', req.user?.isAdmin === undefined, 'undefined', String(req.user?.isAdmin));
});

await helper.close(); clearJwksCache(); delete process.env.MOCK_AUTH_ENABLED;
var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Group 5: Error response leakage ──────────────────────────

group('Group 5: Error response information leakage', `
  If different failures produce different messages, attackers
  enumerate valid tokens, identify the JWT library, and map
  internal error handling.
`);

var before5 = getCounters();
var helper5 = await createTestJWKS({ issuer: 'https://mock-auth.test/' });
_resetForTesting(); process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
var mp5 = getProviders().find(p => p.name === 'mock');
Object.defineProperty(mp5, 'jwksUri', { get: () => helper5.jwksUri, configurable: true });
Object.defineProperty(mp5, 'audience', { get: () => helper5.audience, configurable: true });
_patchSnapshotForTesting('mock', { jwksUri: helper5.jwksUri, audience: helper5.audience });
var { requireAuth: reqAuth5 } = createAuthMiddleware(() => {});

var scenarios = [
  ['No header', {}],
  ['Fabricated', { authorization: 'Bearer ' + helper5.fabricateToken() }],
  ['Expired', { authorization: 'Bearer ' + (await helper5.signExpiredToken()) }],
  ['Wrong issuer', { authorization: 'Bearer ' + (await helper5.signToken({}, { issuer: 'https://other.com/' })) }],
  ['Garbage', { authorization: 'Bearer not-a-jwt' }],
  ['Empty bearer', { authorization: 'Bearer ' }]
];
var responses = [];
for (var [label, headers] of scenarios) {
  var res = mRes();
  await reqAuth5(mReq(headers), res, () => {});
  responses.push({ label, status: res.getStatus(), json: res.getJson() });
}

test('3.3.5.1-A', '', () => {
  console.log('  All 6 scenarios must return 401 — no 403/500 leakage');
  check('All return 401', responses.every(r => r.status === 401), 'all 401', responses.map(r => r.label + '=' + r.status).join(', '));
});

for (var [idx, r] of responses.entries()) {
  var j = JSON.stringify(r.json || {});
  test('3.3.5.' + (2 + idx * 3) + '-A', '', () => {
    check(r.label + ' — no stack traces', !j.includes('at ') && !j.includes('.js:'), 'no traces', j.substring(0, 60));
  });
  test('3.3.5.' + (3 + idx * 3) + '-A', '', () => {
    check(r.label + ' — no jose refs', !j.includes('JWS') && !j.includes('JWK') && !j.includes('jose'), 'no jose', j.substring(0, 60));
  });
  test('3.3.5.' + (4 + idx * 3) + '-A', '', () => {
    check(r.label + ' — no paths', !j.includes('/src/') && !j.includes('node_modules'), 'no paths', j.substring(0, 60));
  });
}

await helper5.close(); clearJwksCache(); delete process.env.MOCK_AUTH_ENABLED;
var after5 = getCounters();
groupEnd(after5.pass - before5.pass, after5.fail - before5.fail);

// ── Group 6: JWKS endpoint abuse ─────────────────────────────

group('Group 6: JWKS endpoint abuse', `
  If a compromised JWKS endpoint returns empty keys or errors
  and the verifier fails open, every token passes. If it crashes,
  every request 500s.
`);

var before6 = getCounters();
var helper6 = await createTestJWKS();
var validToken = await helper6.signToken({ sub: 'user1' });

await testAsync('3.3.6.1-A', '', async () => {
  console.log('  JWKS returns {keys:[]} — valid JSON but zero keys');
  var srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ keys: [] })); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  clearJwksCache();
  try { await verifyToken(validToken, helper6.issuer, 'http://127.0.0.1:' + srv.address().port + '/.well-known/jwks.json', helper6.audience); check('Empty JWKS rejects', false, 'rejected', 'accepted'); }
  catch (e) { check('Empty JWKS rejects → ' + e.message, true, 'rejected', 'rejected'); }
  srv.close();
});

await testAsync('3.3.6.2-A', '', async () => {
  console.log('  JWKS returns non-JSON garbage');
  var srv = http.createServer((q, r) => { r.writeHead(200); r.end('not json'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  clearJwksCache();
  try { await verifyToken(validToken, helper6.issuer, 'http://127.0.0.1:' + srv.address().port + '/.well-known/jwks.json', helper6.audience); check('Malformed JWKS rejects', false, 'rejected', 'accepted'); }
  catch (e) { check('Malformed JWKS rejects → ' + e.message, true, 'rejected', 'rejected'); }
  srv.close();
});

await testAsync('3.3.6.3-A', '', async () => {
  console.log('  JWKS returns HTTP 500');
  var srv = http.createServer((q, r) => { r.writeHead(500); r.end('Internal Server Error'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  clearJwksCache();
  try { await verifyToken(validToken, helper6.issuer, 'http://127.0.0.1:' + srv.address().port + '/.well-known/jwks.json', helper6.audience); check('500 JWKS rejects', false, 'rejected', 'accepted'); }
  catch (e) { check('500 JWKS rejects → ' + e.message, true, 'rejected', 'rejected'); }
  srv.close();
});

await testAsync('3.3.6.4-A', '', async () => {
  console.log('  JWKS endpoint unreachable (connection refused)');
  clearJwksCache();
  try { await verifyToken(validToken, helper6.issuer, 'http://127.0.0.1:1/.well-known/jwks.json', helper6.audience); check('Unreachable rejects', false, 'rejected', 'accepted'); }
  catch (e) { check('Unreachable rejects → ' + e.message, true, 'rejected', 'rejected'); }
});

await helper6.close(); clearJwksCache();
var after6 = getCounters();
groupEnd(after6.pass - before6.pass, after6.fail - before6.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
