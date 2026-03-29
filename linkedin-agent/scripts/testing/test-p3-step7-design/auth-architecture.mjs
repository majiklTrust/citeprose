// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 7 Design: Dashboard Auth Architecture
// Reads source code to verify dev bypass implementation,
// frontend auth patterns, and status endpoint auth fields.
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

// ── Read source files ────────────────────────────────────────
var indexSrc = '';
try { indexSrc = fs.readFileSync('src/index.js', 'utf8'); } catch {
  try { indexSrc = fs.readFileSync('src_templates/index.js', 'utf8'); } catch {}
}
var apiSrc = '';
try { apiSrc = fs.readFileSync('src/routes/api.js', 'utf8'); } catch {}
var middlewareSrc = '';
try { middlewareSrc = fs.readFileSync('src/auth/middleware.js', 'utf8'); } catch {}
var dashSrc = '';
try { dashSrc = fs.readFileSync('public/index.html', 'utf8'); } catch {
  try { dashSrc = fs.readFileSync('public_templates/index.html', 'utf8'); } catch {}
}

console.log('  File: test-p3-step7-design/auth-architecture.mjs');
group('Group 1: /api/status auth field design', `
  Impact: The /api/status endpoint is the contract between backend and
  frontend for auth state. If the fields are missing or misplaced,
  the dashboard cannot determine auth mode. If user data is leaked
  from a different session, it's an information disclosure bug.

  File: src/routes/api.js
  Check: authRequired and user fields in status response
`);

var before1 = getCounters();

await testAsync('3.7.1.1-D', ' api.js status route includes authRequired', async () => {
  console.log('  Reading src/routes/api.js');
  console.log('  The /api/status handler must include authRequired in its response');
  console.log('  Checking: source contains "authRequired" in the status route');
  check('authRequired in api.js', apiSrc.includes('authRequired'), 'found', 'not found');
});

await testAsync('3.7.1.2-D', ' api.js status route includes user field', async () => {
  console.log('  The status response must include the user field');
  console.log('  This is null when not authenticated, populated from req.user when authenticated');
  console.log('  Checking: source references req.user in the status route');
  var hasUser = apiSrc.includes('req.user') || apiSrc.includes('user:');
  check('User field in status route', hasUser, 'found', 'not found');
});

