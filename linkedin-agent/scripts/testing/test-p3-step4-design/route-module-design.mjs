// ═══════════════════════════════════════════════════════════════
// Step 4 Design Groups 3, 4: Route Module Design
//
// api.js is the highest-traffic file in the project. Every
// feature touches it. If auth logic is scattered through 16
// handlers, adding a new route means understanding auth. If
// the public/protected split is implicit, a new developer
// makes a route public by accident.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { group, groupEnd, test, check, getCounters } from '../lib/test-harness.mjs';

var apiSource = fs.readFileSync('src/routes/api.js', 'utf8');

// ── Group 3: Import discipline ───────────────────────────────

console.log('  File: test-p3-step4-design/route-module-design.mjs');
group('Group 3: api.js import discipline', `
  If these tests fail, api.js knows too much about auth internals.
  A change to the JWT library, provider config, or middleware
  implementation requires editing the route file. The route file
  should import ONE thing from auth: the middleware factory.
`);

var before3 = getCounters();

test('3.4.3.1-D', ' This is the only auth import the route file needs', () => {
  console.log('  api.js must import from src/auth/middleware.js (for createAuthMiddleware)');
  console.log('  This is the only auth import the route file needs');
  check('Imports middleware',
    apiSource.includes('/auth/middleware') || apiSource.includes('../auth/middleware'),
    'imports middleware', 'no middleware import');
});

test('3.4.3.2-D', ' Api.js auth imports limited to middleware and registry', () => {
  console.log('  api.js may import from auth/middleware.js (for requireAuth/optionalAuth)');
  console.log('  and from auth/index.js (for isAuthEnabled in /api/status response)');
  console.log('  It must NOT import from providers, jwt-verifier, or session directly');
  console.log('  Those are internal auth concerns — route handlers should not touch them');
  check('No registry import or allowed',
    !apiSource.includes('/auth/index') || apiSource.includes('isAuthEnabled'),
    'clean (or isAuthEnabled only)', 'imports registry for wrong reason');
  // Precise check: does it import something OTHER than middleware or index from auth?
  var authImports = apiSource.match(/from ['"].*\/auth\/(?!middleware|index)[^'"]+['"]/g);
  check('No internal auth imports',
    authImports === null || authImports.length === 0,
    '0 internal auth imports', (authImports?.length || 0) + ' found');
});

test('3.4.3.3-D', ' Api.js must NOT import jose', () => {
  console.log('  api.js must NOT import jose');
  console.log('  JWT parsing is jwt-verifier responsibility — not route handler concern');
  check('No jose import',
    !apiSource.includes("from 'jose'") && !apiSource.includes('from "jose"'),
    'clean', 'imports jose');
});

test('3.4.3.4-D', ' Api.js must NOT import jwt-verifier', () => {
  console.log('  api.js must NOT import jwt-verifier');
  console.log('  Token verification goes through middleware, not direct handler calls');
  check('No jwt-verifier import', !apiSource.includes('jwt-verifier'),
    'clean', 'imports jwt-verifier');
});

test('3.4.3.5-D', ' Api.js must NOT import any provider file directly', () => {
  console.log('  api.js must NOT import any provider file directly');
  console.log('  Routes do not need to know which IDP authenticated the user');
  check('No auth0 import', !apiSource.includes('/providers/auth0'),
    'clean', 'imports auth0');
  check('No mock import', !apiSource.includes('/providers/mock'),
    'clean', 'imports mock');
});

