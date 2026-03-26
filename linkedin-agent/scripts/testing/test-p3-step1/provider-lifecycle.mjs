// ═══════════════════════════════════════════════════════════════
// Step 1 Groups 3-4: Provider Lifecycle
// Mock activation + provider method validation
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { initRegistry, getProviders, getProvider, getDefaultProvider,
         getJwksMap, getIssuers, isAuthEnabled,
         _resetForTesting } from '../../../src/auth/index.js';

// ── Group 3: Mock provider activation ────────────────────────

group('Group 3: Mock provider activation', `
  If these tests fail, the test infrastructure is broken. No
  automated auth testing can run without external IDP credentials,
  slowing every dev cycle.
`);

var before3 = getCounters();

_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
var result = await initRegistry(() => {});

test('3.1.3.1', '', () => {
  console.log('  MOCK_AUTH_ENABLED=true — registry should discover and load mock.js');
  check('Auth enabled with provider configured',
    result.authEnabled === true, 'true', String(result.authEnabled));
});

test('3.1.3.2', '', () => {
  console.log('  Checking providers map — should contain exactly 1 provider');
  check('Exactly 1 provider loaded',
    result.providers.size === 1, '1', String(result.providers.size));
});

test('3.1.3.3', '', () => {
  console.log('  isAuthEnabled() should now be true — middleware will enforce tokens');
  check('Auth enforcement is active',
    isAuthEnabled() === true, 'true', String(isAuthEnabled()));
});

var mock = getProvider('mock');

test('3.1.3.4', '', () => {
  console.log('  Calling getProvider("mock") — lookup by registered name');
  check('Provider retrievable by name', mock !== null, 'non-null', String(mock));
});

test('3.1.3.5', '', () => {
  console.log('  Verifying the returned provider name matches registration');
  check('Provider name matches', mock?.name === 'mock', 'mock', String(mock?.name));
});

test('3.1.3.6', '', () => {
  console.log('  Provider type determines which protocol the middleware uses');
  check('Provider type is OIDC', mock?.type === 'oidc', 'oidc', String(mock?.type));
});

test('3.1.3.7', '', () => {
  console.log('  The issuer URL is compared against the iss claim in every JWT');
  console.log('  A mismatch means all tokens from this provider are rejected');
  check('Issuer URL set', mock?.issuer === 'https://mock-auth.test/', 'https://mock-auth.test/', String(mock?.issuer));
});

test('3.1.3.8', '', () => {
  console.log('  The JWKS URI is where the middleware fetches public keys');
  check('JWKS URI set', mock?.jwksUri === 'https://mock-auth.test/.well-known/jwks.json',
    'https://mock-auth.test/.well-known/jwks.json', String(mock?.jwksUri));
});

test('3.1.3.9', '', () => {
  console.log('  The audience must match the aud claim — ensures token is for our API');
  check('Audience set', mock?.audience === 'https://linkedin-agent-api',
    'https://linkedin-agent-api', String(mock?.audience));
});

test('3.1.3.10', '', () => {
  console.log('  Client ID identifies our application to the IDP');
  check('Client ID set', mock?.clientId === 'mock_client_001', 'mock_client_001', String(mock?.clientId));
});

test('3.1.3.11', '', () => {
  console.log('  Priority determines default when multiple providers active');
  console.log('  Mock uses 999 (low) so real providers always take precedence');
  check('Priority is 999', mock?.priority === 999, '999', String(mock?.priority));
});

test('3.1.3.12', '', () => {
  console.log('  getDefaultProvider() returns the highest-priority (lowest number) provider');
  check('Default provider is mock', getDefaultProvider()?.name === 'mock', 'mock', String(getDefaultProvider()?.name));
});

test('3.1.3.13', '', () => {
  console.log('  getIssuers() builds the allowlist the middleware checks tokens against');
  check('Issuers list includes mock', getIssuers().includes('https://mock-auth.test/'),
    'includes mock issuer', JSON.stringify(getIssuers()));
});

test('3.1.3.14', '', () => {
  console.log('  getJwksMap() maps each issuer to its JWKS endpoint for key retrieval');
  check('JWKS map contains mock issuer', getJwksMap().has('https://mock-auth.test/'),
    'has mock issuer', JSON.stringify([...getJwksMap().keys()]));
});

test('3.1.3.15', '', () => {
  console.log('  Looking up a provider name that was never registered — must return null');
  check('Unknown provider returns null', getProvider('nonexistent') === null, 'null', String(getProvider('nonexistent')));
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Group 4: Provider method validation ──────────────────────

group('Group 4: Provider method validation', `
  If these tests fail, login, token exchange, user identity
  retrieval, or logout do not work. The dashboard is inaccessible.
`);

var before4 = getCounters();

await testAsync('3.1.4.1', '', async () => {
  console.log('  Calling mock.exchangeCode("test_code_123")');
  console.log('  Simulates the OAuth code→token exchange after login callback');
  var tokens = await mock.exchangeCode('test_code_123');
  check('Returns an access token',
    typeof tokens.accessToken === 'string' && tokens.accessToken.startsWith('mock_access_'),
    'string starting with mock_access_', String(tokens.accessToken?.substring(0, 20)));

  check('Returns an ID token',
    typeof tokens.idToken === 'string', 'string', typeof tokens.idToken);

  check('Returns expiry duration',
    tokens.expiresIn === 86400, '86400 (24 hours)', String(tokens.expiresIn));

  check('Returns type Bearer',
    tokens.tokenType === 'Bearer', 'Bearer', String(tokens.tokenType));
});

await testAsync('3.1.4.5', '', async () => {
  console.log('  Calling mock.getUserInfo() with the access token');
  console.log('  Retrieves the user profile the dashboard displays');
  var tokens = await mock.exchangeCode('test_code');
  var user = await mock.getUserInfo(tokens.accessToken);

  check('User has unique subject ID',
    user.sub === 'mock_user_001', 'mock_user_001', String(user.sub));

  check('User has display name',
    user.name === 'Test User', 'Test User', String(user.name));

  check('User has email',
    user.email === 'test@example.com', 'test@example.com', String(user.email));

  check('Email is verified',
    user.emailVerified === true, 'true', String(user.emailVerified));

  check('Provider identified',
    user.provider === 'mock', 'mock', String(user.provider));
});

test('3.1.4.10', '', () => {
  console.log('  Calling mock.getLoginUrl("state_abc")');
  console.log('  The state parameter is the CSRF token preventing auth hijacking');
  var loginUrl = mock.getLoginUrl('state_abc');
  check('Login URL includes auth route',
    loginUrl.includes('/auth/mock/login'), 'contains /auth/mock/login', loginUrl);

  check('Login URL includes CSRF state',
    loginUrl.includes('state_abc'), 'contains state_abc', loginUrl);
});

test('3.1.4.12', '', () => {
  console.log('  Calling mock.getLogoutUrl("https://example.com")');
  console.log('  After logout, user should land on the specified return page');
  var logoutUrl = mock.getLogoutUrl('https://example.com');
  check('Logout URL includes logout route',
    logoutUrl.includes('/auth/mock/logout'), 'contains /auth/mock/logout', logoutUrl);

  check('Logout URL includes return destination',
    logoutUrl.includes('example.com'), 'contains example.com', logoutUrl);
});

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