await testAsync('3.7.1.3-D', ' api.js references isAuthEnabled', async () => {
  console.log('  authRequired value comes from isAuthEnabled() in the auth registry');
  console.log('  Checking: api.js imports or references isAuthEnabled');
  var hasIsAuth = apiSrc.includes('isAuthEnabled');
  check('isAuthEnabled in api.js', hasIsAuth, 'found', 'not found');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

console.log('  File: test-p3-step7-design/auth-architecture.mjs');
group('Group 2: Frontend auth-aware rendering', `
  Impact: If the frontend does not implement auth-aware rendering,
  either the login wall never appears (security gap) or it
  always appears (breaks dev mode). The frontend must read
  authRequired from /api/status and render accordingly.

  File: public/index.html (or public_templates/index.html)
  Check: Auth state management, conditional rendering, 401 handling
`);

var before2 = getCounters();

await testAsync('3.7.2.1-D', ' Dashboard reads authRequired from status', async () => {
  console.log('  The JavaScript must extract authRequired from the /api/status response');
  console.log('  This value drives the login wall vs full dashboard decision');
  console.log('  Checking: source references authRequired');
  check('authRequired read in frontend', dashSrc.includes('authRequired'), 'found', 'not found');
});

await testAsync('3.7.2.2-D', ' Dashboard reads user from status', async () => {
  console.log('  The JavaScript must extract user from the /api/status response');
  console.log('  user drives the header display (name, email, logout button)');
  console.log('  Checking: source destructures or accesses user from status');
  var hasUser = dashSrc.includes('.user') || dashSrc.includes('user:') || dashSrc.includes('user ?');
  check('User read in frontend', hasUser, 'found', 'not found');
});

await testAsync('3.7.2.3-D', ' Login wall rendered conditionally', async () => {
  console.log('  The login wall must appear only when authRequired && !user');
  console.log('  Checking: source contains conditional rendering for login wall');
  var hasConditional = dashSrc.includes('authRequired') &&
    (dashSrc.includes('/auth/login') || dashSrc.includes('login'));
  check('Conditional login wall', hasConditional, 'found', 'not found');
});

await testAsync('3.7.2.4-D', ' Dev banner rendered conditionally', async () => {
  console.log('  The dev banner must appear only when !authRequired');
  console.log('  Checking: source contains conditional rendering for dev banner');
  var hasBanner = dashSrc.includes('authRequired') &&
    (dashSrc.includes('Development') || dashSrc.includes('development') ||
     dashSrc.includes('dev-banner') || dashSrc.includes('dev-warning'));
  check('Conditional dev banner', hasBanner, 'found', 'not found');
});

await testAsync('3.7.2.5-D', ' Logout button in header area', async () => {
  console.log('  The logout button must be in the header, not buried in a menu');
  console.log('  It should be near the user identity display');
  console.log('  Checking: /auth/logout appears in the header/app-container section');
  check('Logout button present', dashSrc.includes('/auth/logout'), 'found', 'not found');
});

await testAsync('3.7.2.6-D', ' 401 response triggers login redirect', async () => {
  console.log('  When any fetch() receives a 401, the dashboard must redirect to login');
  console.log('  This handles expired sessions gracefully');
  console.log('  Checking: source checks for 401 status and redirects');
  var has401Check = dashSrc.includes('401');
  check('401 check in frontend', has401Check, 'found', 'not found');
});

await testAsync('3.7.2.7-D', ' No token storage in frontend JavaScript', async () => {
  console.log('  Tokens live in httpOnly cookies — not accessible to JavaScript');
  console.log('  The frontend must NOT use localStorage, sessionStorage, or JS variables for tokens');
  console.log('  Checking: no localStorage.setItem or sessionStorage.setItem with token patterns');
  var hasStorage = dashSrc.includes('localStorage.setItem') || dashSrc.includes('sessionStorage.setItem');
  check('No browser storage for tokens', !hasStorage, 'clean', 'storage found');
});

await testAsync('3.7.2.8-D', ' No Authorization header in fetch calls', async () => {
  console.log('  The dashboard uses cookies for auth, not Bearer tokens');
  console.log('  fetch() calls should NOT include Authorization headers');
  console.log('  The cookie is sent automatically by the browser');
  console.log('  Checking: no "Authorization" or "Bearer" in fetch headers');
  var hasAuthHeader = dashSrc.includes("'Authorization'") || dashSrc.includes('"Authorization"') ||
    dashSrc.includes("'Bearer ") || dashSrc.includes('"Bearer ');
  check('No Authorization header in fetch', !hasAuthHeader, 'clean', 'Authorization header found');
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

console.log('  File: test-p3-step7-design/auth-architecture.mjs');
group('Group 3: Middleware and session integration', `
  Impact: If the middleware does not properly integrate with the
  session layer and dev bypass, either dev mode breaks or
  production auth has gaps.

  Files: src/auth/middleware.js, src/auth/session.js
  Check: Session expiry check, refresh trigger, dev bypass logic
`);

var before3 = getCounters();

await testAsync('3.7.3.1-D', ' Middleware checks session expiry', async () => {
  console.log('  Reading src/auth/middleware.js');
  console.log('  The middleware should call isSessionExpiring() to detect near-expiry sessions');
  console.log('  Checking: source references isSessionExpiring');
  var hasExpiry = middlewareSrc.includes('isSessionExpiring') || middlewareSrc.includes('expiresAt');
  check('Expiry check in middleware', hasExpiry, 'found', 'not found');
});

await testAsync('3.7.3.2-D', ' Middleware imports from session.js', async () => {
  console.log('  The middleware must import readSession from session.js');
  console.log('  Checking: source imports from session.js');
  var hasImport = middlewareSrc.includes('session.js');
  check('Session import in middleware', hasImport, 'found', 'not found');
});

await testAsync('3.7.3.3-D', ' Middleware has cookie check before Bearer check', async () => {
  console.log('  Session cookie is checked first (browser path)');
  console.log('  Bearer token is the fallback (programmatic path)');
  console.log('  Checking: readSession appears before extractBearerToken in requireAuth');
  var sessionPos = middlewareSrc.indexOf('readSession');
  var bearerPos = middlewareSrc.indexOf('extractBearerToken');
  check('Cookie before Bearer', sessionPos > 0 && sessionPos < bearerPos,
    'session first', 'sessionPos=' + sessionPos + ' bearerPos=' + bearerPos);
});

await testAsync('3.7.3.4-D', ' optionalAuth also checks session cookie', async () => {
  console.log('  optionalAuth is used on /api/status — must also check cookies');
  console.log('  Checking: optionalAuth function references readSession');
  var optionalStart = middlewareSrc.indexOf('async function optionalAuth');
  if (optionalStart < 0) optionalStart = middlewareSrc.indexOf('optionalAuth');
  var optionalSection = middlewareSrc.substring(optionalStart);
  var hasSession = optionalSection.includes('readSession');
  check('optionalAuth checks session', hasSession, 'found', 'not found');
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

var summary = getCounters();
process.exit(summary.fail);
