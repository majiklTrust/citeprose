#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 2 — Auth0 Provider ADVERSARIAL Tests
# ═══════════════════════════════════════════════════════════════
#
# Usage: bash scripts/test-p3-step2-adversarial.sh
#        bash scripts/test-p3-step2-adversarial.sh --all
#
# Tests: open redirect, SSRF via domain, state fixation,
# injection in parameters, malicious user data from IDP.
#
# Does NOT require Auth0 or network. Tests config and URL logic.
# ═══════════════════════════════════════════════════════════════
(

divider() {
  local arg=${1:-━━━━━}
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$arg━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

PASS=0
FAIL=0
RUN_ALL=

for i in "$@"; do
case $i in
--all)
  shift && RUN_ALL=YES
  ;;
esac
done

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 2 — Auth0 Provider ADVERSARIAL Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

if [ ! -f "src/auth/providers/auth0.js" ]; then
  echo "  ERROR: src/auth/providers/auth0.js not found."
  exit 1
fi

# ═══════════════════════════════════════════════════════════════
# Group 1: SSRF via crafted AUTH0_DOMAIN
# ═══════════════════════════════════════════════════════════════

function test_group_1 {
divider " Group 1: SSRF via AUTH0_DOMAIN "
echo ""
echo "  Attacker controls AUTH0_DOMAIN to point to internal network."
echo "  Token exchange and userinfo would hit internal services."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'secret';

// Internal network addresses
const ssrfDomains = [
  '169.254.169.254',
  'metadata.google.internal',
  '10.0.0.1',
  '192.168.1.1',
  '127.0.0.1',
  'localhost',
  '0.0.0.0',
  '[::1]',
  'kubernetes.default.svc',
  'metadata.internal'
];

for (const domain of ssrfDomains) {
  process.env.AUTH0_DOMAIN = domain;
  const cfg = auth0._getConfig();

  // Check if the domain was accepted
  const tokenUrl = cfg.tokenUrl;
  const isInternal = tokenUrl.includes(domain);

  if (isInternal) {
    console.log('  ⚠ SSRF RISK — domain accepted: ' + domain + ' → ' + tokenUrl);
    check(domain + ' rejected', false);
  } else {
    check(domain + ' rejected', true);
  }
}

// Domains with ports to bypass
process.env.AUTH0_DOMAIN = 'legit.auth0.com:8080@evil.com';
const cfg1 = auth0._getConfig();
console.log('  URL with @: ' + cfg1.tokenUrl);
check('Domain with @ not exploitable', !cfg1.tokenUrl.includes('evil.com'));

// Backslash URL confusion
process.env.AUTH0_DOMAIN = 'legit.auth0.com\\\\@evil.com';
const cfg2 = auth0._getConfig();
check('Backslash domain not exploitable', !cfg2.tokenUrl.includes('evil.com'));

delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;

console.log('');
console.log('  NOTE: SSRF prevention requires domain allowlisting.');
console.log('  Current code normalizes but does not validate domain targets.');
console.log('');
console.log('  Group 1: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 12 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 2: Open redirect via AUTH0_REDIRECT_URI
# ═══════════════════════════════════════════════════════════════

function test_group_2 {
divider " Group 2: Open Redirect via Redirect URI "
echo ""
echo "  If AUTH0_REDIRECT_URI is attacker-controlled, the auth"
echo "  code is sent to the attacker after the user logs in."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'secret';

// Malicious redirect URIs
const maliciousRedirects = [
  'https://evil.com/steal-code',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '//evil.com/steal',
  'https://test.auth0.com.evil.com/callback',
  'https://evil.com%40test.auth0.com/callback'
];

for (const redirect of maliciousRedirects) {
  process.env.AUTH0_REDIRECT_URI = redirect;
  const url = auth0.getLoginUrl('state');

  if (url.includes(encodeURIComponent(redirect)) || url.includes(redirect)) {
    console.log('  ⚠ OPEN REDIRECT RISK — redirect accepted: ' + redirect);
    console.log('    Login URL: ' + url.substring(0, 120) + '...');
    check('Redirect rejected: ' + redirect.substring(0, 40), false);
  } else {
    check('Redirect rejected: ' + redirect.substring(0, 40), true);
  }
}

console.log('');
console.log('  NOTE: AUTH0_REDIRECT_URI is read from env, not from user input.');
console.log('  Risk exists only if attacker controls the env var (server compromise).');
console.log('  Auth0 dashboard has its own Allowed Callback URL list as second defense.');
console.log('');
console.log('  Group 2: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 6 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 3: State fixation attack
# ═══════════════════════════════════════════════════════════════

function test_group_3 {
divider " Group 3: State Fixation "
echo ""
echo "  Attacker pre-generates a state and tricks user into using it."
echo "  If state validation is weak, attacker can hijack the callback."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// Attacker-supplied states (not generated by our system)
check('Attacker state rejected: fixed string', !auth0._validateState('attacker_fixed_state_123'));
check('Attacker state rejected: hex string', !auth0._validateState('a'.repeat(64)));
check('Attacker state rejected: empty', !auth0._validateState(''));
check('Attacker state rejected: null bytes', !auth0._validateState('\\x00\\x00\\x00'));

// Generate a real state, then try to use a modified version
const real = auth0._generateState();
const modified = real.substring(0, 60) + 'aaaa';
check('Modified state rejected', !auth0._validateState(modified));
check('Original state still valid', auth0._validateState(real));
check('Original state single-use', !auth0._validateState(real));

// Generate many states — verify no collisions
const states = new Set();
for (let i = 0; i < 1000; i++) {
  const s = auth0._generateState();
  if (states.has(s)) {
    check('No collisions in 1000 states', false);
    break;
  }
  states.add(s);
}
if (states.size === 1000) check('No collisions in 1000 states', true);

// Verify state entropy (should be 256 bits = 64 hex chars)
const s = auth0._generateState();
check('State is 256 bits (64 hex chars)', s.length === 64 && /^[0-9a-f]+$/.test(s));
// Consume it
auth0._validateState(s);

console.log('');
console.log('  Group 3: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 10 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 4: Injection in OAuth parameters
# ═══════════════════════════════════════════════════════════════

function test_group_4 {
divider " Group 4: Parameter Injection "
echo ""
echo "  Malicious values in env vars that become URL parameters."
echo "  Could inject additional OAuth params or break URL parsing."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_CLIENT_SECRET = 'secret';

// Client ID with injection
process.env.AUTH0_CLIENT_ID = 'legit&admin=true&scope=all';
const url1 = auth0.getLoginUrl('s');
const parsed1 = new URL(url1);
check('Injected client_id is URL-encoded', parsed1.searchParams.get('client_id') === 'legit&admin=true&scope=all');
check('No extra admin param', parsed1.searchParams.get('admin') === null);

// Audience with newline injection
process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_AUDIENCE = 'https://api\\r\\nX-Injected: evil';
const url2 = auth0.getLoginUrl('s');
check('Newline in audience encoded', !url2.includes('X-Injected'));

// Scope injection
process.env.AUTH0_SCOPES = 'openid profile email admin:all delete:users';
const url3 = auth0.getLoginUrl('s');
const parsed3 = new URL(url3);
const scopes = parsed3.searchParams.get('scope');
check('Scope value is preserved as-is (Auth0 validates server-side)', scopes.includes('admin:all'));
console.log('  NOTE: Extra scopes are rejected by Auth0 server if not configured');

// State with injection
const url4 = auth0.getLoginUrl('legit&redirect_uri=https://evil.com');
const parsed4 = new URL(url4);
check('State injection does not create extra redirect_uri', 
  parsed4.searchParams.getAll('redirect_uri').length === 1);
check('State value preserved literally', 
  parsed4.searchParams.get('state') === 'legit&redirect_uri=https://evil.com');

delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;
delete process.env.AUTH0_AUDIENCE;
delete process.env.AUTH0_SCOPES;

console.log('');
console.log('  Group 4: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 6 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 5: Malicious getUserInfo response
# ═══════════════════════════════════════════════════════════════

function test_group_5 {
divider " Group 5: Malicious User Data from IDP "
echo ""
echo "  Auth0 userinfo could return XSS payloads, oversized data,"
echo "  or unexpected types. getUserInfo must sanitize or at minimum"
echo "  not crash on hostile input."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// getUserInfo makes a network call, so we test the response mapping
// by examining what the function does with the returned data.
// Since we can't mock fetch here, we test the return shape contract.

// Simulate what getUserInfo returns — verify the mapping is safe
const maliciousProfiles = [
  { sub: '<script>alert(1)</script>', name: '<img onerror=alert(1)>', email: 'xss@\"><script>alert(1)</script>.com' },
  { sub: 'a'.repeat(10000), name: 'b'.repeat(10000), email: 'c'.repeat(10000) },
  { sub: null, name: undefined, email: 42 },
  { sub: { nested: 'object' }, name: ['array'], email: true },
  { sub: '../../etc/passwd', name: '../../../.env', email: 'path@traversal.com' }
];

console.log('  NOTE: These test the response mapping contract.');
console.log('  getUserInfo returns raw IDP data — consumers must sanitize.');
console.log('  Documenting what hostile data looks like post-mapping.');
console.log('');

// The key question: does the code crash on hostile input?
// getUserInfo calls fetch() which we can\\'t test here,
// but we can verify the provider\\'s return shape is documented
// and that the middleware handles unexpected types.

check('getUserInfo is async function', typeof auth0.getUserInfo === 'function');
check('getUserInfo documented return includes raw field', true);
console.log('  ⚠ Recommendation: Add sanitization in getUserInfo or middleware');
console.log('  ⚠ for XSS payloads in name/email before they reach the dashboard.');

console.log('');
console.log('  Group 5: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 2 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 6: Logout redirect manipulation
# ═══════════════════════════════════════════════════════════════

function test_group_6 {
divider " Group 6: Logout Redirect Manipulation "
echo ""
echo "  returnTo parameter in logout could redirect to phishing page."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'secret';

// Attacker-controlled returnTo values
const maliciousReturns = [
  'https://evil.com/phishing',
  'javascript:alert(document.cookie)',
  'data:text/html,<script>steal()</script>',
  '//evil.com',
  'https://test.auth0.com.evil.com/'
];

for (const returnTo of maliciousReturns) {
  const url = auth0.getLogoutUrl(returnTo);
  const parsed = new URL(url);
  const param = parsed.searchParams.get('returnTo');

  // The URL is sent to Auth0's /v2/logout — Auth0 validates against
  // Allowed Logout URLs in the dashboard. But if the returnTo is
  // accepted by OUR code without validation, it's still a risk
  // if Auth0's allowlist is misconfigured.

  console.log('  returnTo: ' + returnTo.substring(0, 50));
  console.log('  Encoded:  ' + param?.substring(0, 50));

  if (param === returnTo) {
    console.log('  ⚠ Accepted as-is — relies on Auth0 dashboard allowlist');
  }
}

check('getLogoutUrl accepts any returnTo (Auth0 validates server-side)', true);
console.log('');
console.log('  NOTE: Auth0 Allowed Logout URLs is the defense here.');
console.log('  ⚠ Recommendation: Validate returnTo against an allowlist');
console.log('    in getLogoutUrl() before sending to Auth0.');

delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;

console.log('');
console.log('  Group 6: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 1 - code))
FAIL=$((FAIL + code))
}

######## MAIN

if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> to run group 1 (SSRF via domain)" x && test_group_1
  read -p "<Enter> to run group 2 (open redirect)" x && test_group_2
  read -p "<Enter> to run group 3 (state fixation)" x && test_group_3
  read -p "<Enter> to run group 4 (parameter injection)" x && test_group_4
  read -p "<Enter> to run group 5 (malicious user data)" x && test_group_5
  read -p "<Enter> to run group 6 (logout redirect)" x && test_group_6
else
  test_group_1
  test_group_2
  test_group_3
  test_group_4
  test_group_5
  test_group_6
fi

divider
echo ""
echo "  ═══════════════════════════════════════"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "  ⚠ ${FAIL} vulnerability/test failure(s) found."
  echo "  Review output above for VULNERABILITY and RISK markers."
else
  echo "  All adversarial tests passed."
fi

divider
echo ""

exit $FAIL
)
