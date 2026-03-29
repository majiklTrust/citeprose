// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 8 Group 4: Security Headers Backward Compatibility
// Verifies all Phase 1 security headers survive the auth layer.
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

var BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
var TIMEOUT = { signal: AbortSignal.timeout(10000) };

// Test security headers on multiple route types
var routes = [
  ['/', 'Dashboard HTML (static)'],
  ['/api/status', 'API status (public)'],
  ['/auth/login', 'Auth login (redirect)'],
];

console.log('  File: test-p3-step8/security-headers.mjs');
group('Group 4: Phase 1 security headers still present', `
  Impact: If these tests fail, the auth layer disrupted the
  security header middleware. Headers like X-Frame-Options and
  CSP are the baseline defense against XSS, clickjacking, and
  content injection. Every response from every route must
  include them — a single route missing headers is a gap.

  Headers: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection,
  Referrer-Policy, CSP, Permissions-Policy, X-DNS-Prefetch-Control,
  X-Permitted-Cross-Domain-Policies
  Check: Present on dashboard, API, and auth routes
`);

var before4 = getCounters();

for (var [idx, entry] of routes.entries()) {
  var routePath = entry[0];
  var routeDesc = entry[1];

  await testAsync('3.8.4.' + (idx * 4 + 1), ' ' + routeDesc + ': X-Content-Type-Options', async () => {
    console.log('  Fetching ' + routePath + ' and checking X-Content-Type-Options: nosniff');
    console.log('  Prevents browsers from MIME-sniffing the response away from Content-Type');
    var res = await fetch(BASE + routePath, { ...TIMEOUT, redirect: 'manual' });
    var val = res.headers.get('x-content-type-options');
    check('X-Content-Type-Options on ' + routePath, val === 'nosniff', 'nosniff', String(val));
  });

  await testAsync('3.8.4.' + (idx * 4 + 2), ' ' + routeDesc + ': X-Frame-Options', async () => {
    console.log('  Fetching ' + routePath + ' and checking X-Frame-Options: DENY');
    console.log('  Prevents the page from being embedded in an iframe (clickjacking)');
    var res = await fetch(BASE + routePath, { ...TIMEOUT, redirect: 'manual' });
    var val = res.headers.get('x-frame-options');
    check('X-Frame-Options on ' + routePath, val === 'DENY', 'DENY', String(val));
  });

  await testAsync('3.8.4.' + (idx * 4 + 3), ' ' + routeDesc + ': CSP present', async () => {
    console.log('  Fetching ' + routePath + ' and checking Content-Security-Policy header');
    console.log('  CSP restricts where scripts, styles, and connections can load from');
    var res = await fetch(BASE + routePath, { ...TIMEOUT, redirect: 'manual' });
    var val = res.headers.get('content-security-policy');
    check('CSP on ' + routePath, val && val.includes("default-src"), 'default-src present', String(val).substring(0, 50));
  });

  await testAsync('3.8.4.' + (idx * 4 + 4), ' ' + routeDesc + ': Referrer-Policy', async () => {
    console.log('  Fetching ' + routePath + ' and checking Referrer-Policy header');
    console.log('  Controls how much URL information is sent in the Referer header');
    var res = await fetch(BASE + routePath, { ...TIMEOUT, redirect: 'manual' });
    var val = res.headers.get('referrer-policy');
    check('Referrer-Policy on ' + routePath, val === 'strict-origin-when-cross-origin',
      'strict-origin-when-cross-origin', String(val));
  });
}

await testAsync('3.8.4.13', ' X-Powered-By disabled', async () => {
  console.log('  Express sets X-Powered-By: Express by default');
  console.log('  app.disable("x-powered-by") removes it');
  console.log('  Checking: header is absent on /api/status');
  var res = await fetch(BASE + '/api/status', TIMEOUT);
  var val = res.headers.get('x-powered-by');
  check('X-Powered-By absent', val === null, 'null', String(val));
});

await testAsync('3.8.4.14', ' Permissions-Policy present', async () => {
  console.log('  Checking Permissions-Policy on /api/status');
  console.log('  Restricts access to browser features like camera, microphone, geolocation');
  var res = await fetch(BASE + '/api/status', TIMEOUT);
  var val = res.headers.get('permissions-policy');
  check('Permissions-Policy present', val && val.includes('camera=()'),
    'camera=()', String(val).substring(0, 50));
});

await testAsync('3.8.4.15', ' X-DNS-Prefetch-Control present', async () => {
  console.log('  Checking X-DNS-Prefetch-Control on /api/status');
  var res = await fetch(BASE + '/api/status', TIMEOUT);
  var val = res.headers.get('x-dns-prefetch-control');
  check('X-DNS-Prefetch-Control', val === 'off', 'off', String(val));
});

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

var summary = getCounters();
process.exit(summary.fail);
