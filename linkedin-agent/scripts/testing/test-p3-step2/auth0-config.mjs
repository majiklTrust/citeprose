// ═══════════════════════════════════════════════════════════════
// Step 2 Groups 1, 2, 6: Auth0 Configuration
// Env var gating + domain normalization + init validation
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import auth0 from '../../../src/auth/providers/auth0.js';

// ── Group 1: Env var gating ──────────────────────────────────

group('Group 1: Env var gating', `
  If these tests fail, Auth0 could activate without proper
  credentials or fail to activate when credentials are present.
  Users cannot log in, or the system attempts auth with
  incomplete config — producing cryptic errors.
`);

var before1 = getCounters();

test('3.2.1.1', '', () => {
  console.log('  Clearing AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET');
  delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
  console.log('  Calling auth0.isConfigured() — should return false with zero credentials');
  check('Provider inactive when no env vars set', !auth0.isConfigured(), 'false', String(auth0.isConfigured()));
});

test('3.2.1.2', '', () => {
  console.log('  Setting AUTH0_DOMAIN=test.auth0.com (1 of 3 credentials)');
  process.env.AUTH0_DOMAIN = 'test.auth0.com';
  console.log('  Without client ID and secret, the provider cannot authenticate to Auth0');
  check('Provider inactive with only domain', !auth0.isConfigured(), 'false', String(auth0.isConfigured()));
});

test('3.2.1.3', '', () => {
  console.log('  Adding AUTH0_CLIENT_ID=cid (2 of 3 credentials)');
  process.env.AUTH0_CLIENT_ID = 'cid';
  console.log('  The client secret signs the token exchange — without it, login fails');
  check('Provider inactive without client secret', !auth0.isConfigured(), 'false', String(auth0.isConfigured()));
});

test('3.2.1.4', '', () => {
  console.log('  Adding AUTH0_CLIENT_SECRET=secret (3 of 3 credentials)');
  process.env.AUTH0_CLIENT_SECRET = 'secret';
  console.log('  All three present — the only combination that enables login');
  check('Provider activates with all three', auth0.isConfigured(), 'true', String(auth0.isConfigured()));
});

test('3.2.1.5', '', () => {
  console.log('  Setting AUTH0_DOMAIN to empty string (simulates blank .env value)');
  process.env.AUTH0_DOMAIN = '';
  check('Provider rejects empty domain', !auth0.isConfigured(), 'false', String(auth0.isConfigured()));
});

test('3.2.1.6', '', () => {
  console.log('  Setting AUTH0_DOMAIN to whitespace-only');
  process.env.AUTH0_DOMAIN = '   ';
  console.log('  After trimming, domain is empty — same as missing');
  check('Provider rejects whitespace domain', !auth0.isConfigured(), 'false', String(auth0.isConfigured()));
});

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: Domain normalization ────────────────────────────

group('Group 2: Domain normalization', `
  If these tests fail, operators who paste the Auth0 domain with
  a protocol prefix or trailing slash get broken token exchange
  URLs. Login fails silently.
`);

var before2 = getCounters();
process.env.AUTH0_CLIENT_ID = 'cid'; process.env.AUTH0_CLIENT_SECRET = 'secret';

test('3.2.2.1', '', () => {
  console.log('  Setting AUTH0_DOMAIN=test.auth0.com (clean, no protocol)');
  process.env.AUTH0_DOMAIN = 'test.auth0.com';
  check('Clean domain accepted', auth0._getConfig().domain === 'test.auth0.com', 'test.auth0.com', auth0._getConfig().domain);
});

test('3.2.2.2', '', () => {
  console.log('  Setting AUTH0_DOMAIN=https://test.auth0.com');
  process.env.AUTH0_DOMAIN = 'https://test.auth0.com';
  check('https:// prefix stripped', auth0._getConfig().domain === 'test.auth0.com', 'test.auth0.com', auth0._getConfig().domain);
});

test('3.2.2.3', '', () => {
  console.log('  Setting AUTH0_DOMAIN=http://test.auth0.com/');
  process.env.AUTH0_DOMAIN = 'http://test.auth0.com/';
  check('http:// and trailing / stripped', auth0._getConfig().domain === 'test.auth0.com', 'test.auth0.com', auth0._getConfig().domain);
});

test('3.2.2.4', '', () => {
  console.log('  Setting AUTH0_DOMAIN=test.auth0.com/');
  process.env.AUTH0_DOMAIN = 'test.auth0.com/';
  check('Trailing / stripped', auth0._getConfig().domain === 'test.auth0.com', 'test.auth0.com', auth0._getConfig().domain);
});

