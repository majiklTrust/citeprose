// ═══════════════════════════════════════════════════════════════
// Step 2 Design Groups 1, 2: Provider Module Design
//
// The Auth0 provider is a self-contained unit. If it leaks
// internals, couples to the registry, or exposes mutable
// config, every consumer is at risk of breaking when Auth0
// changes their API or we add a second provider.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { group, groupEnd, test, check, getCounters } from '../lib/test-harness.mjs';
import auth0 from '../../../src/auth/providers/auth0.js';

// ── Group 1: Provider encapsulation ──────────────────────────

group('Group 1: Auth0 provider encapsulation', `
  If these tests fail, the Auth0 provider exposes internals
  that consumers couple to. When Auth0 changes their OIDC
  discovery format or token endpoint, the change ripples
  through the entire codebase instead of being contained
  in one file.
`);

var before1 = getCounters();

test('3.2.1.1-D', '', () => {
  console.log('  auth0.js must have a default export (the provider object)');
  console.log('  The registry loads providers via dynamic import and reads .default');
  check('Default export exists', auth0 !== undefined && auth0 !== null,
    'non-null', String(auth0));
});

test('3.2.1.2-D', '', () => {
  console.log('  The provider object must implement all 7 interface fields');
  var fields = ['name', 'type', 'priority', 'issuer', 'jwksUri', 'audience', 'clientId'];
  for (var f of fields) {
    check('Field "' + f + '" exists', auth0[f] !== undefined,
      'defined', 'undefined');
  }
});

test('3.2.1.3-D', '', () => {
  console.log('  The provider object must implement all 7 interface methods');
  var methods = ['isConfigured', 'init', 'getRoutes', 'getLoginUrl', 'exchangeCode', 'getUserInfo', 'getLogoutUrl'];
  for (var m of methods) {
    check('Method "' + m + '" is function', typeof auth0[m] === 'function',
      'function', typeof auth0[m]);
  }
});

test('3.2.1.4-D', '', () => {
  console.log('  auth0.js must not import from the registry (index.js)');
  console.log('  Providers are loaded BY the registry — importing it creates a circular dep');
  var src = fs.readFileSync('src/auth/providers/auth0.js', 'utf8');
  check('No registry import', !src.includes('/auth/index') && !src.includes("from '../index"),
    'clean', 'imports registry');
});

test('3.2.1.5-D', '', () => {
  console.log('  auth0.js must not import jose directly');
  console.log('  Token verification goes through jwt-verifier.js — single jose touchpoint');
  var src = fs.readFileSync('src/auth/providers/auth0.js', 'utf8');
  check('No jose import', !src.includes("from 'jose'") && !src.includes('from "jose"'),
    'clean', 'imports jose');
});

test('3.2.1.6-D', '', () => {
  console.log('  auth0.js must not import from middleware.js');
  console.log('  Providers do not know about HTTP middleware — they are protocol adapters');
  var src = fs.readFileSync('src/auth/providers/auth0.js', 'utf8');
  check('No middleware import', !src.includes('/middleware'),
    'clean', 'imports middleware');
});

test('3.2.1.7-D', '', () => {
  console.log('  auth0.js must not import from src/routes/ or src/services/');
  console.log('  The provider is a foundational auth component — no business logic deps');
  var src = fs.readFileSync('src/auth/providers/auth0.js', 'utf8');
  check('No routes import', !src.includes('/routes/'), 'clean', 'imports routes');
  check('No services import', !src.includes('/services/'), 'clean', 'imports services');
});

test('3.2.1.8-D', '', () => {
  console.log('  provider.name must be a string constant, not computed');
  console.log('  The registry uses name as a Map key — if it changes at runtime,');
  console.log('  lookups break silently');
  check('name is "auth0"', auth0.name === 'auth0', 'auth0', String(auth0.name));
});

test('3.2.1.9-D', '', () => {
  console.log('  provider.type must be "oidc"');
  console.log('  The middleware uses type to select the verification strategy');
  check('type is "oidc"', auth0.type === 'oidc', 'oidc', String(auth0.type));
});

