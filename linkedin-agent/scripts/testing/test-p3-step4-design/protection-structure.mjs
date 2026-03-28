// ═══════════════════════════════════════════════════════════════
// Step 4 Design Groups 1, 2: Protection Structure
//
// Auth enforcement that works is not enough. It must be
// applied at the right layer, in the right order, from a
// single point. Per-handler auth checks are a maintenance
// hazard — one missed handler and the route is public.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { group, groupEnd, test, check, getCounters } from '../lib/test-harness.mjs';

var apiSource = fs.readFileSync('src/routes/api.js', 'utf8');

// ── Group 1: Middleware-level protection ──────────────────────

console.log('  File: test-p3-step4-design/protection-structure.mjs');
group('Group 1: Middleware-level protection', `
  If these tests fail, auth is enforced per-handler instead of
  per-router. Adding a new route requires remembering to add
  requireAuth. Forgetting once means the route is public.
  Middleware-level enforcement makes the default "protected" —
  public routes must be explicitly exempted.
`);

var before1 = getCounters();

test('3.4.1.1-D', ' Router.use(requireAuth) applies to ALL subsequent routes', () => {
  console.log('  api.js must call router.use() with requireAuth or auth middleware');
  console.log('  router.use(requireAuth) applies to ALL subsequent routes');
  console.log('  This is the single enforcement point — one line protects 15 routes');
  check('router.use with auth middleware',
    apiSource.includes('router.use(requireAuth') || apiSource.includes('router.use( requireAuth') ||
    apiSource.includes('.use(requireAuth'),
    'router.use(requireAuth...)', 'not found');
});

test('3.4.1.2-D', ' RequireAuth must NOT appear inside individual route handlers', () => {
  console.log('  requireAuth must NOT appear inside individual route handlers');
  console.log('  If requireAuth is in handlers, it is per-route enforcement');
  console.log('  Counting occurrences: should be 1 (the router.use) or 0 in handler blocks');
  // Count requireAuth inside router.get/router.post callbacks
  var handlerMatches = apiSource.match(/router\.(get|post|put|patch|delete)\([^)]+requireAuth/g);
  check('requireAuth not in individual handlers',
    handlerMatches === null || handlerMatches.length === 0,
    '0 handler-level occurrences', (handlerMatches?.length || 0) + ' found');
});

test('3.4.1.3-D', ' Reimplementing auth instead of relying on middleware', () => {
  console.log('  No route handler should contain the word "authorization" or "bearer"');
  console.log('  If handlers inspect the Authorization header directly, they are');
  console.log('  reimplementing auth instead of relying on middleware');
  // Extract handler bodies (rough: everything between (req, res) => { and });
  var lines = apiSource.split('\n');
  var suspicious = [];
  for (var [i, line] of lines.entries()) {
    var lower = line.toLowerCase();
    if ((lower.includes('authorization') || lower.includes('bearer')) &&
        !lower.includes('import') && !lower.includes('//') && !lower.includes('createauth')) {
      suspicious.push('Line ' + (i + 1) + ': ' + line.trim().substring(0, 60));
    }
  }
  check('No "authorization"/"bearer" in route handlers',
    suspicious.length === 0,
    '0 references', suspicious.length + ': ' + suspicious[0]?.substring(0, 50));
});

