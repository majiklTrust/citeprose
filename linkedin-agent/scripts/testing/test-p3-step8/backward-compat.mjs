// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 8 Groups 1-3: Backward Compatibility
// Verifies dashboard, API, LinkedIn OAuth, and scheduler
// still work after the auth layer was added.
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

var BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
var TIMEOUT = { signal: AbortSignal.timeout(10000) };

console.log('  File: test-p3-step8/backward-compat.mjs');
group('Group 1: Dashboard still loads', `
  Impact: If these tests fail, the dashboard UI is broken. Users
  see a blank page, a 404, or a server error instead of the
  React application. The auth layer may have interfered with
  static file serving or the SPA fallback route.

  Endpoint: GET /
  Check: HTML returned, React scripts present, no server error
`);

var before1 = getCounters();

await testAsync('3.8.1.1', ' Dashboard returns 200', async () => {
  console.log('  Fetching GET / — the dashboard entry point');
  console.log('  Static file serving must work regardless of auth state');
  console.log('  Checking: response status is 200');
  var res = await fetch(BASE + '/', TIMEOUT);
  check('Dashboard returns 200', res.status === 200, '200', String(res.status));
});

await testAsync('3.8.1.2', ' Dashboard returns HTML', async () => {
  console.log('  Checking Content-Type header for text/html');
  console.log('  If the auth layer intercepts the request, it might return JSON instead');
  var res = await fetch(BASE + '/', TIMEOUT);
  var ct = res.headers.get('content-type') || '';
  check('Content-Type is HTML', ct.includes('text/html'), 'text/html', ct);
});

await testAsync('3.8.1.3', ' Dashboard contains React scripts', async () => {
  console.log('  The dashboard uses React via in-browser Babel');
  console.log('  If static file serving is broken, the React scripts are missing');
  console.log('  Checking: HTML contains react.production.min.js reference');
  var res = await fetch(BASE + '/', TIMEOUT);
  var html = await res.text();
  check('React script present', html.includes('react.production.min.js'), 'found', 'not found');
});

await testAsync('3.8.1.4', ' Dashboard contains application code', async () => {
  console.log('  The React app is in a text/babel script block');
  console.log('  Checking: HTML contains function App() or equivalent');
  var res = await fetch(BASE + '/', TIMEOUT);
  var html = await res.text();
  check('App component present', html.includes('function App()'), 'found', 'not found');
});

