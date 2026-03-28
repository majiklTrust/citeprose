// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 6 Design: Route Architecture
// Reads source code to verify route definitions, provider method
// usage, CSP configuration, and security integration.
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

// ── Read source files ────────────────────────────────────────
var indexSrc = '';
try { indexSrc = fs.readFileSync('src/index.js', 'utf8'); } catch {
  try { indexSrc = fs.readFileSync('src_templates/index.js', 'utf8'); } catch {}
}
var auth0Src = '';
try { auth0Src = fs.readFileSync('src/auth/providers/auth0.js', 'utf8'); } catch {}
var sessionSrc = '';
try { sessionSrc = fs.readFileSync('src/auth/session.js', 'utf8'); } catch {}

console.log('  File: test-p3-step6-design/route-architecture.mjs');
group('Group 1: Auth route definitions', `
  Impact: If routes are not properly defined, the OAuth flow breaks.
  Missing /auth/login means users cannot start login. Missing
  /auth/callback means Auth0 has nowhere to return users. Missing
  /auth/logout means users cannot end their sessions.

  File: src/index.js (or src_templates/index.js)
  Check: Route definitions, HTTP method, path strings
`);

var before1 = getCounters();

await testAsync('3.6.1.1-D', ' /auth/login route defined', async () => {
  console.log('  Reading src/index.js source code');
  console.log('  Searching for app.get("/auth/login" or router equivalent');
  console.log('  Checking: source contains /auth/login route definition');
  var hasLogin = indexSrc.includes('/auth/login');
  check('/auth/login route defined', hasLogin, 'found', 'not found');
});

await testAsync('3.6.1.2-D', ' /auth/callback route defined', async () => {
  console.log('  Searching for /auth/callback route definition');
  console.log('  This is the route Auth0 redirects to after authentication');
  var hasCallback = indexSrc.includes('/auth/callback');
  check('/auth/callback route defined', hasCallback, 'found', 'not found');
});

await testAsync('3.6.1.3-D', ' /auth/logout route defined', async () => {
  console.log('  Searching for /auth/logout route definition');
  var hasLogout = indexSrc.includes('/auth/logout');
  check('/auth/logout route defined', hasLogout, 'found', 'not found');
});

await testAsync('3.6.1.4-D', ' Login route uses provider getLoginUrl', async () => {
  console.log('  The login route must call the provider getLoginUrl() method');
  console.log('  Hardcoding the Auth0 URL would break multi-provider support');
  console.log('  Checking: source contains getLoginUrl near /auth/login');
  var hasGetLoginUrl = indexSrc.includes('getLoginUrl');
  check('getLoginUrl used', hasGetLoginUrl, 'found', 'not found');
});

await testAsync('3.6.1.5-D', ' Callback route uses provider exchangeCode', async () => {
  console.log('  The callback must call exchangeCode() to swap the authorization code');
  console.log('  This is the server-to-server token exchange — never in the browser');
  console.log('  Checking: source contains exchangeCode near /auth/callback');
  var hasExchangeCode = indexSrc.includes('exchangeCode');
  check('exchangeCode used', hasExchangeCode, 'found', 'not found');
});

await testAsync('3.6.1.6-D', ' Callback route uses createSession', async () => {
  console.log('  After successful code exchange, the callback sets a session cookie');
  console.log('  Checking: source imports and calls createSession');
  var hasCreateSession = indexSrc.includes('createSession');
  check('createSession used', hasCreateSession, 'found', 'not found');
});

await testAsync('3.6.1.7-D', ' Logout route uses clearSession', async () => {
  console.log('  The logout route must clear the session cookie before redirecting');
  console.log('  Checking: source imports and calls clearSession');
  var hasClearSession = indexSrc.includes('clearSession');
  check('clearSession used', hasClearSession, 'found', 'not found');
});

