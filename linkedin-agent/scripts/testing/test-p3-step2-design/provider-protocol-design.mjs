// ═══════════════════════════════════════════════════════════════
// Step 2 Design Groups 3, 4: Protocol & State Design
//
// OAuth and OIDC have specific requirements for URL construction,
// state management, and token exchange. If these are implemented
// loosely, login works with Auth0 today but breaks with WorkOS
// tomorrow — or breaks silently when Auth0 changes behavior.
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, check, getCounters } from '../lib/test-harness.mjs';
import auth0 from '../../../src/auth/providers/auth0.js';

// ── Group 3: OAuth/OIDC protocol compliance ──────────────────

console.log('  File: test-p3-step2-design/provider-protocol-design.mjs');
group('Group 3: OAuth/OIDC protocol compliance', `
  If these tests fail, the Auth0 provider constructs URLs or
  handles state in ways that violate the OAuth 2.0 or OIDC
  specification. Login may work with Auth0's lenient parser
  but fail with a stricter IDP.
`);

var before3 = getCounters();
process.env.AUTH0_DOMAIN = 'test.auth0.com'; process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'secret';

test('3.2.3.1-D', ' Issuer must have a trailing slash per OIDC Discovery spec', () => {
  console.log('  issuer must have a trailing slash per OIDC Discovery spec');
  console.log('  RFC 8414 §2: "The issuer identifier is a URL using the https scheme');
  console.log('  that contains scheme, host, and optionally, port number and path"');
  console.log('  Auth0 requires the trailing slash for issuer matching');
  var cfg = auth0._getConfig();
  check('Issuer ends with /', cfg.issuer.endsWith('/'), 'trailing /', cfg.issuer);
});

test('3.2.3.2-D', ' All URLs must use HTTPS (except localhost defaults)', () => {
  console.log('  All URLs must use HTTPS (except localhost defaults)');
  console.log('  OAuth 2.0 spec requires TLS for authorization and token endpoints');
  var cfg = auth0._getConfig();
  var urls = [cfg.issuer, cfg.jwksUri, cfg.authorizationUrl, cfg.tokenUrl, cfg.userInfoUrl, cfg.logoutUrl];
  for (var url of urls) {
    check(url.substring(0, 40) + ' uses HTTPS', url.startsWith('https://'),
      'https://', url.substring(0, 8));
  }
});

test('3.2.3.3-D', ' GetLoginUrl must produce a URL with response_type=code', () => {
  console.log('  getLoginUrl must produce a URL with response_type=code');
  console.log('  "code" is the authorization code flow — the most secure OAuth grant');
  console.log('  "token" (implicit flow) is deprecated by OAuth 2.1');
  var parsed = new URL(auth0.getLoginUrl('s'));
  check('response_type is code', parsed.searchParams.get('response_type') === 'code',
    'code', parsed.searchParams.get('response_type'));
});

test('3.2.3.4-D', ' GetLoginUrl must include all 6 required OAuth parameters', () => {
  console.log('  getLoginUrl must include all 6 required OAuth parameters');
  console.log('  Missing any one causes Auth0 to reject or misroute the request');
  var parsed = new URL(auth0.getLoginUrl('test_state'));
  var required = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state'];
  for (var p of required) {
    check('Login URL has ' + p, parsed.searchParams.get(p) !== null,
      'present', 'missing');
  }
});

test('3.2.3.5-D', ' OIDC tokens include sub, email, name — OAuth tokens do not', () => {
  console.log('  getLoginUrl must include scope=openid (minimum OIDC requirement)');
  console.log('  Without "openid" in scope, Auth0 returns an OAuth token, not an OIDC token');
  console.log('  OIDC tokens include sub, email, name — OAuth tokens do not');
  var parsed = new URL(auth0.getLoginUrl('s'));
  var scopes = parsed.searchParams.get('scope') || '';
  check('Scope includes "openid"', scopes.includes('openid'),
    'includes openid', scopes);
});

test('3.2.3.6-D', ' CSRF state must be 256-bit entropy (64 hex chars)', () => {
  console.log('  CSRF state must be 256-bit entropy (64 hex chars)');
  console.log('  Shorter states are brute-forceable. Longer wastes URL space.');
  console.log('  256 bits matches the security level of AES-256');
  var state = auth0._generateState();
  check('State length is 64 chars', state.length === 64, '64', String(state.length));
  check('State is hexadecimal', /^[0-9a-f]+$/.test(state), 'hex chars', 'non-hex');
  auth0._validateState(state);
});

test('3.2.3.7-D', ' CSRF state must be single-use (consumed on validation)', () => {
  console.log('  CSRF state must be single-use (consumed on validation)');
  console.log('  Replay prevention: a captured state cannot be reused in a second callback');
  var state = auth0._generateState();
  auth0._validateState(state);
  check('State consumed after first validation', !auth0._validateState(state),
    'rejected on reuse', 'accepted on reuse');
});

