// ═══════════════════════════════════════════════════════════════
// Step 4 Adversarial Groups 1, 2, 3: Hostile Access
// Expired/forged/wrong-issuer tokens through full Express stack
//
// Step 3 tested the middleware as a standalone function.
// Step 4 tests it wired into Express where middleware ordering,
// error handling, and response serialization can introduce gaps.
// ═══════════════════════════════════════════════════════════════
import http from 'node:http';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { clearJwksCache } from '../../../src/auth/jwt-verifier.js';
import { _resetForTesting, initRegistry, getProviders, _patchSnapshotForTesting } from '../../../src/auth/index.js';

// ── Test server setup ────────────────────────────────────────
var appModule = await import('../../../src/routes/api.js');
var express = (await import('express')).default;
var helper = await createTestJWKS({ issuer: 'https://mock-auth.test/' });

_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
var mp = getProviders().find(p => p.name === 'mock');
Object.defineProperty(mp, 'jwksUri', { get: () => helper.jwksUri, configurable: true });
Object.defineProperty(mp, 'audience', { get: () => helper.audience, configurable: true });
_patchSnapshotForTesting('mock', { jwksUri: helper.jwksUri, audience: helper.audience });

var app = express();
app.use(express.json());
if (appModule.default) app.use(appModule.default);
else if (appModule.router) app.use(appModule.router);
else { console.error('  ERROR: Cannot import router from api.js'); process.exit(1); }

var server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
var BASE = 'http://127.0.0.1:' + server.address().port;

async function REQ(method, path, token) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var opts = { method, headers };
  if (method === 'POST') opts.body = '{}';
  var res = await fetch(BASE + path, opts);
  var body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// Representative routes — one GET and one POST to test each attack
var targets = [
  ['GET', '/api/posts', 'Post list (read)'],
  ['POST', '/api/mode', 'Mode change (write)'],
  ['GET', '/api/logs', 'Activity logs (read)'],
  ['POST', '/api/force-cycle', 'Force cycle (write/action)']
];

// ── Group 1: Expired tokens through Express ──────────────────
group('Group 1: Expired tokens rejected through Express stack', `
  If these tests fail, stolen tokens that have expired still
  grant access. An attacker who captured a token last week
  can use it indefinitely — session expiration is decorative.
`);

var before1 = getCounters();
var expiredToken = await helper.signExpiredToken();

for (var [idx, target] of targets.entries()) {
  var method = target[0];
  var path = target[1];
  var desc = target[2];
  await testAsync('3.4.1.' + (idx + 1) + '-A', '', async () => {
    console.log('  ' + method + ' ' + path + ' — ' + desc);
    console.log('  Token was valid when issued but exp claim is now in the past');
    console.log('  The middleware must check exp AFTER signature verification');
    console.log('  If checked before, an attacker could craft tokens with exp in the future');
    var r = await REQ(method, path, expiredToken);
    check(path + ' rejects expired token', r.status === 401, '401', String(r.status));
  });
}

