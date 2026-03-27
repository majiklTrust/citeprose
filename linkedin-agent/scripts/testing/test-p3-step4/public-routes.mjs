// ═══════════════════════════════════════════════════════════════
// Step 4 Group 5: Public Routes
// /api/status accessible without auth + dev mode passthrough
// ═══════════════════════════════════════════════════════════════
import http from 'node:http';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { clearJwksCache } from '../../../src/auth/jwt-verifier.js';
import { _resetForTesting, initRegistry, getProviders, _patchSnapshotForTesting } from '../../../src/auth/index.js';

// ── Test server setup (auth enabled) ─────────────────────────
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

async function GET(path, token) {
  var headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var res = await fetch(BASE + path, { headers });
  var body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

var validToken = await helper.signToken({ sub: 'test_user' });

// ── Group 5: Public routes remain accessible ─────────────────
group('Group 5: Public routes remain accessible', `
  If these tests fail, load balancers and uptime monitors
  cannot reach the health check. Automated infrastructure
  reports the application as down even when it is running.
`);

var before5 = getCounters();

await testAsync('3.4.5.1', '', async () => {
  console.log('  GET /api/status — no Authorization header');
  console.log('  This is the only public route. Load balancers poll it every 30 seconds');
  console.log('  If it requires auth, the balancer marks the app as unhealthy');
  var r = await GET('/api/status');
  check('/api/status accessible without token', r.status !== 401 && r.status !== 403,
    'not 401/403', String(r.status));
});

await testAsync('3.4.5.2', '', async () => {
  console.log('  GET /api/status — should not return an auth error');
  console.log('  The handler may return 500 if the database is not initialized in tests');
  console.log('  What matters: the request was not blocked by auth (not 401/403)');
  var r = await GET('/api/status');
  check('/api/status not blocked by auth', r.status !== 401 && r.status !== 403,
    'not 401/403', String(r.status));
});

await testAsync('3.4.5.3', '', async () => {
  console.log('  GET /api/status — response body should contain status information');
  console.log('  The health check needs to return something meaningful, not an empty response');
  var r = await GET('/api/status');
  check('Response has body', r.body !== null, 'JSON body', 'null');
});

await testAsync('3.4.5.4', '', async () => {
  console.log('  GET /api/status — with a valid token should also work');
  console.log('  A public route must accept both authenticated and anonymous requests');
  console.log('  The handler may return 500 without a database — auth pass-through is the test');
  var r = await GET('/api/status', validToken);
  check('/api/status not blocked with token', r.status !== 401 && r.status !== 403,
    'not 401/403', String(r.status));
});

await testAsync('3.4.5.5', '', async () => {
  console.log('  GET /api/status — with an INVALID token should still work');
  console.log('  The route is public. A bad token should not cause a 401 on a public endpoint');
  var r = await GET('/api/status', 'this.is.garbage');
  check('/api/status ignores bad token', r.status !== 401, 'not 401', String(r.status));
});

await testAsync('3.4.5.6', '', async () => {
  console.log('  Verifying that a protected route on the same server still requires auth');
  console.log('  This confirms the public exception is route-specific, not server-wide');
  var r = await GET('/api/posts');
  check('/api/posts still requires auth', r.status === 401, '401', String(r.status));
});

var after5 = getCounters();
groupEnd(after5.pass - before5.pass, after5.fail - before5.fail);

// ── Cleanup ──────────────────────────────────────────────────
server.close();
await helper.close();
clearJwksCache();
delete process.env.MOCK_AUTH_ENABLED;

var summary = getCounters();
process.exit(summary.fail);
