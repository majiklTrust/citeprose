// ═══════════════════════════════════════════════════════════════
// Step 1 Groups 1-2: Registry Basics
// Interface contract + Dev mode (no providers needed)
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, check, getCounters } from '../lib/test-harness.mjs';
import { PROVIDER_INTERFACE, initRegistry, getProviders, getDefaultProvider,
         getJwksMap, getIssuers, isAuthEnabled, isAuthRequired,
         _resetForTesting } from '../../../src/auth/index.js';

// ── Group 1: Interface contract ──────────────────────────────

console.log('  File: test-p3-step1/registry-basics.mjs');
group('Group 1: Interface contract', `
  If these tests fail, new authentication providers (Auth0, WorkOS,
  or any future IDP) cannot be integrated. The platform is locked
  to a single auth method with no standard way to add alternatives.
`);

var g1 = { p: 0, f: 0 };
var before = getCounters();

var expectedFields = ['name','type','priority','issuer','jwksUri','audience','clientId'];
var expectedMethods = ['isConfigured','init','getRoutes','getLoginUrl','exchangeCode','getUserInfo','getLogoutUrl'];

test('3.1.1.1', '  PROVIDER_INTERFACE.fields from registry export', () => {
  console.log('  Reading PROVIDER_INTERFACE.fields from registry export');
  console.log('  The contract must define exactly 7 fields for provider identity and config');
  check('Contract defines exactly 7 required fields',
    PROVIDER_INTERFACE.fields.length === 7, '7 fields', PROVIDER_INTERFACE.fields.length + ' fields');
});

test('3.1.1.2', '  PROVIDER_INTERFACE.methods from registry export', () => {
  console.log('  Reading PROVIDER_INTERFACE.methods from registry export');
  console.log('  The contract must define exactly 7 methods for auth lifecycle');
  check('Contract defines exactly 7 required methods',
    PROVIDER_INTERFACE.methods.length === 7, '7 methods', PROVIDER_INTERFACE.methods.length + ' methods');
});

var fieldDescriptions = {
  name: 'unique provider identification in the registry',
  type: 'protocol detection (oidc vs saml)',
  priority: 'default provider selection when multiple are active',
  issuer: 'JWT iss claim validation — must match token issuer',
  jwksUri: 'public key retrieval for signature verification',
  audience: 'JWT aud claim validation — ensures token is for our API',
  clientId: 'OAuth client identification with the IDP'
};

for (var [idx, f] of expectedFields.entries()) {
  test('3.1.1.' + (3 + idx), '', () => {
    console.log('  Checking if field "' + f + '" exists in the contract');
    console.log('  Required for: ' + fieldDescriptions[f]);
    check('Required field: ' + f, PROVIDER_INTERFACE.fields.includes(f), f + ' in list', 'missing');
  });
}

var methodDescriptions = {
  isConfigured: 'env var gating — prevents activation without credentials',
  init: 'startup validation and cache warming',
  getRoutes: 'mounting provider-specific Express routes',
  getLoginUrl: 'generating the IDP redirect URL for user login',
  exchangeCode: 'swapping auth code for access tokens after callback',
  getUserInfo: 'retrieving user profile from IDP',
  getLogoutUrl: 'generating the IDP logout redirect URL'
};

for (var [idx2, m] of expectedMethods.entries()) {
  test('3.1.1.' + (10 + idx2), '', () => {
    console.log('  Checking if method "' + m + '" exists in the contract');
    console.log('  Required for: ' + methodDescriptions[m]);
    check('Required method: ' + m, PROVIDER_INTERFACE.methods.includes(m), m + ' in list', 'missing');
  });
}

var after1 = getCounters();
groupEnd(after1.pass - before.pass, after1.fail - before.fail);

// ── Group 2: Dev mode — no providers ─────────────────────────

console.log('  File: test-p3-step1/registry-basics.mjs');
group('Group 2: Dev mode — no providers', `
  If these tests fail, developers cannot run the application
  locally without configuring a full auth provider. This blocks
  all local development and testing workflows.
`);

var before2 = getCounters();

_resetForTesting();
delete process.env.MOCK_AUTH_ENABLED;
delete process.env.NODE_ENV;
var result = await initRegistry(() => {});

test('3.1.2.1', ' Initialized registry with no provider env vars set', () => {
  console.log('  Initialized registry with no provider env vars set');
  console.log('  In dev mode, the app should start with auth off — not crash');
  check('App starts without auth when no providers configured',
    result.authEnabled === false, 'authEnabled === false', 'authEnabled === ' + result.authEnabled);
});

test('3.1.2.2', ' Providers map size — should be empty', () => {
  console.log('  Checking providers map size — should be empty');
  check('No providers in the registry',
    result.providers.size === 0, '0 providers', result.providers.size + ' providers');
});

test('3.1.2.3', ' isAuthEnabled() confirms auth is off', () => {
  console.log('  Calling isAuthEnabled() — returns the runtime auth enforcement state');
  console.log('  With no providers, this must be false so middleware passes requests through');
  check('isAuthEnabled() confirms auth is off',
    isAuthEnabled() === false, 'false', String(isAuthEnabled()));
});

test('3.1.2.4', ' Without NODE_ENV=production, auth should not be mandatory', () => {
  console.log('  Calling isAuthRequired() — reflects NODE_ENV enforcement policy');
  console.log('  Without NODE_ENV=production, auth should not be mandatory');
  check('isAuthRequired() confirms auth not mandatory',
    isAuthRequired() === false, 'false', String(isAuthRequired()));
});

test('3.1.2.5', '  getProviders() — sorted list of active providers', () => {
  console.log('  Calling getProviders() — sorted list of active providers');
  check('getProviders() returns empty list',
    getProviders().length === 0, 'empty array', getProviders().length + ' providers');
});

test('3.1.2.6', ' getDefaultProvider() returns null', () => {
  console.log('  Calling getDefaultProvider() — the highest-priority active provider');
  console.log('  With no providers loaded, must return null (not undefined or throw)');
  check('getDefaultProvider() returns null',
    getDefaultProvider() === null, 'null', String(getDefaultProvider()));
});

test('3.1.2.7', '  getJwksMap() — maps issuers to JWKS endpoints', () => {
  console.log('  Calling getJwksMap() — maps issuers to JWKS endpoints');
  console.log('  Empty map means the middleware has no keys to validate against');
  check('getJwksMap() returns empty map',
    getJwksMap().size === 0, 'empty map', getJwksMap().size + ' entries');
});

test('3.1.2.8', '  getIssuers() — list of trusted token issuers', () => {
  console.log('  Calling getIssuers() — list of trusted token issuers');
  console.log('  Empty means no issuer is trusted — all tokens rejected if auth is on');
  check('getIssuers() returns empty list',
    getIssuers().length === 0, 'empty array', getIssuers().length + ' issuers');
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
