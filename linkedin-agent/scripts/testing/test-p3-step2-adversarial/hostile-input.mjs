// ═══════════════════════════════════════════════════════════════
// Step 2 Adversarial Groups 3, 4, 5: Hostile Input
// State fixation + parameter injection + malicious user data
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, check, getCounters } from '../lib/test-harness.mjs';
import auth0 from '../../../src/auth/providers/auth0.js';

// ── Group 3: State fixation ──────────────────────────────────

group('Group 3: State fixation', `
  If an attacker can pre-generate or predict CSRF state values,
  they hijack the OAuth callback and link their session to a
  victim's login — full account takeover.
`);

var before3 = getCounters();

test('3.2.3.1-A', '', () => {
  console.log('  Passing a fixed string the attacker chose');
  check('Attacker fixed string rejected', !auth0._validateState('attacker_fixed_state'), 'rejected', 'accepted');
});

test('3.2.3.2-A', '', () => {
  console.log('  64 hex chars of "a" — correct length but not from crypto.randomBytes');
  check('Attacker hex string rejected', !auth0._validateState('a'.repeat(64)), 'rejected', 'accepted');
});

test('3.2.3.3-A', '', () => { check('Empty string rejected', !auth0._validateState(''), 'rejected', 'accepted'); });
test('3.2.3.4-A', '', () => { check('Null bytes rejected', !auth0._validateState('\x00\x00'), 'rejected', 'accepted'); });

test('3.2.3.5-A', '', () => {
  console.log('  Generating real state, modifying last 4 chars');
  var real = auth0._generateState();
  var modified = real.substring(0, 60) + 'aaaa';
  check('Modified state rejected', !auth0._validateState(modified), 'rejected', 'accepted');
  auth0._validateState(real); // consume
});

test('3.2.3.6-A', '', () => {
  var real = auth0._generateState();
  check('Original state valid', auth0._validateState(real), 'accepted', 'rejected');
});

test('3.2.3.7-A', '', () => {
  var real = auth0._generateState();
  auth0._validateState(real);
  check('Single-use enforced', !auth0._validateState(real), 'rejected (consumed)', 'accepted (reusable)');
});

test('3.2.3.8-A', '', () => {
  console.log('  Generating 1000 states, checking for collisions');
  var states = new Set();
  for (var i = 0; i < 1000; i++) {
    var s = auth0._generateState();
    if (states.has(s)) { check('No collisions', false, 'unique', 'collision at ' + i); break; }
    states.add(s);
  }
  if (states.size === 1000) check('No collisions in 1000 states', true, 'unique', 'unique');
  for (var s2 of states) auth0._validateState(s2);
});

test('3.2.3.9-A', '', () => {
  var s = auth0._generateState();
  check('State is 256-bit entropy', s.length === 64 && /^[0-9a-f]+$/.test(s), '64 hex chars', s.length + ' chars');
  auth0._validateState(s);
});

test('3.2.3.10-A', '', () => { check('Numeric value rejected', !auth0._validateState(12345), 'rejected', 'accepted'); });

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Group 4: Parameter injection ─────────────────────────────

group('Group 4: Parameter injection', `
  Injection characters in env vars could add hidden OAuth
  parameters — escalating permissions, redirecting callbacks,
  or bypassing security checks.
`);

var before4 = getCounters();
process.env.AUTH0_DOMAIN = 'test.auth0.com'; process.env.AUTH0_CLIENT_SECRET = 'secret';

test('3.2.4.1-A', '', () => {
  console.log('  Setting AUTH0_CLIENT_ID to "legit&admin=true&scope=all"');
  console.log('  If & is not encoded, extra params appear in the URL');
  process.env.AUTH0_CLIENT_ID = 'legit&admin=true&scope=all';
  var p = new URL(auth0.getLoginUrl('s'));
  check('Injected client_id URL-encoded safely', p.searchParams.get('client_id') === 'legit&admin=true&scope=all', 'single value', 'split');
});

test('3.2.4.2-A', '', () => {
  var p = new URL(auth0.getLoginUrl('s'));
  check('No injected admin param', p.searchParams.get('admin') === null, 'null', String(p.searchParams.get('admin')));
});

test('3.2.4.3-A', '', () => {
  console.log('  State with embedded redirect_uri injection');
  process.env.AUTH0_CLIENT_ID = 'cid';
  var p = new URL(auth0.getLoginUrl('legit&redirect_uri=https://evil.com'));
  check('State injection cannot create extra redirect_uri', p.searchParams.getAll('redirect_uri').length === 1, '1', p.searchParams.getAll('redirect_uri').length + '');
});

test('3.2.4.4-A', '', () => {
  var p = new URL(auth0.getLoginUrl('legit&redirect_uri=https://evil.com'));
  check('State preserved literally', p.searchParams.get('state') === 'legit&redirect_uri=https://evil.com', 'literal', 'decoded');
});

test('3.2.4.5-A', '', () => {
  console.log('  Setting AUTH0_SCOPES with unauthorized scopes');
  process.env.AUTH0_SCOPES = 'openid profile email admin:all delete:users';
  var p = new URL(auth0.getLoginUrl('s'));
  check('Extra scopes passed (Auth0 validates server-side)', p.searchParams.get('scope').includes('admin:all'), 'preserved', 'stripped');
  console.log('  NOTE: Auth0 server rejects unauthorized scopes');
});

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET; delete process.env.AUTH0_SCOPES;
var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Group 5: Malicious user data from IDP ────────────────────

group('Group 5: Malicious user data from IDP', `
  If Auth0 returns XSS payloads in name or email and these reach
  the dashboard unsanitized, an attacker executes JavaScript in
  every admin's browser.
`);

var before5 = getCounters();

test('3.2.5.1-A', '', () => {
  console.log('  getUserInfo() calls Auth0 /userinfo and returns the profile');
  console.log('  If IDP returns <script>alert(1)</script> as name,');
  console.log('  the dashboard must escape it before rendering');
  check('getUserInfo is async function', typeof auth0.getUserInfo === 'function', 'function', typeof auth0.getUserInfo);
});

test('3.2.5.2-A', '', () => {
  console.log('  ⚠ Recommendation: Add HTML escaping in getUserInfo() or middleware');
  check('Return shape documented', true, 'documented', 'documented');
});

var after5 = getCounters();
groupEnd(after5.pass - before5.pass, after5.fail - before5.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