test('3.4.3.6-D', ' Api.js must call createAuthMiddleware exactly once', () => {
  console.log('  api.js must call createAuthMiddleware exactly once');
  console.log('  Multiple calls create multiple middleware instances — inconsistent behavior');
  var matches = apiSource.match(/createAuthMiddleware\(/g);
  check('createAuthMiddleware called once',
    matches !== null && matches.length === 1,
    '1 call', (matches?.length || 0) + ' calls');
});

test('3.4.3.7-D', ' The destructured result must include requireAuth', () => {
  console.log('  The destructured result must include requireAuth');
  console.log('  This is the middleware applied via router.use()');
  check('requireAuth destructured from factory',
    apiSource.includes('requireAuth') && apiSource.includes('createAuthMiddleware'),
    'present', 'missing');
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Group 4: Public/protected split visibility ───────────────

console.log('  File: test-p3-step4-design/route-module-design.mjs');
group('Group 4: Public/protected route split', `
  If these tests fail, the boundary between public and protected
  routes is implicit or scattered. A new developer adding a
  route does not know if it needs auth. The split must be
  visible in one place, documented by code structure.
`);

var before4 = getCounters();

test('3.4.4.1-D', ' Every route after the middleware is protected by default', () => {
  console.log('  /api/status must be the ONLY route defined before requireAuth middleware');
  console.log('  Every route after the middleware is protected by default');
  console.log('  This makes "protected" the default — public is the exception');
  var useAuthIdx = apiSource.indexOf('router.use(requireAuth') !== -1
    ? apiSource.indexOf('router.use(requireAuth')
    : apiSource.indexOf('.use(requireAuth');
  if (useAuthIdx === -1) {
    check('Auth middleware exists', false, 'found', 'not found');
    return;
  }
  var beforeAuth = apiSource.substring(0, useAuthIdx);
  var routesBefore = beforeAuth.match(/router\.(get|post|put|patch|delete)\s*\(\s*['"][^'"]+['"]/g) || [];
  var routePaths = routesBefore.map(r => {
    var m = r.match(/['"]([^'"]+)['"]/);
    return m ? m[1] : 'unknown';
  });
  console.log('  Routes before auth middleware: ' + JSON.stringify(routePaths));
  check('Only /api/status before auth',
    routePaths.length === 1 && routePaths[0] === '/api/status',
    '["/api/status"]', JSON.stringify(routePaths));
});

test('3.4.4.2-D', ' Auth middleware found', () => {
  console.log('  All 15 protected routes must appear AFTER requireAuth middleware');
  var useAuthIdx = apiSource.indexOf('router.use(requireAuth') !== -1
    ? apiSource.indexOf('router.use(requireAuth')
    : apiSource.indexOf('.use(requireAuth');
  if (useAuthIdx === -1) {
    check('Auth middleware found', false, 'found', 'not found');
    return;
  }
  var afterAuth = apiSource.substring(useAuthIdx);
  var protectedPaths = [
    '/api/posts', '/api/posts/:id', '/api/posts/:id/approve', '/api/posts/:id/reject',
    '/api/mode', '/api/pause', '/api/corroboration', '/api/generate-preview',
    '/api/save-preview', '/api/force-cycle', '/api/research/stats',
    '/api/research/articles', '/api/research/poll', '/api/logs', '/api/linkedin/status'
  ];
  for (var path of protectedPaths) {
    check(path + ' after auth', afterAuth.includes(path),
      'found after middleware', 'not found or before middleware');
  }
});

test('3.4.4.3-D', ' They rearrange routes alphabetically and break security', () => {
  console.log('  The file should have a comment marking the public/protected boundary');
  console.log('  Without a comment, the next developer does not know the ordering matters');
  console.log('  They rearrange routes alphabetically and break security');
  var hasComment = apiSource.includes('public') && apiSource.includes('protect') ||
    apiSource.includes('Public') && apiSource.includes('Protect') ||
    apiSource.includes('// ── Auth') || apiSource.includes('// ── Require') ||
    apiSource.includes('// Auth middleware') || apiSource.includes('// Protected');
  check('Boundary comment exists', hasComment,
    'comment marking boundary', 'no boundary comment');
});

test('3.4.4.4-D', ' Route handlers must not check req.user for access control', () => {
  console.log('  Route handlers must not check req.user for access control');
  console.log('  Access control is the middleware\'s job');
  console.log('  Handlers may READ req.user for display or logging — but not for gating');
  var lines = apiSource.split('\n');
  var gatingPatterns = lines.filter(l =>
    (l.includes('req.user') && (l.includes('if') || l.includes('!req.user') || l.includes('=== null'))) &&
    !l.trim().startsWith('//') && !l.trim().startsWith('*')
  );
  check('No req.user access control in handlers', gatingPatterns.length === 0,
    '0 gating patterns', gatingPatterns.length + ' found');
});

test('3.4.4.5-D', ' Route count sanity check — all 16 routes defined', () => {
  console.log('  Route count sanity check — the file must define all 16 routes');
  console.log('  If a route is missing, it was accidentally deleted during refactoring');
  var allPaths = [
    '/api/status', '/api/posts', '/api/posts/:id', '/api/posts/:id/approve',
    '/api/posts/:id/reject', '/api/mode', '/api/pause', '/api/corroboration',
    '/api/generate-preview', '/api/save-preview', '/api/force-cycle',
    '/api/research/stats', '/api/research/articles', '/api/research/poll',
    '/api/logs', '/api/linkedin/status'
  ];
  for (var p of allPaths) {
    check(p + ' defined', apiSource.includes(p), 'present', 'missing');
  }
});

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
