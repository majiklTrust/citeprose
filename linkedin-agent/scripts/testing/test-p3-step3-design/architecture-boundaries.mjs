// ═══════════════════════════════════════════════════════════════
// Step 3 Design Groups 1, 2: Architecture Boundaries
//
// These tests do not check whether tokens verify correctly.
// They check whether the code is organized in a way that
// survives growth, refactoring, and contributor handoff.
//
// A module that works today but has the wrong shape will
// break silently when a second developer adds a feature.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

// ── Import each module to inspect its exports ────────────────

var jwtVerifier = await import('../../../src/auth/jwt-verifier.js');
var middleware = await import('../../../src/auth/middleware.js');
var registry = await import('../../../src/auth/index.js');

// ── Group 1: Module export contracts ─────────────────────────

console.log('  File: test-p3-step3-design/architecture-boundaries.mjs');
group('Group 1: Module export contracts', `
  If these tests fail, consumers of these modules cannot rely
  on a stable API. Every downstream file that imports auth
  code is coupled to implementation details instead of a
  defined interface. Adding a second IDP breaks the imports.
`);

var before1 = getCounters();

test('3.3.1.1-D', ' Jwt-verifier.js must export verifyToken as a named function', () => {
  console.log('  jwt-verifier.js must export verifyToken as a named function');
  console.log('  This is the single entry point for all token verification');
  console.log('  If it is a class, method, or default export, consumers couple differently');
  check('verifyToken is named export', typeof jwtVerifier.verifyToken === 'function',
    'named function', typeof jwtVerifier.verifyToken);
});

test('3.3.1.2-D', ' Without this, key rotation requires a server restart', () => {
  console.log('  jwt-verifier.js must export clearJwksCache as a named function');
  console.log('  Without this, key rotation requires a server restart');
  check('clearJwksCache is named export', typeof jwtVerifier.clearJwksCache === 'function',
    'named function', typeof jwtVerifier.clearJwksCache);
});

test('3.3.1.3-D', ' Jwt-verifier.js must NOT have a default export', () => {
  console.log('  jwt-verifier.js must NOT have a default export');
  console.log('  A default export encourages import-as-anything, hiding the module identity');
  console.log('  Named exports enforce consistent naming across the codebase');
  check('No default export from jwt-verifier', jwtVerifier.default === undefined,
    'undefined', typeof jwtVerifier.default);
});

test('3.3.1.4-D', ' This prevents shared state between Express apps in tests', () => {
  console.log('  middleware.js must export createAuthMiddleware as a named function');
  console.log('  The factory pattern (create*) signals that each call returns fresh middleware');
  console.log('  This prevents shared state between Express apps in tests');
  check('createAuthMiddleware is named export', typeof middleware.createAuthMiddleware === 'function',
    'named function', typeof middleware.createAuthMiddleware);
});

test('3.3.1.5-D', ' No direct requireAuth export', () => {
  console.log('  middleware.js must NOT export requireAuth or optionalAuth directly');
  console.log('  Direct exports would be singletons — shared state across the process');
  console.log('  The factory pattern returns fresh instances bound to a specific logger');
  check('No direct requireAuth export', middleware.requireAuth === undefined,
    'undefined', typeof middleware.requireAuth);
  check('No direct optionalAuth export', middleware.optionalAuth === undefined,
    'undefined', typeof middleware.optionalAuth);
});

test('3.3.1.6-D', ' Testing: call with a mock logger, verify it does not throw', () => {
  console.log('  createAuthMiddleware must accept a logger function as its argument');
  console.log('  Dependency injection for logging — no hard-coded console.log inside middleware');
  console.log('  Testing: call with a mock logger, verify it does not throw');
  var result = middleware.createAuthMiddleware(() => {});
  check('Factory accepts logger and returns object', typeof result === 'object' && result !== null,
    'object', typeof result);
});

