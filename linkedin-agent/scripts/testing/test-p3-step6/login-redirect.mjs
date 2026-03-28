// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 6 Group 1: Login Redirect
// Verifies GET /auth/login constructs a correct Auth0
// authorization URL and redirects the browser to it.
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

var BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
var TIMEOUT = { signal: AbortSignal.timeout(10000) };

console.log('  File: test-p3-step6/login-redirect.mjs');
group('Group 1: Login redirect to Auth0', `
  Impact: If these tests fail, users cannot log in. Clicking "Log In"
  on the dashboard must redirect to Auth0's Universal Login page
  with the correct parameters. A malformed redirect URL causes
  Auth0 to show an error instead of the login form.

  Route under test: GET /auth/login
  Expected: 302 redirect to https://{AUTH0_DOMAIN}/authorize?...
  Dependencies: Auth0 provider getLoginUrl(), OAuth state generation
`);

var before1 = getCounters();

// Fetch the login route without following redirects
var loginRes = null;
var locationUrl = null;
var locationParsed = null;

await testAsync('3.6.1.1', ' Login route returns a redirect', async () => {
  console.log('  Sending GET /auth/login with redirect:manual to capture the Location header');
  console.log('  The route must return 302 Found, not 200 OK');
  console.log('  A 200 would render a page instead of redirecting to Auth0');
  console.log('  Checking: response status is 302');
  loginRes = await fetch(BASE + '/auth/login', { ...TIMEOUT, redirect: 'manual' });
  check('Login returns 302', loginRes.status === 302, '302', String(loginRes.status));
});

await testAsync('3.6.1.2', ' Location header is present', async () => {
  console.log('  The 302 response must include a Location header with the Auth0 URL');
  console.log('  Without Location, the browser has nowhere to redirect');
  console.log('  Checking: Location header is a non-empty string');
  var location = loginRes?.headers?.get('location') || '';
  locationUrl = location;
  check('Location header present', location.length > 0, 'non-empty', 'missing or empty');
});

await testAsync('3.6.1.3', ' Redirect goes to Auth0 domain', async () => {
  console.log('  Reading AUTH0_DOMAIN from the redirect URL');
  console.log('  The Location must start with https://{AUTH0_DOMAIN}/authorize');
  console.log('  If it points elsewhere, the user is sent to an unknown site');
  console.log('  Checking: URL starts with https:// and contains /authorize');
  var isAuth0 = locationUrl.startsWith('https://') && locationUrl.includes('/authorize');
  check('Redirects to Auth0 /authorize', isAuth0, 'https://.../authorize', locationUrl.substring(0, 60));
});

await testAsync('3.6.1.4', ' Redirect includes client_id', async () => {
  console.log('  Auth0 needs client_id to identify which application is requesting login');
  console.log('  Checking: URL query string contains client_id=');
  try { locationParsed = new URL(locationUrl); } catch { locationParsed = null; }
  var clientId = locationParsed?.searchParams?.get('client_id') || '';
  check('client_id present', clientId.length > 0, 'non-empty', 'missing');
});

await testAsync('3.6.1.5', ' Redirect includes redirect_uri', async () => {
  console.log('  After Auth0 authenticates the user, it sends them back to redirect_uri');
  console.log('  This must match what is configured in Auth0 dashboard (Allowed Callback URLs)');
  console.log('  Checking: URL contains redirect_uri= pointing to /auth/callback');
  var redirectUri = locationParsed?.searchParams?.get('redirect_uri') || '';
  check('redirect_uri present', redirectUri.includes('/auth/callback'), 'contains /auth/callback', redirectUri || 'missing');
});

await testAsync('3.6.1.6', ' Redirect includes response_type=code', async () => {
  console.log('  response_type=code means we are using the Authorization Code Flow');
  console.log('  This is the most secure OAuth flow for server-side applications');
  console.log('  The alternative (response_type=token) is the Implicit Flow — less secure');
  console.log('  Checking: response_type parameter === "code"');
  var responseType = locationParsed?.searchParams?.get('response_type') || '';
  check('response_type is code', responseType === 'code', 'code', responseType || 'missing');
});

await testAsync('3.6.1.7', ' Redirect includes scope with openid', async () => {
  console.log('  The scope parameter tells Auth0 what information to return');
  console.log('  "openid" is required for OIDC — without it, Auth0 returns OAuth-only tokens');
  console.log('  Checking: scope parameter includes "openid"');
  var scope = locationParsed?.searchParams?.get('scope') || '';
  check('Scope includes openid', scope.includes('openid'), 'includes openid', scope || 'missing');
});

await testAsync('3.6.1.8', ' Redirect includes state parameter', async () => {
  console.log('  The state parameter is a CSRF token — prevents forged callback URLs');
  console.log('  It must be a random string generated by the server');
  console.log('  Checking: state parameter is present and non-empty');
  var state = locationParsed?.searchParams?.get('state') || '';
  check('State parameter present', state.length > 0, 'non-empty', 'missing');
});

await testAsync('3.6.1.9', ' Redirect does NOT include client_secret', async () => {
  console.log('  The client_secret is used server-to-server during token exchange');
  console.log('  It must NEVER appear in a browser-visible URL');
  console.log('  If it does, anyone viewing the URL bar or browser history has the secret');
  console.log('  Checking: URL does not contain client_secret=');
  var hasSecret = locationUrl.includes('client_secret=') || locationUrl.includes('client_secret%3D');
  check('No client_secret in URL', !hasSecret, 'absent', 'CLIENT_SECRET IN REDIRECT URL');
});

await testAsync('3.6.1.10', ' Redirect includes audience parameter', async () => {
  console.log('  The audience parameter tells Auth0 which API the token is for');
  console.log('  Without it, Auth0 issues an opaque token instead of a JWT');
  console.log('  Checking: audience parameter is present');
  var audience = locationParsed?.searchParams?.get('audience') || '';
  check('Audience parameter present', audience.length > 0, 'non-empty', audience || 'missing');
});

await testAsync('3.6.1.11', ' Two login requests produce different state values', async () => {
  console.log('  Sending a second GET /auth/login to compare state values');
  console.log('  Each login attempt must generate a unique state');
  console.log('  If state is reused, replay attacks become possible');
  console.log('  Checking: state1 !== state2');
  var state1 = locationParsed?.searchParams?.get('state') || '';
  var res2 = await fetch(BASE + '/auth/login', { ...TIMEOUT, redirect: 'manual' });
  var loc2 = res2.headers?.get('location') || '';
  var state2 = '';
  try { state2 = new URL(loc2).searchParams.get('state') || ''; } catch {}
  check('States are unique', state1 !== state2 && state1.length > 0, 'different', 'state1=' + state1.substring(0, 16) + ' state2=' + state2.substring(0, 16));
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

var summary = getCounters();
process.exit(summary.fail);
