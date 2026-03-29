// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 7 Adversarial: Auth Bypass and Dev Mode Attacks
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

var BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
var TIMEOUT = { signal: AbortSignal.timeout(10000) };

// Detect server mode
var statusRes = await fetch(BASE + '/api/status', TIMEOUT);
var statusJson = await statusRes.json();
var authRequired = statusJson.authRequired;

console.log('  File: test-p3-step7-adversarial/hostile-bypass.mjs');
console.log('  Server auth mode: ' + (authRequired ? 'AUTH REQUIRED' : 'DEV MODE'));
group('Group 1: Dev bypass origin manipulation', `
  Impact: If the DEV_BYPASS_ORIGINS check can be tricked, an attacker
  bypasses authentication by spoofing their origin. The bypass must
  only work when NODE_ENV is not production AND the origin matches
  the configured allowlist exactly.

  Attack surface: Origin header, X-Forwarded-For, Host header
  Defense: DEV_BYPASS_ORIGINS exact match, production mode ignores bypass
`);

var before1 = getCounters();

await testAsync('3.7.1.1-A', ' Evil origin does not trigger dev bypass', async () => {
  console.log('  Sending GET /api/posts with Origin: https://evil.com');
  console.log('  Even if dev bypass is active, it should only work for configured origins');
  console.log('  Checking: response is not 200 with data (in auth mode) or CORS blocked');
  if (!authRequired) {
    console.log('  ℹ Dev mode active — bypass is already global, testing CORS instead');
    var res = await fetch(BASE + '/api/posts', { ...TIMEOUT, headers: { 'Origin': 'https://evil.com' } });
    var acao = res.headers.get('access-control-allow-origin');
    check('Evil origin CORS blocked', acao !== 'https://evil.com' && acao !== '*', 'blocked', 'ACAO=' + acao);
    return;
  }
  var res = await fetch(BASE + '/api/posts', { ...TIMEOUT, headers: { 'Origin': 'https://evil.com' } });
  check('Evil origin does not bypass auth', res.status === 401, '401', String(res.status));
});

await testAsync('3.7.1.2-A', ' X-Forwarded-For does not bypass auth', async () => {
  console.log('  Sending X-Forwarded-For: 127.0.0.1 to pretend to be localhost');
  console.log('  The dev bypass must check the actual connection, not forwarded headers');
  console.log('  Checking: header spoofing does not grant access');
  if (!authRequired) { check('Dev mode — skipped', true, 'skipped', 'skipped'); return; }
  var res = await fetch(BASE + '/api/posts', {
    ...TIMEOUT,
    headers: { 'X-Forwarded-For': '127.0.0.1', 'Origin': 'https://evil.com' }
  });
  check('X-Forwarded-For does not bypass', res.status === 401, '401', String(res.status));
});

await testAsync('3.7.1.3-A', ' Host header spoofing does not bypass auth', async () => {
  console.log('  Sending Host: localhost:3001 from a remote attacker');
  console.log('  The Host header can be spoofed in raw HTTP requests');
  if (!authRequired) { check('Dev mode — skipped', true, 'skipped', 'skipped'); return; }
  var res = await fetch(BASE + '/api/posts', {
    ...TIMEOUT,
    headers: { 'Host': 'localhost:3001', 'Origin': 'https://evil.com' }
  });
  check('Host spoofing does not bypass', res.status === 401, '401', String(res.status));
});

await testAsync('3.7.1.4-A', ' /api/status does not leak user data without session', async () => {
  console.log('  Without a session cookie, /api/status should return user:null');
  console.log('  It should NOT return other users info or default admin claims');
  console.log('  Checking: user field is null');
  var res = await fetch(BASE + '/api/status', TIMEOUT);
  var json = await res.json();
  check('No user data without session', json.user === null, 'null', JSON.stringify(json.user));
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

console.log('  File: test-p3-step7-adversarial/hostile-bypass.mjs');
group('Group 2: Dashboard content leak prevention', `
  Impact: If the login wall can be bypassed by manipulating the
  frontend, an attacker sees dashboard content without logging
  in. The backend must be the authority — the frontend login
  wall is a convenience, not a security control.

  Defense: Backend returns 401, frontend shows login wall
`);

var before2 = getCounters();

await testAsync('3.7.2.1-A', ' API data not in initial HTML', async () => {
  console.log('  Fetching GET / (dashboard HTML) and checking for embedded API data');
  console.log('  The HTML must NOT contain pre-rendered post content or activity logs');
  console.log('  All data should be fetched via API calls (which require auth)');
  var res = await fetch(BASE + '/', TIMEOUT);
  var html = await res.text();
  // Check for actual pre-rendered JSON data — NOT JavaScript property references.
  // The dashboard JS references "totalPosted" and "pending_approval" as property
  // accessors in code. That's expected. What would be a leak is actual numeric
  // values or post titles embedded in a <script> data block or window.__DATA__.
  var hasEmbeddedData = html.includes('window.__DATA__') || html.includes('window.__INITIAL_STATE__') ||
    html.includes('"posts":[{') || html.includes('"logs":[{');
  check('No embedded API data in HTML', !hasEmbeddedData, 'clean', 'embedded data found');
});

await testAsync('3.7.2.2-A', ' Dashboard fetches data from API, not embedded', async () => {
  console.log('  The dashboard must use fetch() to get data from /api/status, /api/posts, etc.');
  console.log('  Data comes from authenticated API calls, not inline script blocks');
  console.log('  Checking: HTML contains fetch() calls to API endpoints');
  var res = await fetch(BASE + '/', TIMEOUT);
  var html = await res.text();
  var hasFetch = html.includes("fetch(`${API}/api/status`)") || html.includes('fetch(') && html.includes('/api/');
  check('Dashboard uses fetch for data', hasFetch, 'found', 'not found');
});

await testAsync('3.7.2.3-A', ' Auth routes still accessible in auth mode', async () => {
  console.log('  /auth/login must work even when auth is required');
  console.log('  If the login route itself requires auth, nobody can log in');
  console.log('  Checking: /auth/login returns 302 (redirect to Auth0)');
  var res = await fetch(BASE + '/auth/login', { ...TIMEOUT, redirect: 'manual' });
  check('Login route accessible', res.status === 302 || res.status === 503,
    '302 or 503', String(res.status));
});

await testAsync('3.7.2.4-A', ' /auth/logout accessible without session', async () => {
  console.log('  Logout should work even if the session is already expired');
  console.log('  A user clicking logout with a stale session should not get a 401');
  var res = await fetch(BASE + '/auth/logout', { ...TIMEOUT, redirect: 'manual' });
  check('Logout without session works', res.status === 302, '302', String(res.status));
});

await testAsync('3.7.2.5-A', ' Security headers on dashboard HTML', async () => {
  console.log('  The dashboard page itself must include all security headers');
  console.log('  CSP, X-Frame-Options, etc. protect against XSS on the login wall');
  var res = await fetch(BASE + '/', TIMEOUT);
  var xfo = res.headers.get('x-frame-options');
  var csp = res.headers.get('content-security-policy');
  check('X-Frame-Options on dashboard', xfo === 'DENY', 'DENY', String(xfo));
  check('CSP on dashboard', csp !== null && csp.length > 0, 'present', 'missing');
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

var summary = getCounters();
process.exit(summary.fail);