test('3.4.1.4-D', ' No JWT/verifyToken in route handlers', () => {
  console.log('  No route handler should contain the word "token" in an auth context');
  console.log('  "token" in a LinkedIn API context (access_token for LinkedIn) is fine');
  console.log('  "token" for JWT verification in a route handler is wrong — middleware does that');
  var lines = apiSource.split('\n');
  var authTokenRefs = lines.filter(l =>
    l.toLowerCase().includes('jwt') ||
    l.toLowerCase().includes('verifytoken') ||
    (l.toLowerCase().includes('token') && l.toLowerCase().includes('verify'))
  );
  check('No JWT/verifyToken in route handlers', authTokenRefs.length === 0,
    '0 refs', authTokenRefs.length + ' refs');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: Middleware ordering ─────────────────────────────

console.log('  File: test-p3-step4-design/protection-structure.mjs');
group('Group 2: Middleware ordering', `
  If these tests fail, middleware runs in the wrong order.
  Auth before CORS blocks preflight OPTIONS. Body parsing
  before auth means the server processes 16KB of attacker
  payload before rejecting the request.
`);

var before2 = getCounters();

test('3.4.2.1-D', ' Routes after use() are protected. This is by design.', () => {
  console.log('  The public route (/api/status) must be defined BEFORE router.use(requireAuth)');
  console.log('  Express middleware is order-dependent: routes before use() are unprotected');
  console.log('  Routes after use() are protected. This is by design.');
  var statusIdx = apiSource.indexOf('/api/status');
  var useAuthIdx = apiSource.indexOf('router.use(requireAuth') !== -1
    ? apiSource.indexOf('router.use(requireAuth')
    : apiSource.indexOf('.use(requireAuth');
  if (useAuthIdx === -1) {
    check('Public route before auth middleware', false,
      'status before use(requireAuth)', 'use(requireAuth) not found');
  } else {
    check('Public route before auth middleware', statusIdx < useAuthIdx,
      'status at ' + statusIdx + ' < auth at ' + useAuthIdx,
      'status at ' + statusIdx + ' >= auth at ' + useAuthIdx);
  }
});

test('3.4.2.2-D', ' Potentially executed before auth rejects the request', () => {
  console.log('  requireAuth must run BEFORE any route handler that processes body');
  console.log('  If the handler runs first, an attacker\'s POST body is parsed and');
  console.log('  potentially executed before auth rejects the request');
  console.log('  Checking: no POST/PUT/PATCH handler appears before the auth middleware');
  var useAuthIdx = apiSource.indexOf('router.use(requireAuth') !== -1
    ? apiSource.indexOf('router.use(requireAuth')
    : apiSource.indexOf('.use(requireAuth');
  if (useAuthIdx === -1) {
    check('Auth middleware before write handlers', false,
      'use(requireAuth) exists', 'not found');
  } else {
    // Find first POST/PUT/PATCH handler AFTER status route
    var statusIdx = apiSource.indexOf('/api/status');
    var afterStatus = apiSource.substring(statusIdx + 20);
    var firstWriteAfterStatus = afterStatus.search(/router\.(post|put|patch)\(/);
    var authRelativeToStatus = useAuthIdx - statusIdx - 20;
    check('Auth middleware before first POST handler',
      authRelativeToStatus < firstWriteAfterStatus,
      'auth first', 'handler first');
  }
});

test('3.4.2.3-D', ' Uses createAuthMiddleware', () => {
  console.log('  api.js must use createAuthMiddleware (factory), not import requireAuth directly');
  console.log('  The factory pattern injects the logger — direct import would be a singleton');
  check('Uses createAuthMiddleware',
    apiSource.includes('createAuthMiddleware'),
    'factory pattern', 'direct import');
});

test('3.4.2.4-D', ' Api.js must not import jose, jwt-verifier, or provider files', () => {
  console.log('  api.js must not import jose, jwt-verifier, or provider files');
  console.log('  Route handlers should know nothing about JWT format or provider internals');
  console.log('  All auth knowledge is in the middleware layer');
  check('No jose import', !apiSource.includes("from 'jose'") && !apiSource.includes('from "jose"'),
    'clean', 'imports jose');
  check('No jwt-verifier import', !apiSource.includes('jwt-verifier'),
    'clean', 'imports jwt-verifier');
  check('No auth0 provider import', !apiSource.includes('/providers/auth0'),
    'clean', 'imports auth0');
});

test('3.4.2.5-D', ' Error handling middleware must come AFTER auth middleware', () => {
  console.log('  Error handling middleware must come AFTER auth middleware');
  console.log('  If error handler is before auth, auth errors skip the handler');
  console.log('  Looking for app.use((err, req, res, next) pattern after auth');
  // This is a structural check — error handlers have 4 params
  var errHandlerPattern = /\(err\s*,\s*req\s*,\s*res\s*,\s*next\)/;
  var errMatch = apiSource.match(errHandlerPattern);
  if (errMatch) {
    var errIdx = apiSource.indexOf(errMatch[0]);
    var authIdx = apiSource.indexOf('router.use(requireAuth') !== -1
      ? apiSource.indexOf('router.use(requireAuth')
      : apiSource.indexOf('.use(requireAuth');
    if (authIdx !== -1) {
      check('Error handler after auth middleware', errIdx > authIdx,
        'error at ' + errIdx + ' > auth at ' + authIdx,
        'error at ' + errIdx + ' <= auth at ' + authIdx);
    } else {
      check('Error handler position', false, 'auth middleware found first', 'auth not found');
    }
  } else {
    console.log('  ℹ No explicit error handler found — Express default will catch auth errors');
    check('Error handler check (informational)', true, 'documented', 'documented');
  }
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
