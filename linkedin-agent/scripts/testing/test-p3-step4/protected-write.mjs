// ═══════════════════════════════════════════════════════════════
// Step 4 Groups 3, 4: Protected Write Routes
// POST endpoints reject unauthenticated, accept authenticated
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

async function POST(path, token, body) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var res = await fetch(BASE + path, {
    method: 'POST', headers,
    body: body ? JSON.stringify(body) : '{}'
  });
  var resBody;
  try { resBody = await res.json(); } catch { resBody = null; }
  return { status: res.status, body: resBody };
}

var validToken = await helper.signToken({ sub: 'test_user', email: 'test@example.com' });

// ── Protected POST routes ────────────────────────────────────

var protectedPosts = [
  ['/api/posts/1/approve', 'Approve a pending post — publishes to LinkedIn'],
  ['/api/posts/1/reject', 'Reject a pending post — discards draft'],
  ['/api/mode', 'Switch agent mode — changes auto/manual publishing'],
  ['/api/pause', 'Pause the agent — stops all content generation'],
  ['/api/corroboration', 'Update corroboration settings — affects research quality'],
  ['/api/generate-preview', 'Generate content preview — consumes Anthropic API credits'],
  ['/api/save-preview', 'Save a preview — commits draft to the post queue'],
  ['/api/force-cycle', 'Force a generation cycle — immediate content creation'],
  ['/api/research/poll', 'Trigger RSS poll — fetches external articles']
];

// ── Group 3: Protected POST routes reject without token ──────

console.log('  File: test-p3-step4/protected-write.mjs');
group('Group 3: Protected POST routes reject unauthenticated', `
  If these tests fail, anyone can approve posts to LinkedIn,
  change the agent's operating mode, trigger content generation,
  and consume API credits — all without logging in.
`);

var before3 = getCounters();

for (var [idx, entry] of protectedPosts.entries()) {
  var path = entry[0];
  var desc = entry[1];
  await testAsync('3.4.3.' + (idx + 1), '', async () => {
    console.log('  POST ' + path + ' — no Authorization header');
    console.log('  ' + desc);
    console.log('  This is a write operation — unauthenticated access is especially dangerous');
    var r = await POST(path);
    check(path + ' returns 401', r.status === 401, '401', String(r.status));
  });
}

await testAsync('3.4.3.10', ' Verifying POST 401 response includes error message', async () => {
  console.log('  Verifying POST 401 response includes error message');
  console.log('  Write endpoints should give the same error as read endpoints');
  var r = await POST('/api/mode');
  check('Error message present', r.body?.error !== undefined, 'error field', 'no error field');
});

await testAsync('3.4.3.11', ' Verifying the request body was NOT processed', async () => {
  console.log('  Verifying the request body was NOT processed');
  console.log('  If the route handler runs before auth middleware, side effects occur');
  console.log('  Sending mode=auto to /api/mode — must be rejected before handler');
  var r = await POST('/api/mode', null, { mode: 'auto' });
  check('Body not processed (401 returned)', r.status === 401, '401', String(r.status));
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Group 4: Protected POST routes accept valid token ────────

console.log('  File: test-p3-step4/protected-write.mjs');
group('Group 4: Protected POST routes accept authenticated requests', `
  If these tests fail, authenticated users cannot operate the
  agent. Login works but the dashboard cannot approve posts,
  change settings, or trigger actions.
`);

var before4 = getCounters();

for (var [idx2, entry2] of protectedPosts.entries()) {
  var path2 = entry2[0];
  var desc2 = entry2[1];
  await testAsync('3.4.4.' + (idx2 + 1), '', async () => {
    console.log('  POST ' + path2 + ' — with valid Bearer token');
    console.log('  ' + desc2);
    console.log('  Authenticated request should reach the route handler');
    console.log('  The handler may return 400/404/500 depending on data state — that is OK');
    console.log('  What matters: it does NOT return 401 (auth rejection)');
    var r = await POST(path2, validToken);
    check(path2 + ' does not return 401', r.status !== 401, 'not 401', String(r.status));
  });
}

await testAsync('3.4.4.10', ' Verifying POST with token and valid body reaches the handler', async () => {
  console.log('  Verifying POST with token and valid body reaches the handler');
  console.log('  Sending mode change — the handler may reject the value but auth passes');
  var r = await POST('/api/mode', validToken, { mode: 'manual' });
  check('/api/mode body processed (not 401)', r.status !== 401, 'not 401', String(r.status));
});

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Cleanup ──────────────────────────────────────────────────
server.close();
await helper.close();
clearJwksCache();
delete process.env.MOCK_AUTH_ENABLED;

var summary = getCounters();
process.exit(summary.fail);