await testAsync('3.8.1.5', ' Dashboard contains version placeholder', async () => {
  console.log('  The build process replaces {{VERSION}} with the actual version');
  console.log('  If the template is served raw, {{VERSION}} appears literally');
  console.log('  Checking: HTML contains v followed by digits (not {{VERSION}})');
  var res = await fetch(BASE + '/', TIMEOUT);
  var html = await res.text();
  var hasVersion = /v\d+\.\d+/.test(html);
  check('Version number present', hasVersion, 'vX.Y', 'no version found');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

console.log('  File: test-p3-step8/backward-compat.mjs');
group('Group 2: API endpoints still functional', `
  Impact: If these tests fail, the dashboard loads but cannot
  display any data. The API routes are broken or unreachable,
  even though the HTML shell renders correctly. This could
  mean the auth middleware is blocking requests it shouldn't,
  or that the route wiring was disrupted.

  Endpoints: /api/status, /api/posts, /api/logs
  Check: Expected responses with correct structure
`);

var before2 = getCounters();

await testAsync('3.8.2.1', ' /api/status returns complete data', async () => {
  console.log('  Fetching GET /api/status — the public health check');
  console.log('  Must include all original fields plus the new auth fields');
  console.log('  Checking: response contains mode, stats, authRequired, user');
  var res = await fetch(BASE + '/api/status', TIMEOUT);
  var json = await res.json();
  check('mode present', typeof json.mode === 'string', 'string', typeof json.mode);
  check('stats present', typeof json.stats === 'object', 'object', typeof json.stats);
  check('authRequired present', typeof json.authRequired === 'boolean', 'boolean', typeof json.authRequired);
  check('user present', json.hasOwnProperty('user'), 'present', 'missing');
  check('serverAddress present', typeof json.serverAddress === 'string', 'string', typeof json.serverAddress);
});

await testAsync('3.8.2.2', ' /api/status returns cadence info', async () => {
  console.log('  The scheduler cadence data drives the dashboard stats display');
  console.log('  Checking: response contains cadence and maxPostsPer10Days');
  var res = await fetch(BASE + '/api/status', TIMEOUT);
  var json = await res.json();
  check('cadence present', json.hasOwnProperty('cadence'), 'present', 'missing');
  check('maxPostsPer10Days present', typeof json.maxPostsPer10Days === 'number', 'number', typeof json.maxPostsPer10Days);
});

await testAsync('3.8.2.3', ' /api/status returns LinkedIn connection state', async () => {
  console.log('  The dashboard shows LinkedIn connection status in the header');
  console.log('  Checking: response contains linkedinConnected boolean');
  var res = await fetch(BASE + '/api/status', TIMEOUT);
  var json = await res.json();
  check('linkedinConnected present', typeof json.linkedinConnected === 'boolean', 'boolean', typeof json.linkedinConnected);
});

await testAsync('3.8.2.4', ' /api/status serverAddress is non-empty', async () => {
  console.log('  The new serverAddress field drives the dev banner display');
  console.log('  Checking: serverAddress is a non-empty string');
  var res = await fetch(BASE + '/api/status', TIMEOUT);
  var json = await res.json();
  check('serverAddress non-empty', json.serverAddress && json.serverAddress.length > 0,
    'non-empty', String(json.serverAddress));
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

console.log('  File: test-p3-step8/backward-compat.mjs');
group('Group 3: LinkedIn OAuth independent from Auth0 OAuth', `
  Impact: If these tests fail, the LinkedIn posting authorization
  is broken. The agent cannot obtain or refresh LinkedIn access
  tokens. Content generation still works but publishing fails.
  The two OAuth flows must be completely independent — Auth0
  controls dashboard access, LinkedIn controls posting access.

  Endpoints: /auth/linkedin, /auth/linkedin/callback
  vs: /auth/login, /auth/callback, /auth/logout
  Check: Both flows respond correctly and independently
`);

var before3 = getCounters();

await testAsync('3.8.3.1', ' /auth/linkedin returns redirect', async () => {
  console.log('  GET /auth/linkedin should redirect to LinkedIn authorization');
  console.log('  This is the posting token flow — separate from dashboard login');
  console.log('  Checking: response is 302 redirect');
  var res = await fetch(BASE + '/auth/linkedin', { ...TIMEOUT, redirect: 'manual' });
  check('LinkedIn auth redirects', res.status === 302, '302', String(res.status));
});

await testAsync('3.8.3.2', ' /auth/linkedin redirects to LinkedIn, not Auth0', async () => {
  console.log('  The redirect Location must point to LinkedIn, not to Auth0');
  console.log('  If the auth layer is intercepting, it might redirect to Auth0 instead');
  console.log('  Checking: Location header contains linkedin.com');
  var res = await fetch(BASE + '/auth/linkedin', { ...TIMEOUT, redirect: 'manual' });
  var location = res.headers.get('location') || '';
  check('Redirects to LinkedIn', location.includes('linkedin.com'), 'linkedin.com', location.substring(0, 60));
});

await testAsync('3.8.3.3', ' /auth/login returns redirect (Auth0)', async () => {
  console.log('  GET /auth/login should redirect to Auth0 authorization');
  console.log('  This is the dashboard login flow — separate from LinkedIn');
  console.log('  Checking: response is 302 (Auth0 configured) or 503 (no provider)');
  var res = await fetch(BASE + '/auth/login', { ...TIMEOUT, redirect: 'manual' });
  check('Auth0 login responds', res.status === 302 || res.status === 503,
    '302 or 503', String(res.status));
});

await testAsync('3.8.3.4', ' /auth/login redirects to Auth0, not LinkedIn', async () => {
  console.log('  If Auth0 is configured, the Location must point to Auth0, not LinkedIn');
  console.log('  Checking: Location header contains auth0.com (if 302)');
  var res = await fetch(BASE + '/auth/login', { ...TIMEOUT, redirect: 'manual' });
  if (res.status !== 302) {
    check('Auth0 not configured — skipped', true, 'skipped', 'skipped');
    return;
  }
  var location = res.headers.get('location') || '';
  check('Redirects to Auth0', location.includes('auth0.com'), 'auth0.com', location.substring(0, 60));
});

await testAsync('3.8.3.5', ' /auth/linkedin/callback rejects invalid state', async () => {
  console.log('  Sending a callback with a forged state parameter');
  console.log('  The LinkedIn callback must validate state independently');
  console.log('  Checking: response is 403 (invalid state)');
  var res = await fetch(BASE + '/auth/linkedin/callback?code=fake&state=forged', TIMEOUT);
  check('LinkedIn callback validates state', res.status === 403, '403', String(res.status));
});

await testAsync('3.8.3.6', ' /auth/callback rejects invalid state', async () => {
  console.log('  Sending a callback with a forged state to the Auth0 callback');
  console.log('  The Auth0 callback must validate state independently');
  console.log('  Checking: response is 403 (invalid state)');
  var res = await fetch(BASE + '/auth/callback?code=fake&state=forged', TIMEOUT);
  check('Auth0 callback validates state', res.status === 403, '403', String(res.status));
});

await testAsync('3.8.3.7', ' /auth/logout clears session and redirects', async () => {
  console.log('  GET /auth/logout should clear session cookie and redirect');
  console.log('  Checking: response is 302');
  var res = await fetch(BASE + '/auth/logout', { ...TIMEOUT, redirect: 'manual' });
  check('Logout redirects', res.status === 302, '302', String(res.status));
});

await testAsync('3.8.3.8', ' /auth/logout Set-Cookie clears session', async () => {
  console.log('  The logout response must include Set-Cookie that expires the session');
  console.log('  Checking: Set-Cookie header contains Max-Age=0 or Expires in the past');
  var res = await fetch(BASE + '/auth/logout', { ...TIMEOUT, redirect: 'manual' });
  var setCookie = res.headers.get('set-cookie') || '';
  check('Session cookie cleared', setCookie.includes('Max-Age=0') || setCookie.includes('max-age=0'),
    'Max-Age=0', setCookie.substring(0, 80));
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

var summary = getCounters();
process.exit(summary.fail);
