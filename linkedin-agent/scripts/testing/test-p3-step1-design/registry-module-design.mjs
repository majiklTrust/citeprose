// ═══════════════════════════════════════════════════════════════
// Step 1 Design Groups 1, 2: Registry Module Design
//
// The registry is the foundation of multi-provider auth.
// If its exports are wrong, every consumer couples to internals.
// If the provider interface is ambiguous, every new provider
// implements it differently.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import * as registry from '../../../src/auth/index.js';

// ── Group 1: Registry export contracts ───────────────────────

console.log('  File: test-p3-step1-design/registry-module-design.mjs');
group('Group 1: Registry export contracts', `
  If these tests fail, consumers of the registry cannot rely
  on a stable API. Adding a second IDP or refactoring the
  auth layer breaks every file that imports from index.js.
`);

var before1 = getCounters();

test('3.1.1.1-D', ' InitRegistry must be a named async function export', () => {
  console.log('  initRegistry must be a named async function export');
  console.log('  Named exports enforce consistent naming across the codebase');
  console.log('  Async because provider init() calls may involve network');
  check('initRegistry is named export', typeof registry.initRegistry === 'function',
    'function', typeof registry.initRegistry);
});

test('3.1.1.2-D', ' _resetForTesting must be exported for test isolation', () => {
  console.log('  _resetForTesting must be exported for test isolation');
  console.log('  Without reset, tests share registry state — order-dependent failures');
  check('_resetForTesting is named export', typeof registry._resetForTesting === 'function',
    'function', typeof registry._resetForTesting);
});

test('3.1.1.3-D', ' Query functions must all be named exports', () => {
  console.log('  Query functions must all be named exports');
  console.log('  These are the public read API — consumers should never reach into internals');
  var queryExports = ['getProviders', 'getProvider', 'getDefaultProvider',
    'getJwksMap', 'getIssuers', 'isAuthEnabled', 'isAuthRequired', 'getSnapshotByIssuer'];
  for (var name of queryExports) {
    check(name + ' is named export', typeof registry[name] === 'function',
      'function', typeof registry[name]);
  }
});

test('3.1.1.4-D', ' ShutdownRegistry must be exported for graceful shutdown', () => {
  console.log('  shutdownRegistry must be exported for graceful shutdown');
  console.log('  Without shutdown, provider connections leak on server restart');
  check('shutdownRegistry is named export', typeof registry.shutdownRegistry === 'function',
    'function', typeof registry.shutdownRegistry);
});

test('3.1.1.5-D', ' New providers reference this to know what to implement', () => {
  console.log('  PROVIDER_INTERFACE must be exported as the contract definition');
  console.log('  New providers reference this to know what to implement');
  check('PROVIDER_INTERFACE is named export',
    registry.PROVIDER_INTERFACE !== undefined && typeof registry.PROVIDER_INTERFACE === 'object',
    'object', typeof registry.PROVIDER_INTERFACE);
});

test('3.1.1.6-D', ' Registry must NOT have a default export', () => {
  console.log('  Registry must NOT have a default export');
  console.log('  Default exports allow import-as-anything, hiding module identity');
  check('No default export', registry.default === undefined,
    'undefined', typeof registry.default);
});

test('3.1.1.7-D', ' Registry must not export the internal activeProviders Map', () => {
  console.log('  Registry must not export the internal activeProviders Map');
  console.log('  Direct access to the Map bypasses snapshot protection');
  console.log('  Consumers must use getProvider/getProviders/getJwksMap');
  var exportNames = Object.keys(registry);
  check('activeProviders not exported',
    !exportNames.includes('activeProviders'),
    'not in exports', 'exported directly');
});