test('3.2.3.8-D', ' GetLogoutUrl must include client_id parameter', () => {
  console.log('  getLogoutUrl must include client_id parameter');
  console.log('  Auth0 requires client_id in logout to match the application');
  var parsed = new URL(auth0.getLogoutUrl('https://example.com'));
  check('Logout includes client_id', parsed.searchParams.get('client_id') !== null,
    'present', 'missing');
});

test('3.2.3.9-D', ' GetLogoutUrl must include returnTo parameter', () => {
  console.log('  getLogoutUrl must include returnTo parameter');
  console.log('  Without returnTo, Auth0 shows its own logout page — not your app');
  var parsed = new URL(auth0.getLogoutUrl('https://example.com'));
  check('Logout includes returnTo', parsed.searchParams.get('returnTo') !== null,
    'present', 'missing');
});

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Group 4: Configuration isolation ─────────────────────────

console.log('  File: test-p3-step2-design/provider-protocol-design.mjs');
group('Group 4: Configuration isolation', `
  If these tests fail, one env var change at runtime affects
  in-flight requests. Or a test that modifies AUTH0_DOMAIN
  poisons the config for subsequent tests. Config must be
  read fresh each time and never cached as a mutable singleton.
`);

var before4 = getCounters();

test('3.2.4.1-D', ' _getConfig must read env vars on each call', () => {
  console.log('  _getConfig must read env vars on each call');
  console.log('  Setting AUTH0_DOMAIN=a, calling _getConfig, changing to b, calling again');
  console.log('  If the second call returns "a", the config is cached — stale');
  process.env.AUTH0_DOMAIN = 'first.auth0.com';
  process.env.AUTH0_CLIENT_ID = 'cid'; process.env.AUTH0_CLIENT_SECRET = 'secret';
  var c1 = auth0._getConfig();
  process.env.AUTH0_DOMAIN = 'second.auth0.com';
  var c2 = auth0._getConfig();
  check('Config reflects env var changes', c2.domain === 'second.auth0.com',
    'second.auth0.com', c2.domain);
  check('First config was different', c1.domain === 'first.auth0.com',
    'first.auth0.com', c1.domain);
});

test('3.2.4.2-D', ' Domain not mutated', () => {
  console.log('  Mutating a returned config object must not affect subsequent calls');
  console.log('  If _getConfig returns the same object, mutation poisons all reads');
  process.env.AUTH0_DOMAIN = 'clean.auth0.com';
  var c1 = auth0._getConfig();
  c1.domain = 'mutated.evil.com';
  c1.tokenUrl = 'https://evil.com/steal';
  var c2 = auth0._getConfig();
  check('Domain not mutated', c2.domain === 'clean.auth0.com',
    'clean.auth0.com', c2.domain);
  check('Token URL not mutated', c2.tokenUrl.includes('clean.auth0.com'),
    'clean.auth0.com URL', c2.tokenUrl);
});

test('3.2.4.3-D', ' IsConfigured must read env vars live, not from cached state', () => {
  console.log('  isConfigured must read env vars live, not from cached state');
  console.log('  This prevents stale "configured" status after env vars are removed');
  process.env.AUTH0_DOMAIN = 'test.auth0.com';
  process.env.AUTH0_CLIENT_ID = 'cid'; process.env.AUTH0_CLIENT_SECRET = 'secret';
  check('Configured with all vars', auth0.isConfigured(), 'true', 'false');
  delete process.env.AUTH0_CLIENT_SECRET;
  check('Not configured after removing secret', !auth0.isConfigured(), 'false', 'true');
});

test('3.2.4.4-D', ' Default values must only apply when env var is unset', () => {
  console.log('  Default values must only apply when env var is unset');
  console.log('  AUTH0_AUDIENCE defaults to "https://linkedin-agent-api"');
  console.log('  If the default overrides an explicit env var, custom audiences break');
  delete process.env.AUTH0_AUDIENCE;
  var c1 = auth0._getConfig();
  process.env.AUTH0_AUDIENCE = 'https://custom-api';
  var c2 = auth0._getConfig();
  check('Default audience applied when unset', c1.audience === 'https://linkedin-agent-api',
    'https://linkedin-agent-api', c1.audience);
  check('Custom audience overrides default', c2.audience === 'https://custom-api',
    'https://custom-api', c2.audience);
  delete process.env.AUTH0_AUDIENCE;
});

test('3.2.4.5-D', ' Domain normalization handles prefix/suffix combos', () => {
  console.log('  Domain normalization must handle all 4 prefix/suffix combinations');
  console.log('  Operators paste from different sources — browser, docs, dashboard');
  var cases = [
    ['test.auth0.com', 'test.auth0.com'],
    ['https://test.auth0.com', 'test.auth0.com'],
    ['test.auth0.com/', 'test.auth0.com'],
    ['https://test.auth0.com/', 'test.auth0.com'],
    ['http://test.auth0.com/', 'test.auth0.com'],
  ];
  for (var [input, expected] of cases) {
    process.env.AUTH0_DOMAIN = input;
    var actual = auth0._getConfig().domain;
    check(input + ' → ' + expected, actual === expected, expected, actual);
  }
});

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;
var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
