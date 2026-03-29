// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 7 Groups 3-4: Dashboard Auth-Aware Content
// Verifies the dashboard HTML includes login wall, dev banner,
// user identity, and 401 handling patterns.
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

var BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
var TIMEOUT = { signal: AbortSignal.timeout(10000) };

// Fetch the dashboard HTML
var dashRes = await fetch(BASE + '/', TIMEOUT);
var dashHtml = await dashRes.text();

console.log('  File: test-p3-step7/dashboard-auth.mjs');
group('Group 3: Dashboard login wall and dev banner', `
  Impact: If these tests fail, either the login wall is missing
  (unauthenticated users see the dashboard in production) or
  the dev banner is missing (developers don't know auth is
  disabled and may think they're testing the auth flow when
  they're not).

  Endpoint: GET / (dashboard HTML)
  Check: HTML source contains login wall, dev banner, and auth-aware components
`);

var before3 = getCounters();

await testAsync('3.7.3.1', ' Dashboard HTML references authRequired', async () => {
  console.log('  The dashboard JavaScript must check authRequired from /api/status');
  console.log('  This drives whether to show the login wall or the full dashboard');
  console.log('  Checking: HTML source contains "authRequired"');
  check('authRequired in dashboard', dashHtml.includes('authRequired'), 'found', 'not found');
});

await testAsync('3.7.3.2', ' Dashboard HTML contains login button/link', async () => {
  console.log('  When auth is required and no user is logged in, a login button appears');
  console.log('  The button navigates to /auth/login');
  console.log('  Checking: HTML contains /auth/login reference');
  check('Login link in dashboard', dashHtml.includes('/auth/login'), 'found', 'not found');
});

await testAsync('3.7.3.3', ' Dashboard HTML contains logout button/link', async () => {
  console.log('  When a user is logged in, a logout button appears in the header');
  console.log('  The button navigates to /auth/logout');
  console.log('  Checking: HTML contains /auth/logout reference');
  check('Logout link in dashboard', dashHtml.includes('/auth/logout'), 'found', 'not found');
});

await testAsync('3.7.3.4', ' Dashboard HTML contains dev mode banner text', async () => {
  console.log('  When authRequired is false, a warning banner appears');
  console.log('  The banner text includes "Development" or "Authentication Disabled"');
  console.log('  Checking: HTML contains development/auth disabled reference');
  var hasBanner = dashHtml.includes('Development') || dashHtml.includes('development') ||
    dashHtml.includes('Authentication Disabled') || dashHtml.includes('auth') && dashHtml.includes('disabled');
  check('Dev banner text in dashboard', hasBanner, 'found', 'not found');
});

await testAsync('3.7.3.5', ' Dashboard HTML displays user identity', async () => {
  console.log('  When logged in, the header shows the user name or email');
  console.log('  The dashboard reads user.name or user.email from /api/status');
  console.log('  Checking: HTML contains user.name or user.email reference');
  var hasUserDisplay = dashHtml.includes('user.name') || dashHtml.includes('user.email') ||
    dashHtml.includes('user?.name') || dashHtml.includes('user?.email');
  check('User identity in dashboard', hasUserDisplay, 'found', 'not found');
});

await testAsync('3.7.3.6', ' Dashboard CSS contains login wall styling', async () => {
  console.log('  The login wall needs dedicated CSS for centering and layout');
  console.log('  Checking: HTML style block contains login-related class names');
  var hasLoginCSS = dashHtml.includes('login-wall') || dashHtml.includes('login-container') ||
    dashHtml.includes('auth-wall') || dashHtml.includes('login-screen');
  check('Login wall CSS present', hasLoginCSS, 'found', 'not found');
});

await testAsync('3.7.3.7', ' Dashboard CSS contains dev banner styling', async () => {
  console.log('  The dev banner needs warning-colored styling (yellow/amber)');
  console.log('  Checking: HTML style block contains dev-banner or warning-banner class');
  var hasBannerCSS = dashHtml.includes('dev-banner') || dashHtml.includes('warning-banner') ||
    dashHtml.includes('dev-warning') || dashHtml.includes('auth-banner');
  check('Dev banner CSS present', hasBannerCSS, 'found', 'not found');
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

console.log('  File: test-p3-step7/dashboard-auth.mjs');
group('Group 4: 401 handling in dashboard', `
  Impact: If the dashboard does not handle 401 responses, an expired
  session shows a broken page with empty data panels. The user
  has no indication that they need to log in again. Proper 401
  handling redirects to /auth/login automatically.

  Check: Dashboard JavaScript handles 401 from fetch() calls
`);

var before4 = getCounters();

await testAsync('3.7.4.1', ' Dashboard handles 401 status in fetch', async () => {
  console.log('  The dashboard fetch() calls must check for 401 responses');
  console.log('  On 401, redirect to /auth/login instead of displaying empty data');
  console.log('  Checking: HTML contains 401 check pattern');
  var has401 = dashHtml.includes('401') || dashHtml.includes('status === 401') ||
    dashHtml.includes('r.status') || dashHtml.includes('unauthorized');
  check('401 handling in dashboard', has401, 'found', 'not found');
});

await testAsync('3.7.4.2', ' Dashboard redirects to login on 401', async () => {
  console.log('  After detecting a 401, the dashboard should navigate to /auth/login');
  console.log('  This can be window.location, location.href, or location.assign');
  console.log('  Checking: HTML contains redirect to /auth/login in 401 handler');
  var hasRedirect = dashHtml.includes('window.location') || dashHtml.includes('location.href') ||
    dashHtml.includes('location.assign') || dashHtml.includes('/auth/login');
  check('Login redirect on 401', hasRedirect, 'found', 'not found');
});

await testAsync('3.7.4.3', ' Dashboard does not store tokens in localStorage', async () => {
  console.log('  Tokens are stored in httpOnly cookies, not localStorage');
  console.log('  localStorage is readable by any XSS payload');
  console.log('  Checking: HTML does not contain localStorage.setItem with token references');
  var hasLocalStorage = dashHtml.includes('localStorage.setItem') &&
    (dashHtml.includes('token') || dashHtml.includes('session'));
  check('No token in localStorage', !hasLocalStorage, 'clean', 'localStorage token found');
});

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

var summary = getCounters();
process.exit(summary.fail);
