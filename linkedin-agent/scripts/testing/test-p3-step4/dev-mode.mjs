// ═══════════════════════════════════════════════════════════════
// Step 4 Group 6: Dev Mode Passthrough
// All routes accessible when zero auth providers are configured
//
// A developer who clones the repo and runs the app without Auth0
// credentials needs every endpoint to work. If any route returns
// 401 when no providers are configured, local development is
// broken and the developer's first experience is a wall of errors.
// ═══════════════════════════════════════════════════════════════

import http from 'node:http';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { _resetForTesting, initRegistry, isAuthEnabled } from '../../../src/auth/index.js';

// ── Setup: zero providers ────────────────────────────────────
// Clear all auth env vars so no provider activates.
// This simulates a fresh clone with no .env file.

_resetForTesting();
delete process.env.MOCK_AUTH_ENABLED;
delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;
delete process.env.NODE_ENV;
await initRegistry(() => {});

// Confirm zero providers loaded — if this fails, the entire
// group's premise is wrong and results are meaningless
if (isAuthEnabled()) {
  console.error('  FATAL: Auth is enabled with no provider env vars set.');
  console.error('  Cannot test dev mode passthrough. Check provider files.');
  process.exit(1);
}

// ── Build test Express app ───────────────────────────────────

var appModule = await import('../../../src/routes/api.js');
var express = (await import('express')).default;

var app = express();
app.use(express.json());
if (appModule.default) app.use(appModule.default);
else if (appModule.router) app.use(appModule.router);
else { console.error('  ERROR: Cannot import router from api.js'); process.exit(1); }

var server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
var BASE = 'http://127.0.0.1:' + server.address().port;

async function REQ(method, path, body) {
  var opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  else if (method === 'POST') opts.body = '{}';
  var res = await fetch(BASE + path, opts);
  return { status: res.status };
}

// ── All routes ───────────────────────────────────────────────

var allRoutes = [
  ['GET', '/api/status', 'Health check'],
  ['GET', '/api/posts', 'Post list'],
  ['GET', '/api/posts/1', 'Single post'],
  ['POST', '/api/posts/1/approve', 'Approve post'],
  ['POST', '/api/posts/1/reject', 'Reject post'],
  ['POST', '/api/mode', 'Switch agent mode'],
  ['POST', '/api/pause', 'Pause agent'],
  ['POST', '/api/corroboration', 'Corroboration settings'],
  ['POST', '/api/generate-preview', 'Generate preview'],
  ['POST', '/api/save-preview', 'Save preview'],
  ['POST', '/api/force-cycle', 'Force cycle'],
  ['GET', '/api/research/stats', 'Research stats'],
  ['GET', '/api/research/articles', 'Research articles'],
  ['POST', '/api/research/poll', 'RSS poll'],
  ['GET', '/api/logs', 'Activity logs'],
  ['GET', '/api/linkedin/status', 'LinkedIn status']
];

// ── Group 6: Dev mode — no auth provider configured ──────────

console.log('  File: test-p3-step4/dev-mode.mjs');
group('Group 6: Dev mode — all routes pass without auth', `
  If these tests fail, a developer who clones the repo and runs
  it without configuring Auth0 credentials will see 401 errors
  on every endpoint. The local development experience is broken
  before they write a single line of code.
`);

var before6 = getCounters();

for (var [idx, route] of allRoutes.entries()) {
  var method = route[0];
  var path = route[1];
  var desc = route[2];
  await testAsync('3.4.6.' + (idx + 1), '', async () => {
    console.log('  ' + method + ' ' + path + ' — no token, no auth providers');
    console.log('  ' + desc);
    console.log('  With zero providers, the middleware must pass the request through');
    console.log('  The route handler may return any status (200, 400, 404, 500)');
    console.log('  What it must NOT return: 401 (auth required) or 403 (forbidden)');
    var r = await REQ(method, path);
    check(path + ' does not return 401/403', r.status !== 401 && r.status !== 403,
      'not 401/403', String(r.status));
  });
}

await testAsync('3.4.6.17', '  a garbage Authorization header in dev mode', async () => {
  console.log('  Sending a garbage Authorization header in dev mode');
  console.log('  Even with a bad header, dev mode must not reject the request');
  console.log('  The middleware should ignore auth entirely when no providers are loaded');
  var opts = {
    method: 'GET',
    headers: { 'Authorization': 'Bearer total.garbage.here' }
  };
  var res = await fetch(BASE + '/api/posts', opts);
  check('/api/posts ignores bad token in dev mode',
    res.status !== 401 && res.status !== 403,
    'not 401/403', String(res.status));
});

await testAsync('3.4.6.18', '  no Authorization header at all to a write endpoint', async () => {
  console.log('  Sending no Authorization header at all to a write endpoint');
  console.log('  In dev mode, POST endpoints must be reachable for testing');
  var r = await REQ('POST', '/api/mode', { mode: 'manual' });
  check('/api/mode reachable in dev mode', r.status !== 401 && r.status !== 403,
    'not 401/403', String(r.status));
});

var after6 = getCounters();
groupEnd(after6.pass - before6.pass, after6.fail - before6.fail);

// ── Cleanup ──────────────────────────────────────────────────
server.close();

var summary = getCounters();
process.exit(summary.fail);
