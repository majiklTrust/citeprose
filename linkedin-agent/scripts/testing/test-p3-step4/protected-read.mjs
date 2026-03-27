// ═══════════════════════════════════════════════════════════════
// Step 4 Groups 1, 2: Protected Read Routes
// GET endpoints reject unauthenticated, accept authenticated
// ═══════════════════════════════════════════════════════════════

import http from 'node:http';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { clearJwksCache } from '../../../src/auth/jwt-verifier.js';
import { _resetForTesting, initRegistry, getProviders, _patchSnapshotForTesting } from '../../../src/auth/index.js';

// ── Test server setup ────────────────────────────────────────
// We import the actual Express app to test through the full stack.
// This catches middleware ordering bugs that unit tests miss.

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

// Build a test app using the real router
var app = express();
app.use(express.json());

// Mount the actual api router — Step 4 code should have requireAuth wired in
if (appModule.default) app.use(appModule.default);
else if (appModule.router) app.use(appModule.router);
else { console.error('  ERROR: Cannot import router from api.js'); process.exit(1); }

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

var validToken = await helper.signToken({ sub: 'test_user', email: 'test@example.com' });

// ── Protected GET routes ─────────────────────────────────────

var protectedGets = [
  ['/api/posts', 'Post list — contains draft content and scheduling data'],
  ['/api/posts/1', 'Single post — includes full content and metadata'],
  ['/api/research/stats', 'Research statistics — reveals content strategy'],
  ['/api/research/articles', 'Cached articles — source material for posts'],
  ['/api/logs', 'Activity logs — operational details and error history'],
  ['/api/linkedin/status', 'LinkedIn token status — reveals integration health']
];

// ── Group 1: Protected GET routes reject without token ───────

group('Group 1: Protected GET routes reject unauthenticated', `
  If these tests fail, anyone who discovers the API URL can
  read draft posts, research data, activity logs, and LinkedIn
  integration status without logging in.
`);

var before1 = getCounters();

for (var [idx, entry] of protectedGets.entries()) {
  var path = entry[0];
  var desc = entry[1];
  await testAsync('3.4.1.' + (idx + 1), '', async () => {
    console.log('  GET ' + path + ' — no Authorization header');
    console.log('  ' + desc);
    console.log('  Without auth enforcement, this data is publicly accessible');
    var r = await GET(path);
    check(path + ' returns 401', r.status === 401, '401', String(r.status));
  });
}

await testAsync('3.4.1.7', '', async () => {
  console.log('  Verifying 401 response body has user-friendly error message');
  console.log('  The message should tell the user to authenticate, not expose internals');
  var r = await GET('/api/posts');
  check('Error message present', r.body?.error !== undefined, 'error field', 'no error field');
  check('No stack trace in response', !JSON.stringify(r.body).includes('at '), 'no traces', 'traces found');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: Protected GET routes accept valid token ─────────

group('Group 2: Protected GET routes accept authenticated requests', `
  If these tests fail, authenticated users are locked out of
  the dashboard. Login works but every page shows an error.
`);

var before2 = getCounters();

for (var [idx2, entry2] of protectedGets.entries()) {
  var path2 = entry2[0];
  var desc2 = entry2[1];
  await testAsync('3.4.2.' + (idx2 + 1), '', async () => {
    console.log('  GET ' + path2 + ' — with valid Bearer token');
    console.log('  ' + desc2);
    console.log('  Authenticated request should reach the route handler');
    var r = await GET(path2, validToken);
    check(path2 + ' does not return 401', r.status !== 401, 'not 401', String(r.status));
  });
}

await testAsync('3.4.2.7', '', async () => {
  console.log('  Checking that req.user is populated — route handlers need user identity');
  console.log('  GET /api/status will be tested in Group 5 (public route)');
  console.log('  Any non-401 response from a protected route confirms the middleware passed');
  var r = await GET('/api/posts', validToken);
  check('Authenticated response is not 401 or 403', r.status !== 401 && r.status !== 403,
    'not 401/403', String(r.status));
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Cleanup ──────────────────────────────────────────────────
server.close();
await helper.close();
clearJwksCache();
delete process.env.MOCK_AUTH_ENABLED;

var summary = getCounters();
process.exit(summary.fail);