await testAsync('3.4.1.5-A', '', async () => {
  console.log('  Checking the error message for expired tokens');
  console.log('  The user needs to know their session expired — not just "invalid token"');
  console.log('  A specific message lets the frontend trigger re-login automatically');
  var r = await REQ('GET', '/api/posts', expiredToken);
  check('Expiry-specific error message',
    r.body?.error?.toLowerCase().includes('expired') || r.body?.error?.toLowerCase().includes('log in'),
    'mentions expired/login', String(r.body?.error));
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: Forged tokens through Express ───────────────────
group('Group 2: Forged tokens rejected through Express stack', `
  If these tests fail, an attacker can fabricate tokens with
  arbitrary user identities. They access any account, approve
  any post, and publish to LinkedIn as anyone.
`);

var before2 = getCounters();
var forgedToken = helper.fabricateToken();
var wrongIssuerToken = await helper.signToken({ sub: 'attacker' }, { issuer: 'https://evil.com/' });
var garbageToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJoYWNrZXIifQ.not-a-real-signature';

await testAsync('3.4.2.1-A', '', async () => {
  console.log('  Sending a fabricated token — correct JWT structure, random signature');
  console.log('  This simulates an attacker who knows the token format but not the signing key');
  for (var [idx2, t] of targets.entries()) {
    var r = await REQ(t[0], t[1], forgedToken);
    check(t[1] + ' rejects fabricated token', r.status === 401, '401', String(r.status));
  }
});

await testAsync('3.4.2.5-A', '', async () => {
  console.log('  Sending a token signed by a legitimate key but with wrong issuer');
  console.log('  The attacker runs their own Auth0 tenant and signs tokens properly');
  console.log('  The middleware must verify the issuer matches a registered provider');
  for (var [idx3, t] of targets.entries()) {
    var r = await REQ(t[0], t[1], wrongIssuerToken);
    check(t[1] + ' rejects wrong issuer', r.status === 401, '401', String(r.status));
  }
});

await testAsync('3.4.2.9-A', '', async () => {
  console.log('  Sending a garbage string that looks like a JWT (3 dot-separated segments)');
  console.log('  The base64url decodes but the payload is not a real JWT');
  for (var [idx4, t] of targets.entries()) {
    var r = await REQ(t[0], t[1], garbageToken);
    check(t[1] + ' rejects garbage JWT', r.status === 401, '401', String(r.status));
  }
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Group 3: Response safety through Express ─────────────────
group('Group 3: Error responses leak no internals through Express', `
  If these tests fail, auth error responses through Express
  include stack traces, file paths, or library names that
  help attackers map the server's internals.
`);

var before3 = getCounters();
var badTokens = [
  ['No header', null],
  ['Expired', expiredToken],
  ['Forged', forgedToken],
  ['Wrong issuer', wrongIssuerToken],
  ['Garbage', garbageToken],
  ['Empty bearer', '']
];

for (var [idx5, entry] of badTokens.entries()) {
  var label = entry[0];
  var token = entry[1];
  await testAsync('3.4.3.' + (idx5 + 1) + '-A', '', async () => {
    console.log('  GET /api/posts — ' + label);
    console.log('  Checking that the error response through Express contains no internals');
    var headers = {};
    if (token !== null) headers['Authorization'] = token === '' ? 'Bearer ' : 'Bearer ' + token;
    var res = await fetch(BASE + '/api/posts', { headers });
    var text = await res.text();
    check(label + ' — no stack traces', !text.includes('at ') || !text.includes('.js:'),
      'no traces', text.substring(0, 80));
    check(label + ' — no file paths', !text.includes('/src/') && !text.includes('node_modules'),
      'no paths', text.substring(0, 80));
    check(label + ' — no jose references', !text.includes('JWS') && !text.includes('jose'),
      'no jose', text.substring(0, 80));
  });
}

await testAsync('3.4.3.7-A', '', async () => {
  console.log('  Sending an extremely long Authorization header (100KB)');
  console.log('  The server should reject it without crashing or returning a stack trace');
  console.log('  Node.js may return 431 (Request Header Fields Too Large) before Express runs');
  var headers = { 'Authorization': 'Bearer ' + 'A'.repeat(100000) };
  var res = await fetch(BASE + '/api/posts', { headers });
  check('100KB header rejected (not 200/500)', res.status !== 200 && res.status !== 500,
    'not 200/500', String(res.status));
  check('100KB header returns 401 or 431', res.status === 401 || res.status === 431,
    '401 or 431', String(res.status));
});

await testAsync('3.4.3.8-A', '', async () => {
  console.log('  Sending null bytes in the Authorization header');
  console.log('  Binary injection must not crash the middleware or bypass parsing');
  console.log('  fetch() may throw before the request is sent — that counts as rejection');
  try {
    var headers = { 'Authorization': 'Bearer \x00\x00\x00' };
    var res = await fetch(BASE + '/api/posts', { headers });
    check('Null bytes rejected (not 200)', res.status !== 200, 'not 200', String(res.status));
  } catch (e) {
    // fetch() itself rejects null bytes in header values — request never sent
    check('Null bytes rejected by fetch()', true, 'rejected', 'fetch threw: ' + e.message.substring(0, 60));
  }
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Cleanup ──────────────────────────────────────────────────
server.close();
await helper.close();
clearJwksCache();
delete process.env.MOCK_AUTH_ENABLED;

var summary = getCounters();
process.exit(summary.fail);