test('3.3.1.7-D', ' The factory must return both requireAuth and optionalAuth', () => {
  console.log('  The factory must return both requireAuth and optionalAuth');
  console.log('  Both are needed — requireAuth for protected routes, optionalAuth for public');
  var result = middleware.createAuthMiddleware(() => {});
  check('Factory returns requireAuth', typeof result.requireAuth === 'function',
    'function', typeof result.requireAuth);
  check('Factory returns optionalAuth', typeof result.optionalAuth === 'function',
    'function', typeof result.optionalAuth);
});

test('3.3.1.8-D', ' requireAuth takes 3 args', () => {
  console.log('  requireAuth and optionalAuth must be Express middleware shaped');
  console.log('  Express middleware takes (req, res, next) — exactly 3 arguments');
  console.log('  If the function takes 4 args, Express treats it as an error handler');
  var result = middleware.createAuthMiddleware(() => {});
  check('requireAuth takes 3 args', result.requireAuth.length === 3,
    '3 (req, res, next)', String(result.requireAuth.length));
  check('optionalAuth takes 3 args', result.optionalAuth.length === 3,
    '3 (req, res, next)', String(result.optionalAuth.length));
});

test('3.3.1.9-D', ' If they share state, one test app pollutes another', () => {
  console.log('  Two calls to createAuthMiddleware must return independent instances');
  console.log('  If they share state, one test app pollutes another');
  var m1 = middleware.createAuthMiddleware(() => {});
  var m2 = middleware.createAuthMiddleware(() => {});
  check('Two factories return different requireAuth',
    m1.requireAuth !== m2.requireAuth, 'different refs', 'same ref');
  check('Two factories return different optionalAuth',
    m1.optionalAuth !== m2.optionalAuth, 'different refs', 'same ref');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: Single responsibility enforcement ───────────────

console.log('  File: test-p3-step3-design/architecture-boundaries.mjs');
group('Group 2: Single responsibility enforcement', `
  If these tests fail, responsibilities are tangled across
  modules. A change to token verification breaks middleware,
  or a change to provider loading breaks JWT parsing. Each
  bug fix becomes a game of whack-a-mole across multiple files.
`);

var before2 = getCounters();

test('3.3.2.1-D', ' Jwt-verifier.js must not import from middleware.js', () => {
  console.log('  jwt-verifier.js must not import from middleware.js');
  console.log('  Token verification is a pure input→output operation');
  console.log('  If it imports middleware, the verifier knows about HTTP — wrong layer');
  var src = fs.readFileSync('src/auth/jwt-verifier.js', 'utf8');
  check('jwt-verifier does not import middleware',
    !src.includes('./middleware') && !src.includes('../middleware'),
    'no middleware import', 'imports middleware');
});

test('3.3.2.2-D', ' Jwt-verifier.js must not import from index.js (the registry)', () => {
  console.log('  jwt-verifier.js must not import from index.js (the registry)');
  console.log('  The verifier should not know which providers exist');
  console.log('  It receives issuer, jwksUri, audience as arguments — pure parameters');
  var src = fs.readFileSync('src/auth/jwt-verifier.js', 'utf8');
  check('jwt-verifier does not import registry',
    !src.includes('./index') && !src.includes('../index') && !src.includes('../auth/index'),
    'no registry import', 'imports registry');
});

test('3.3.2.3-D', ' Jwt-verifier.js must not import any provider (auth0, mock)', () => {
  console.log('  jwt-verifier.js must not import any provider (auth0, mock)');
  console.log('  The verifier is provider-agnostic — it works with any OIDC issuer');
  var src = fs.readFileSync('src/auth/jwt-verifier.js', 'utf8');
  var importLines = src.split('\n').filter(l => l.includes('import ') || l.includes('require('));
  var importsProvider = importLines.some(l =>
    l.includes('/providers/') || l.includes('auth0') || l.includes('mock'));
  check('jwt-verifier does not import providers',
    !importsProvider,
    'no provider imports', 'imports a provider: ' + importLines.filter(l => l.includes('provider') || l.includes('auth0') || l.includes('mock')).join('; '));
});

test('3.3.2.4-D', ' Middleware.js must not import jose directly', () => {
  console.log('  middleware.js must not import jose directly');
  console.log('  All jose interaction must go through jwt-verifier.js');
  console.log('  If middleware imports jose, there are two places to update on jose upgrade');
  var src = fs.readFileSync('src/auth/middleware.js', 'utf8');
  check('middleware does not import jose',
    !src.includes("from 'jose'") && !src.includes('from "jose"'),
    'no jose import', 'imports jose');
});

test('3.3.2.5-D', ' Middleware.js must import verifyToken from jwt-verifier.js', () => {
  console.log('  middleware.js must import verifyToken from jwt-verifier.js');
  console.log('  This is the only path from HTTP request to token validation');
  console.log('  If middleware reimplements verification, the abstraction is broken');
  var src = fs.readFileSync('src/auth/middleware.js', 'utf8');
  check('middleware imports verifyToken from jwt-verifier',
    src.includes('verifyToken') && src.includes('jwt-verifier'),
    'imports verifyToken', 'missing import');
});

test('3.3.2.6-D', ' Middleware.js must import from index.js for provider lookups', () => {
  console.log('  middleware.js must import from index.js for provider lookups');
  console.log('  The middleware needs isAuthEnabled, getJwksMap, getIssuers');
  console.log('  If it queries providers directly, the snapshot abstraction is bypassed');
  var src = fs.readFileSync('src/auth/middleware.js', 'utf8');
  check('middleware imports from registry',
    src.includes('./index') || src.includes('../auth/index'),
    'imports registry', 'no registry import');
});

test('3.3.2.7-D', ' GetProviders returns live objects — mutable after init', () => {
  console.log('  middleware.js must use getSnapshotByIssuer (not getProviders) for audience');
  console.log('  getProviders returns live objects — mutable after init');
  console.log('  getSnapshotByIssuer returns frozen copies — immune to post-init mutation');
  var src = fs.readFileSync('src/auth/middleware.js', 'utf8');
  check('middleware uses getSnapshotByIssuer',
    src.includes('getSnapshotByIssuer'),
    'uses snapshot lookup', 'uses live provider lookup');
});

test('3.3.2.8-D', ' Index.js (registry) must not import jose', () => {
  console.log('  index.js (registry) must not import jose');
  console.log('  The registry manages providers — it should not know about JWT format');
  var src = fs.readFileSync('src/auth/index.js', 'utf8');
  check('registry does not import jose',
    !src.includes("from 'jose'") && !src.includes('from "jose"'),
    'no jose import', 'imports jose');
});

test('3.3.2.9-D', ' Function does not reference process.env or global', () => {
  console.log('  verifyToken must be a pure function — no side effects beyond cache');
  console.log('  It must not write to process.env, global, or modify arguments');
  console.log('  Checking: function does not reference process.env or global');
  var src = fs.readFileSync('src/auth/jwt-verifier.js', 'utf8');
  check('verifyToken does not reference process.env',
    !src.includes('process.env'), 'no process.env', 'references process.env');
  check('verifyToken does not reference global',
    !src.includes('global.') && !src.includes('globalThis.'),
    'no global refs', 'references global');
});

test('3.3.2.10-D', ' Auth layer has no upward dependencies', () => {
  console.log('  No file in src/auth/ should import from src/routes/ or src/services/');
  console.log('  Auth is a foundational layer — it must not depend on business logic');
  console.log('  If auth imports routes, a circular dependency forms on startup');
  var authFiles = ['src/auth/index.js', 'src/auth/jwt-verifier.js', 'src/auth/middleware.js'];
  var clean = true;
  for (var f of authFiles) {
    var src = fs.readFileSync(f, 'utf8');
    if (src.includes('/routes/') || src.includes('/services/')) {
      console.log('    ⚠ ' + f + ' imports from routes or services');
      clean = false;
    }
  }
  check('Auth layer has no upward dependencies', clean,
    'no routes/services imports', 'imports business logic');
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