test('3.2.1.10-D', '', () => {
  console.log('  provider.priority must be a positive integer');
  console.log('  Priority determines default provider selection — must be deterministic');
  check('priority is positive integer',
    typeof auth0.priority === 'number' && auth0.priority > 0 && Number.isInteger(auth0.priority),
    'positive integer', String(auth0.priority));
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: Test helper discipline ──────────────────────────

group('Group 2: Test helper discipline', `
  If these tests fail, test helpers expose or mutate production
  state. A _getConfig that returns the live config object lets
  tests change production credentials. A _validateState that
  works in production lets attackers bypass CSRF checks.
`);

var before2 = getCounters();

test('3.2.2.1-D', '', () => {
  console.log('  Test helpers must be prefixed with underscore');
  console.log('  Convention: _method means "internal, not part of public interface"');
  console.log('  Checking that public methods do NOT start with underscore');
  var publicMethods = ['isConfigured', 'init', 'getRoutes', 'getLoginUrl',
    'exchangeCode', 'getUserInfo', 'getLogoutUrl'];
  for (var m of publicMethods) {
    check(m + ' is not prefixed with _', !m.startsWith('_'),
      'no underscore', 'prefixed');
  }
});

test('3.2.2.2-D', '', () => {
  console.log('  _getConfig must exist for testing (used in Step 2 functional tests)');
  console.log('  It allows tests to verify domain normalization without calling init()');
  check('_getConfig exists', typeof auth0._getConfig === 'function',
    'function', typeof auth0._getConfig);
});

test('3.2.2.3-D', '', () => {
  console.log('  _getConfig must return a new object each call (not mutable internal ref)');
  console.log('  If it returns the same object, tests can mutate production config');
  process.env.AUTH0_DOMAIN = 'test.auth0.com';
  process.env.AUTH0_CLIENT_ID = 'cid';
  process.env.AUTH0_CLIENT_SECRET = 'secret';
  var c1 = auth0._getConfig();
  var c2 = auth0._getConfig();
  check('_getConfig returns different objects', c1 !== c2,
    'different refs', 'same ref (mutable)');
  delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
});

test('3.2.2.4-D', '', () => {
  console.log('  _generateState and _validateState must exist for testing');
  console.log('  Tests verify CSRF state without triggering a full OAuth flow');
  check('_generateState exists', typeof auth0._generateState === 'function',
    'function', typeof auth0._generateState);
  check('_validateState exists', typeof auth0._validateState === 'function',
    'function', typeof auth0._validateState);
});

test('3.2.2.5-D', '', () => {
  console.log('  BLOCKED_DOMAIN_PATTERNS or equivalent must exist in source');
  console.log('  The SSRF blocklist must be a named constant, not inline regex');
  console.log('  A named constant documents intent and survives refactoring');
  var src = fs.readFileSync('src/auth/providers/auth0.js', 'utf8');
  check('SSRF blocklist is a named constant',
    src.includes('BLOCKED_DOMAIN') || src.includes('DOMAIN_BLOCKLIST') || src.includes('BLOCKED_PATTERNS'),
    'named constant', 'no blocklist constant found');
});

test('3.2.2.6-D', '', () => {
  console.log('  STATE_TTL_MS or equivalent must exist in source');
  console.log('  The CSRF state expiration must be a named constant');
  console.log('  A magic number for TTL gets changed without understanding the security impact');
  var src = fs.readFileSync('src/auth/providers/auth0.js', 'utf8');
  check('State TTL is a named constant',
    src.includes('STATE_TTL') || src.includes('STATE_EXPIR'),
    'named constant', 'no TTL constant found');
});

test('3.2.2.7-D', '', () => {
  console.log('  DISCOVERY_TTL_MS or equivalent must exist in source');
  console.log('  The OIDC discovery cache TTL determines how quickly key rotation takes effect');
  var src = fs.readFileSync('src/auth/providers/auth0.js', 'utf8');
  check('Discovery TTL is a named constant',
    src.includes('DISCOVERY_TTL') || src.includes('CACHE_TTL'),
    'named constant', 'no discovery TTL found');
});

test('3.2.2.8-D', '', () => {
  console.log('  Auth0 provider must have a shutdown method');
  console.log('  Shutdown clears CSRF states, discovery cache, and init flag');
  console.log('  Without it, stale state persists across hot reloads');
  check('shutdown method exists', typeof auth0.shutdown === 'function',
    'function', typeof auth0.shutdown);
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
