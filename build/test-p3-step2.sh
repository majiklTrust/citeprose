#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 2 — Auth0 OIDC Provider Test Suite
# ═══════════════════════════════════════════════════════════════
#
# Usage: bash scripts/test-p3-step2.sh
#        bash scripts/test-p3-step2.sh --all     (skip prompts)
#
# Does NOT require the server to be running.
# Does NOT require an Auth0 account.
# Does NOT make any network calls.
# Tests provider structure, config gating, URL generation,
# state management, and multi-provider coexistence.
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

# ═══════════════════════════════════════════════════════════════
# Group 1: Env var gating
# ═══════════════════════════════════════════════════════════════

function test_group_1 {
divider " Group 1: Env Var Gating "
echo ""
echo "  Provider file always exists. Activation depends on env vars."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// No env vars
delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;
check('Not configured without any vars', !auth0.isConfigured());

// Only domain
process.env.AUTH0_DOMAIN = 'test.auth0.com';
check('Not configured with only domain', !auth0.isConfigured());

// Domain + client ID
process.env.AUTH0_CLIENT_ID = 'cid';
check('Not configured without secret', !auth0.isConfigured());

// All three
process.env.AUTH0_CLIENT_SECRET = 'secret';
check('Configured with all three', auth0.isConfigured());

// Empty string domain
process.env.AUTH0_DOMAIN = '';
check('Not configured with empty domain', !auth0.isConfigured());

// Whitespace domain
process.env.AUTH0_DOMAIN = '   ';
check('Not configured with whitespace domain', !auth0.isConfigured());

// Cleanup
delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;

console.log('');
console.log('  Group 1: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 6 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 2: Domain normalization
# ═══════════════════════════════════════════════════════════════

function test_group_2 {
divider " Group 2: Domain Normalization "
echo ""
echo "  Domain should be cleaned regardless of input format."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'secret';

process.env.AUTH0_DOMAIN = 'test.auth0.com';
check('Clean domain: ' + auth0._getConfig().domain, auth0._getConfig().domain === 'test.auth0.com');

process.env.AUTH0_DOMAIN = 'https://test.auth0.com';
check('Strips https://: ' + auth0._getConfig().domain, auth0._getConfig().domain === 'test.auth0.com');

process.env.AUTH0_DOMAIN = 'http://test.auth0.com/';
check('Strips http:// and /: ' + auth0._getConfig().domain, auth0._getConfig().domain === 'test.auth0.com');

process.env.AUTH0_DOMAIN = 'test.auth0.com/';
check('Strips trailing /: ' + auth0._getConfig().domain, auth0._getConfig().domain === 'test.auth0.com');

// Verify derived URLs use clean domain
process.env.AUTH0_DOMAIN = 'https://test.auth0.com/';
const cfg = auth0._getConfig();
check('Issuer URL correct', cfg.issuer === 'https://test.auth0.com/');
check('JWKS URI correct', cfg.jwksUri === 'https://test.auth0.com/.well-known/jwks.json');
check('Token URL correct', cfg.tokenUrl === 'https://test.auth0.com/oauth/token');
check('UserInfo URL correct', cfg.userInfoUrl === 'https://test.auth0.com/userinfo');

delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;

console.log('');
console.log('  Group 2: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 8 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 3: State management
# ═══════════════════════════════════════════════════════════════

function test_group_3 {
divider " Group 3: OAuth State Management "
echo ""
echo "  CSRF state: cryptographic, single-use, time-bounded."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

const s1 = auth0._generateState();
check('State is string', typeof s1 === 'string');
check('State is 64 hex chars', /^[0-9a-f]{64}$/.test(s1));

const s2 = auth0._generateState();
check('Two states are different', s1 !== s2);

check('Valid state accepted', auth0._validateState(s2));
check('Same state rejected (single-use)', !auth0._validateState(s2));

check('Null rejected', !auth0._validateState(null));
check('Undefined rejected', !auth0._validateState(undefined));
check('Empty string rejected', !auth0._validateState(''));
check('Random string rejected', !auth0._validateState('not-a-real-state'));
check('Numeric rejected', !auth0._validateState(12345));

// Generate many, validate all — order independent
const states = [];
for (let i = 0; i < 10; i++) states.push(auth0._generateState());
const shuffled = states.sort(() => Math.random() - 0.5);
let allValid = true;
for (const s of shuffled) { if (!auth0._validateState(s)) allValid = false; }
check('10 states validated in shuffled order', allValid);

// Double-validate all should fail
let allInvalid = true;
for (const s of shuffled) { if (auth0._validateState(s)) allInvalid = false; }
check('All 10 reject second validation', allInvalid);

console.log('');
console.log('  Group 3: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 12 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 4: Login URL construction
# ═══════════════════════════════════════════════════════════════

function test_group_4 {
divider " Group 4: Login URL Construction "
echo ""
echo "  Login URL must contain all required OIDC parameters."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

process.env.AUTH0_DOMAIN = 'my-tenant.auth0.com';
process.env.AUTH0_CLIENT_ID = 'client_abc123';
process.env.AUTH0_CLIENT_SECRET = 'secret';
process.env.AUTH0_AUDIENCE = 'https://my-api';
process.env.AUTH0_REDIRECT_URI = 'https://app.example.com/auth/callback';
process.env.AUTH0_SCOPES = 'openid profile email offline_access';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

const url = auth0.getLoginUrl('state_xyz');
const parsed = new URL(url);

check('Uses HTTPS', parsed.protocol === 'https:');
check('Correct domain', parsed.hostname === 'my-tenant.auth0.com');
check('Correct path /authorize', parsed.pathname === '/authorize');
check('response_type=code', parsed.searchParams.get('response_type') === 'code');
check('client_id matches', parsed.searchParams.get('client_id') === 'client_abc123');
check('redirect_uri matches', parsed.searchParams.get('redirect_uri') === 'https://app.example.com/auth/callback');
check('scope matches', parsed.searchParams.get('scope') === 'openid profile email offline_access');
check('audience matches', parsed.searchParams.get('audience') === 'https://my-api');
check('state matches', parsed.searchParams.get('state') === 'state_xyz');

// Auto-generate state when none provided
const url2 = auth0.getLoginUrl();
const parsed2 = new URL(url2);
const autoState = parsed2.searchParams.get('state');
check('Auto-generates state when none given', autoState && /^[0-9a-f]{64}$/.test(autoState));

// Default redirect URI
delete process.env.AUTH0_REDIRECT_URI;
process.env.DASHBOARD_PORT = '4000';
const url3 = auth0.getLoginUrl('s');
check('Default redirect uses DASHBOARD_PORT', url3.includes('localhost%3A4000') || url3.includes('localhost:4000'));

// Cleanup
delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;
delete process.env.AUTH0_AUDIENCE;
delete process.env.AUTH0_SCOPES;
delete process.env.DASHBOARD_PORT;

console.log('');
console.log('  Group 4: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 11 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 5: Logout URL construction
# ═══════════════════════════════════════════════════════════════

function test_group_5 {
divider " Group 5: Logout URL Construction "
echo ""
echo "  Logout URL must point to Auth0 v2/logout with correct params."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

process.env.AUTH0_DOMAIN = 'my-tenant.auth0.com';
process.env.AUTH0_CLIENT_ID = 'client_abc123';
process.env.AUTH0_CLIENT_SECRET = 'secret';
process.env.AUTH0_LOGOUT_URI = 'https://app.example.com/';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

const url = auth0.getLogoutUrl('https://app.example.com/goodbye');
const parsed = new URL(url);

check('Uses HTTPS', parsed.protocol === 'https:');
check('Correct domain', parsed.hostname === 'my-tenant.auth0.com');
check('Correct path /v2/logout', parsed.pathname === '/v2/logout');
check('client_id present', parsed.searchParams.get('client_id') === 'client_abc123');
check('returnTo uses provided URL', parsed.searchParams.get('returnTo') === 'https://app.example.com/goodbye');

// Default returnTo
const url2 = auth0.getLogoutUrl();
const parsed2 = new URL(url2);
check('Default returnTo uses AUTH0_LOGOUT_URI', parsed2.searchParams.get('returnTo') === 'https://app.example.com/');

// Cleanup
delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;
delete process.env.AUTH0_LOGOUT_URI;

console.log('');
console.log('  Group 5: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 6 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 6: Init validation
# ═══════════════════════════════════════════════════════════════

function test_group_6 {
divider " Group 6: Init Validation "
echo ""
echo "  Init should reject invalid configurations."
echo ""

node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// Missing domain
process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'secret';
delete process.env.AUTH0_DOMAIN;
try { await auth0.init(); check('Missing domain — should throw', false); }
catch (e) { check('Missing domain throws', e.message.includes('AUTH0_DOMAIN')); }

// Invalid domain — no dots
process.env.AUTH0_DOMAIN = 'nodots';
try { await auth0.init(); check('No-dot domain — should throw', false); }
catch (e) { check('No-dot domain throws', e.message.includes('appears invalid')); }

// Invalid domain — spaces
process.env.AUTH0_DOMAIN = 'has spaces.auth0.com';
try { await auth0.init(); check('Spaces in domain — should throw', false); }
catch (e) { check('Spaces in domain throws', e.message.includes('appears invalid')); }

// Missing client secret
process.env.AUTH0_DOMAIN = 'test.auth0.com';
delete process.env.AUTH0_CLIENT_SECRET;
try { await auth0.init(); check('Missing secret — should throw', false); }
catch (e) { check('Missing secret throws', e.message.includes('AUTH0_CLIENT_SECRET')); }

// Valid config — init succeeds (discovery fetch is non-fatal)
process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'secret';
try {
  await auth0.init();
  check('Valid config init succeeds', auth0._isInitialized());
} catch (e) {
  check('Valid config init succeeds', false);
}

// Cleanup
delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;

console.log('');
console.log('  Group 6: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 5 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 7: Registry multi-provider coexistence
# ═══════════════════════════════════════════════════════════════

function test_group_7 {
divider " Group 7: Multi-Provider Coexistence "
echo ""
echo "  Auth0 and mock should coexist. Priority determines default."
echo ""

node --input-type=module -e "
import { _resetForTesting, initRegistry, getProviders, getProvider, getDefaultProvider } from './src/auth/index.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// Both active
_resetForTesting();
process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.AUTH0_CLIENT_ID = 'cid';
process.env.AUTH0_CLIENT_SECRET = 'secret';
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});

check('2 providers loaded', getProviders().length === 2);
check('Auth0 is default (priority 10)', getDefaultProvider()?.name === 'auth0');
check('Mock accessible by name', getProvider('mock') !== null);
check('Auth0 accessible by name', getProvider('auth0') !== null);
check('Priority order correct', getProviders()[0].priority < getProviders()[1].priority);

// Only auth0
_resetForTesting();
delete process.env.MOCK_AUTH_ENABLED;
await initRegistry(() => {});
check('Only auth0 when mock disabled', getProviders().length === 1 && getDefaultProvider()?.name === 'auth0');

// Only mock
_resetForTesting();
delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
check('Only mock when auth0 unconfigured', getProviders().length === 1 && getDefaultProvider()?.name === 'mock');

// Neither
_resetForTesting();
delete process.env.MOCK_AUTH_ENABLED;
await initRegistry(() => {});
check('Neither loads without env vars', getProviders().length === 0);

// Cleanup
delete process.env.AUTH0_DOMAIN;
delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;
delete process.env.MOCK_AUTH_ENABLED;

console.log('');
console.log('  Group 7: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 8 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 8: Shutdown and cleanup
# ═══════════════════════════════════════════════════════════════

function test_group_8 {
divider " Group 8: Shutdown and Cleanup "
echo ""
echo "  Shutdown should clear state, caches, and initialization flag."
echo ""

AUTH0_DOMAIN=test.auth0.com AUTH0_CLIENT_ID=cid AUTH0_CLIENT_SECRET=secret node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

await auth0.init();
check('Initialized before shutdown', auth0._isInitialized());

// Generate states
auth0._generateState();
auth0._generateState();
check('States exist before shutdown', auth0._getStateCount() >= 2);

await auth0.shutdown();
check('Not initialized after shutdown', !auth0._isInitialized());
check('States cleared after shutdown', auth0._getStateCount() === 0);
check('Discovery cache cleared', auth0._getDiscoveryCache() === null);

console.log('');
console.log('  Group 8: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 5 - code))
FAIL=$((FAIL + code))
}

######## MAIN

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 2 — Auth0 OIDC Provider Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

if [ ! -f "src/auth/providers/auth0.js" ]; then
  echo "  ERROR: src/auth/providers/auth0.js not found."
  echo "  Apply Phase 3 Step 2 code drop first."
  exit 1
fi
# Verify node
if ! command -v node; then
  nodever
  exit 1
fi

if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> to run group 1 (env var gating)" x && test_group_1
  read -p "<Enter> to run group 2 (domain normalization)" x && test_group_2
  read -p "<Enter> to run group 3 (state management)" x && test_group_3
  read -p "<Enter> to run group 4 (login URL)" x && test_group_4
  read -p "<Enter> to run group 5 (logout URL)" x && test_group_5
  read -p "<Enter> to run group 6 (init validation)" x && test_group_6
  read -p "<Enter> to run group 7 (multi-provider)" x && test_group_7
  read -p "<Enter> to run group 8 (shutdown)" x && test_group_8
else
  test_group_1
  test_group_2
  test_group_3
  test_group_4
  test_group_5
  test_group_6
  test_group_7
  test_group_8
fi

divider
echo ""
echo "  ═══════════════════════════════════════"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "  ⚠ ${FAIL} test(s) failed. Review output above."
else
  echo "  All tests passed."
  echo ""
  echo "  These tests verify the provider structure without network calls."
  echo "  To test the full Auth0 login flow, configure Auth0 env vars"
  echo "  and run the server — integration testing comes in Step 5."
fi

divider
echo ""

exit $FAIL
)