test('3.1.1.8-D', ' Registry must not export the internal providerSnapshots Map', () => {
  console.log('  Registry must not export the internal providerSnapshots Map');
  console.log('  Snapshots are accessed through getSnapshotByIssuer — not directly');
  var exportNames = Object.keys(registry);
  check('providerSnapshots not exported',
    !exportNames.includes('providerSnapshots'),
    'not in exports', 'exported directly');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: Provider interface and discovery ────────────────

console.log('  File: test-p3-step1-design/registry-module-design.mjs');
group('Group 2: Provider interface and file discovery', `
  If these tests fail, the provider interface is ambiguous or
  the discovery mechanism is fragile. A new provider author
  has no clear contract to implement, or a misplaced file
  crashes the entire registry.
`);

var before2 = getCounters();

test('3.1.2.1-D', ' PROVIDER_INTERFACE must define both fields and methods', () => {
  console.log('  PROVIDER_INTERFACE must define both fields and methods');
  console.log('  Fields are static identity (name, issuer, jwksUri)');
  console.log('  Methods are lifecycle operations (init, getLoginUrl, exchangeCode)');
  check('Has fields array', Array.isArray(registry.PROVIDER_INTERFACE.fields),
    'array', typeof registry.PROVIDER_INTERFACE.fields);
  check('Has methods array', Array.isArray(registry.PROVIDER_INTERFACE.methods),
    'array', typeof registry.PROVIDER_INTERFACE.methods);
});

test('3.1.2.2-D', ' Fields must include the 7 identity properties', () => {
  console.log('  Fields must include the 7 identity properties');
  console.log('  name: unique registry key');
  console.log('  type: protocol (oidc/saml)');
  console.log('  priority: default selection order');
  console.log('  issuer: JWT iss claim validation');
  console.log('  jwksUri: public key endpoint');
  console.log('  audience: JWT aud claim validation');
  console.log('  clientId: OAuth client identification');
  var required = ['name', 'type', 'priority', 'issuer', 'jwksUri', 'audience', 'clientId'];
  for (var f of required) {
    check('Field "' + f + '" in contract', registry.PROVIDER_INTERFACE.fields.includes(f),
      'present', 'missing');
  }
});

test('3.1.2.3-D', ' Methods must include the 7 lifecycle operations', () => {
  console.log('  Methods must include the 7 lifecycle operations');
  var required = ['isConfigured', 'init', 'getRoutes', 'getLoginUrl',
    'exchangeCode', 'getUserInfo', 'getLogoutUrl'];
  for (var m of required) {
    check('Method "' + m + '" in contract', registry.PROVIDER_INTERFACE.methods.includes(m),
      'present', 'missing');
  }
});

test('3.1.2.4-D', ' The providers directory must exist at src/auth/providers/', () => {
  console.log('  The providers directory must exist at src/auth/providers/');
  console.log('  The registry scans this directory for provider files');
  console.log('  If it does not exist, the scan returns zero providers silently');
  check('providers/ directory exists', fs.existsSync('src/auth/providers'),
    'exists', 'missing');
});

test('3.1.2.5-D', ' Provider files must be .js files in src/auth/providers/', () => {
  console.log('  Provider files must be .js files in src/auth/providers/');
  console.log('  Non-.js files (README.md, .gitkeep) must not crash the scanner');
  var files = fs.readdirSync('src/auth/providers');
  var jsFiles = files.filter(f => f.endsWith('.js'));
  check('At least 1 provider .js file exists', jsFiles.length >= 1,
    '≥1', String(jsFiles.length));
});

test('3.1.2.6-D', ' Index.js must not import from src/routes/ or src/services/', () => {
  console.log('  index.js must not import from src/routes/ or src/services/');
  console.log('  The registry is a foundational layer — no upward dependencies');
  var src = fs.readFileSync('src/auth/index.js', 'utf8');
  check('No routes import', !src.includes('/routes/'), 'clean', 'imports routes');
  check('No services import', !src.includes('/services/'), 'clean', 'imports services');
});

test('3.1.2.7-D', ' Index.js must not import jose', () => {
  console.log('  index.js must not import jose');
  console.log('  JWT verification is jwt-verifier.js responsibility');
  console.log('  The registry manages providers — it does not parse tokens');
  var src = fs.readFileSync('src/auth/index.js', 'utf8');
  check('No jose import', !src.includes("from 'jose'") && !src.includes('from "jose"'),
    'clean', 'imports jose');
});

test('3.1.2.8-D', ' Index.js must not import any specific provider directly', () => {
  console.log('  index.js must not import any specific provider directly');
  console.log('  Providers are discovered via file scan, not hard-coded imports');
  console.log('  Hard-coding means adding a provider requires editing the registry');
  var src = fs.readFileSync('src/auth/index.js', 'utf8');
  check('No auth0 import', !src.includes("from './providers/auth0") && !src.includes("from '../providers/auth0"),
    'clean', 'imports auth0');
  check('No mock import', !src.includes("from './providers/mock") && !src.includes("from '../providers/mock"),
    'clean', 'imports mock');
});

test('3.1.2.9-D', ' InitRegistry must accept a logger function parameter', () => {
  console.log('  initRegistry must accept a logger function parameter');
  console.log('  Dependency injection for logging — not hard-coded console.log');
  console.log('  Checking function parameter count');
  check('initRegistry takes at least 1 parameter', registry.initRegistry.length >= 1,
    '≥1', String(registry.initRegistry.length));
});

test('3.1.2.10-D', ' INIT_TIMEOUT_MS or equivalent must exist in source', () => {
  console.log('  INIT_TIMEOUT_MS or equivalent must exist in source');
  console.log('  A named constant for the provider init timeout');
  console.log('  Without it, the timeout is a magic number that gets removed in cleanup');
  var src = fs.readFileSync('src/auth/index.js', 'utf8');
  check('Init timeout is a named constant',
    src.includes('INIT_TIMEOUT') || src.includes('PROVIDER_TIMEOUT'),
    'named constant', 'no timeout constant found');
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