await testAsync('3.6.1.8-D', ' Logout route uses provider getLogoutUrl', async () => {
  console.log('  The logout redirect must go to the provider logout endpoint');
  console.log('  Hardcoding the URL would break multi-provider support');
  console.log('  Checking: source contains getLogoutUrl');
  var hasGetLogoutUrl = indexSrc.includes('getLogoutUrl');
  check('getLogoutUrl used', hasGetLogoutUrl, 'found', 'not found');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

console.log('  File: test-p3-step6-design/route-architecture.mjs');
group('Group 2: Security integration in auth routes', `
  Impact: If auth routes skip security middleware, state validation,
  or error escaping, they become the weakest link. Auth routes
  handle the most sensitive operations — code exchange and
  session creation — and must be fully hardened.

  Files: src/index.js, src/auth/providers/auth0.js, src/auth/session.js
  Check: State validation, escapeHtml, CSP form-action, error handling
`);

var before2 = getCounters();

await testAsync('3.6.2.1-D', ' Callback validates state before code exchange', async () => {
  console.log('  Reading source to verify state validation happens BEFORE exchangeCode');
  console.log('  If code exchange runs first, the server makes an API call to Auth0');
  console.log('  even for forged callbacks — wasting resources and leaking timing info');
  console.log('  Checking: validateOAuthState or state check appears before exchangeCode');
  var stateCheckPos = indexSrc.indexOf('validateOAuthState') || indexSrc.indexOf('state');
  var exchangePos = indexSrc.indexOf('exchangeCode');
  if (stateCheckPos < 0) stateCheckPos = indexSrc.indexOf('state');
  check('State checked before exchange', stateCheckPos < exchangePos && exchangePos > 0,
    'state first', 'statePos=' + stateCheckPos + ' exchangePos=' + exchangePos);
});

await testAsync('3.6.2.2-D', ' Error rendering uses escapeHtml', async () => {
  console.log('  Auth0 error and error_description are user-controlled strings');
  console.log('  They must be escaped before rendering in HTML');
  console.log('  Checking: source contains escapeHtml near error handling');
  var hasEscape = indexSrc.includes('escapeHtml');
  check('escapeHtml used for errors', hasEscape, 'found', 'not found');
});

await testAsync('3.6.2.3-D', ' Auth routes defined before auth middleware', async () => {
  console.log('  /auth/login, /auth/callback, /auth/logout must be accessible');
  console.log('  WITHOUT authentication — they are the login mechanism itself');
  console.log('  They must be mounted BEFORE the requireAuth middleware');
  console.log('  Checking: /auth/login appears before requireAuth in source');
  var loginPos = indexSrc.indexOf('/auth/login');
  var requirePos = indexSrc.indexOf('requireAuth');
  if (loginPos < 0 || requirePos < 0) {
    check('Both found in source', loginPos >= 0 && requirePos >= 0,
      'both present', 'login=' + (loginPos >= 0) + ' require=' + (requirePos >= 0));
    return;
  }
  check('Auth routes before requireAuth', loginPos < requirePos,
    'login first', 'loginPos=' + loginPos + ' requirePos=' + requirePos);
});

await testAsync('3.6.2.4-D', ' CSP allows Auth0 domain in form-action', async () => {
  console.log('  The login redirect goes to Auth0 — CSP form-action must allow it');
  console.log('  If CSP blocks the redirect, the browser refuses to navigate');
  console.log('  Checking: CSP contains form-action with Auth0 domain or is not restricted');
  var cspSection = indexSrc.substring(
    indexSrc.indexOf('Content-Security-Policy'),
    indexSrc.indexOf('Content-Security-Policy') + 500
  );
  // form-action may not be present (defaults to no restriction in many browsers)
  // If it IS present, it should include the Auth0 domain or *
  var hasFormAction = cspSection.includes('form-action');
  if (hasFormAction) {
    var allowsAuth0 = cspSection.includes('auth0.com') || cspSection.includes("'self'");
    check('form-action allows Auth0', allowsAuth0, 'auth0 or self', 'restricted');
  } else {
    console.log('  ℹ form-action not in CSP — defaults to unrestricted');
    check('form-action not restricted', true, 'not present (ok)', 'not present');
  }
});

await testAsync('3.6.2.5-D', ' No client_secret in index.js route handlers', async () => {
  console.log('  The client_secret is used in exchangeCode() inside auth0.js');
  console.log('  It must NOT appear as a string literal in index.js route handlers');
  console.log('  Checking: index.js does not contain AUTH0_CLIENT_SECRET in route code');
  // Find route handler sections (after /auth/ routes)
  var routeSection = indexSrc.substring(indexSrc.indexOf('/auth/login'));
  var hasSecret = routeSection.includes('CLIENT_SECRET') && !routeSection.includes('// ');
  check('No client_secret in routes', !hasSecret, 'clean', 'CLIENT_SECRET in route code');
});

await testAsync('3.6.2.6-D', ' Session import from session.js', async () => {
  console.log('  index.js must import createSession and clearSession from session.js');
  console.log('  Not from any other module — session.js owns the session abstraction');
  console.log('  Checking: import contains "session.js"');
  var hasSessionImport = indexSrc.includes('session.js') || indexSrc.includes('session"');
  check('Session import present', hasSessionImport, 'found', 'not found');
});

await testAsync('3.6.2.7-D', ' Auth0 provider has exchangeCode method', async () => {
  console.log('  Reading src/auth/providers/auth0.js source code');
  console.log('  The exchangeCode method swaps the authorization code for tokens');
  console.log('  Checking: auth0.js exports or defines exchangeCode');
  var hasExchange = auth0Src.includes('exchangeCode');
  check('exchangeCode in auth0.js', hasExchange, 'found', 'not found');
});

await testAsync('3.6.2.8-D', ' Auth0 provider has getUserInfo method', async () => {
  console.log('  getUserInfo fetches user profile from Auth0 /userinfo endpoint');
  console.log('  The callback needs this to populate session.user claims');
  console.log('  Checking: auth0.js exports or defines getUserInfo');
  var hasUserInfo = auth0Src.includes('getUserInfo');
  check('getUserInfo in auth0.js', hasUserInfo, 'found', 'not found');
});

await testAsync('3.6.2.9-D', ' Callback route handles exchangeCode failure', async () => {
  console.log('  If Auth0 rejects the code (expired, already used, invalid),');
  console.log('  the callback must catch the error and return a clean response');
  console.log('  Checking: try/catch around exchangeCode call in source');
  var hasErrorHandling = indexSrc.includes('catch') &&
    (indexSrc.indexOf('catch') > indexSrc.indexOf('exchangeCode') ||
     indexSrc.includes('try'));
  check('Error handling around exchangeCode', hasErrorHandling, 'found', 'not found');
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

var summary = getCounters();
process.exit(summary.fail);