test('3.2.2.5', '', () => {
  process.env.AUTH0_DOMAIN = 'https://test.auth0.com/';
  var cfg = auth0._getConfig();
  console.log('  Verifying issuer URL — must have trailing slash per OIDC spec');
  check('Issuer URL correct', cfg.issuer === 'https://test.auth0.com/', 'https://test.auth0.com/', cfg.issuer);
});

test('3.2.2.6', '', () => {
  var cfg = auth0._getConfig();
  console.log('  JWKS URI is where signing keys are published');
  check('JWKS URI correct', cfg.jwksUri === 'https://test.auth0.com/.well-known/jwks.json', 'https://test.auth0.com/.well-known/jwks.json', cfg.jwksUri);
});

test('3.2.2.7', '', () => {
  var cfg = auth0._getConfig();
  console.log('  Token URL is called during code→token exchange');
  check('Token URL correct', cfg.tokenUrl === 'https://test.auth0.com/oauth/token', 'https://test.auth0.com/oauth/token', cfg.tokenUrl);
});

test('3.2.2.8', '', () => {
  var cfg = auth0._getConfig();
  console.log('  UserInfo URL retrieves the authenticated user profile');
  check('UserInfo URL correct', cfg.userInfoUrl === 'https://test.auth0.com/userinfo', 'https://test.auth0.com/userinfo', cfg.userInfoUrl);
});

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Group 6: Init validation ─────────────────────────────────

group('Group 6: Init validation', `
  If these tests fail, the app starts with invalid Auth0 config
  that fails on every login attempt. Users see broken login
  pages with no clear error.
`);

var before6 = getCounters();

await testAsync('3.2.6.1', '', async () => {
  console.log('  Calling init() with AUTH0_DOMAIN missing');
  process.env.AUTH0_CLIENT_ID = 'cid'; process.env.AUTH0_CLIENT_SECRET = 'secret'; delete process.env.AUTH0_DOMAIN;
  try { await auth0.init(); check('Missing domain caught', false, 'throws', 'succeeded'); }
  catch (e) { check('Missing domain caught', e.message.includes('AUTH0_DOMAIN'), 'mentions AUTH0_DOMAIN', e.message.substring(0, 60)); }
});

await testAsync('3.2.6.2', '', async () => {
  console.log('  Setting AUTH0_DOMAIN=nodots (no dots)');
  process.env.AUTH0_DOMAIN = 'nodots';
  try { await auth0.init(); check('No-dot domain caught', false, 'throws', 'succeeded'); }
  catch (e) { check('No-dot domain caught', e.message.includes('appears invalid'), 'mentions invalid', e.message.substring(0, 60)); }
});

await testAsync('3.2.6.3', '', async () => {
  console.log('  Setting AUTH0_DOMAIN with spaces');
  process.env.AUTH0_DOMAIN = 'has spaces.auth0.com';
  try { await auth0.init(); check('Spaces caught', false, 'throws', 'succeeded'); }
  catch (e) { check('Domain with spaces caught', e.message.includes('appears invalid'), 'mentions invalid', e.message.substring(0, 60)); }
});

await testAsync('3.2.6.4', '', async () => {
  console.log('  Calling init() without AUTH0_CLIENT_SECRET');
  process.env.AUTH0_DOMAIN = 'test.auth0.com'; delete process.env.AUTH0_CLIENT_SECRET;
  try { await auth0.init(); check('Missing secret caught', false, 'throws', 'succeeded'); }
  catch (e) { check('Missing secret caught', e.message.includes('AUTH0_CLIENT_SECRET'), 'mentions AUTH0_CLIENT_SECRET', e.message.substring(0, 60)); }
});

await testAsync('3.2.6.5', '', async () => {
  console.log('  Calling init() with all three valid credentials');
  process.env.AUTH0_DOMAIN = 'test.auth0.com'; process.env.AUTH0_CLIENT_ID = 'cid'; process.env.AUTH0_CLIENT_SECRET = 'secret';
  try { await auth0.init(); check('Valid config passes init', auth0._isInitialized(), 'initialized', 'not initialized'); }
  catch (e) { check('Valid config passes init', false, 'succeeds', 'threw: ' + e.message); }
});

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
var after6 = getCounters();
groupEnd(after6.pass - before6.pass, after6.fail - before6.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
