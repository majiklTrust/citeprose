#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 1 — Auth Provider Registry Test Suite
# ═══════════════════════════════════════════════════════════════
#
# Usage: bash scripts/test-p3-step1.sh
#        bash scripts/test-p3-step1.sh --all     (skip prompts)
#
# Does NOT require the server to be running.
# Does NOT make any API calls.
# Runs Node.js directly against the registry module.
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
# Group 1: Interface contract
# ═══════════════════════════════════════════════════════════════

function test_group_1 {
divider " Group 1: Interface Contract "
echo ""
echo "  Verifying the provider interface is correctly defined."
echo ""

node --input-type=module -e "
import { PROVIDER_INTERFACE } from './src/auth/index.js';

const expectedFields = ['name','type','priority','issuer','jwksUri','audience','clientId'];
const expectedMethods = ['isConfigured','init','getRoutes','getLoginUrl','exchangeCode','getUserInfo','getLogoutUrl'];

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

check('7 required fields defined', PROVIDER_INTERFACE.fields.length === 7);
check('7 required methods defined', PROVIDER_INTERFACE.methods.length === 7);
for (const f of expectedFields) check('Field: ' + f, PROVIDER_INTERFACE.fields.includes(f));
for (const m of expectedMethods) check('Method: ' + m, PROVIDER_INTERFACE.methods.includes(m));

console.log('');
console.log('  Group 1: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 16 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 2: Dev mode — no providers
# ═══════════════════════════════════════════════════════════════

function test_group_2 {
divider " Group 2: Dev Mode — No Providers "
echo ""
echo "  App should start without auth when no providers are configured."
echo ""

node --input-type=module -e "
import { initRegistry, getProviders, getDefaultProvider, getJwksMap, getIssuers, isAuthEnabled, isAuthRequired, _resetForTesting } from './src/auth/index.js';

_resetForTesting();
delete process.env.MOCK_AUTH_ENABLED;
delete process.env.NODE_ENV;

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

const result = await initRegistry(() => {});
check('authEnabled is false', result.authEnabled === false);
check('providers map empty', result.providers.size === 0);
check('isAuthEnabled() returns false', isAuthEnabled() === false);
check('isAuthRequired() returns false', isAuthRequired() === false);
check('getProviders() returns empty array', getProviders().length === 0);
check('getDefaultProvider() returns null', getDefaultProvider() === null);
check('getJwksMap() returns empty map', getJwksMap().size === 0);
check('getIssuers() returns empty array', getIssuers().length === 0);

console.log('');
console.log('  Group 2: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 8 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 3: Mock provider activation
# ═══════════════════════════════════════════════════════════════

function test_group_3 {
divider " Group 3: Mock Provider Activation "
echo ""
echo "  Mock provider should activate when MOCK_AUTH_ENABLED=true."
echo ""

MOCK_AUTH_ENABLED=true node --input-type=module -e "
import { initRegistry, getProviders, getProvider, getDefaultProvider, getJwksMap, getIssuers, isAuthEnabled, _resetForTesting } from './src/auth/index.js';

_resetForTesting();

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

const result = await initRegistry(() => {});
check('authEnabled is true', result.authEnabled === true);
check('1 provider loaded', result.providers.size === 1);
check('isAuthEnabled() returns true', isAuthEnabled() === true);

const mock = getProvider('mock');
check('getProvider(mock) returns provider', mock !== null);
check('Provider name is mock', mock?.name === 'mock');
check('Provider type is oidc', mock?.type === 'oidc');
check('Provider issuer set', mock?.issuer === 'https://mock-auth.test/');
check('Provider jwksUri set', mock?.jwksUri === 'https://mock-auth.test/.well-known/jwks.json');
check('Provider audience set', mock?.audience === 'https://linkedin-agent-api');
check('Provider clientId set', mock?.clientId === 'mock_client_001');
check('Provider priority is 999', mock?.priority === 999);

check('getDefaultProvider() returns mock', getDefaultProvider()?.name === 'mock');
check('getIssuers() includes mock', getIssuers().includes('https://mock-auth.test/'));
check('getJwksMap() has mock issuer', getJwksMap().has('https://mock-auth.test/'));
check('getProvider(nonexistent) returns null', getProvider('nonexistent') === null);

console.log('');
console.log('  Group 3: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 15 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 4: Provider method validation
# ═══════════════════════════════════════════════════════════════

function test_group_4 {
divider " Group 4: Provider Method Validation "
echo ""
echo "  All provider interface methods should work correctly."
echo ""

MOCK_AUTH_ENABLED=true node --input-type=module -e "
import { initRegistry, getProvider, _resetForTesting } from './src/auth/index.js';

_resetForTesting();
await initRegistry(() => {});
const mock = getProvider('mock');

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

const tokens = await mock.exchangeCode('test_code_123');
check('exchangeCode returns accessToken', typeof tokens.accessToken === 'string' && tokens.accessToken.startsWith('mock_access_'));
check('exchangeCode returns idToken', typeof tokens.idToken === 'string');
check('exchangeCode returns expiresIn', tokens.expiresIn === 86400);
check('exchangeCode returns tokenType', tokens.tokenType === 'Bearer');

const user = await mock.getUserInfo(tokens.accessToken);
check('getUserInfo returns sub', user.sub === 'mock_user_001');
check('getUserInfo returns name', user.name === 'Test User');
check('getUserInfo returns email', user.email === 'test@example.com');
check('getUserInfo returns emailVerified', user.emailVerified === true);
check('getUserInfo returns provider', user.provider === 'mock');

const loginUrl = mock.getLoginUrl('state_abc');
check('getLoginUrl includes path', loginUrl.includes('/auth/mock/login'));
check('getLoginUrl includes state', loginUrl.includes('state_abc'));

const logoutUrl = mock.getLogoutUrl('https://example.com');
check('getLogoutUrl includes path', logoutUrl.includes('/auth/mock/logout'));
check('getLogoutUrl includes returnTo', logoutUrl.includes('example.com'));

console.log('');
console.log('  Group 4: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 13 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 5: Production mode enforcement
# ═══════════════════════════════════════════════════════════════

function test_group_5 {
divider " Group 5: Production Mode Enforcement "
echo ""
echo "  Production requires auth. No providers = fatal error."
echo ""

node --input-type=module -e "
import { initRegistry, isAuthRequired, _resetForTesting } from './src/auth/index.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// Test: production + no providers = fatal
_resetForTesting();
process.env.NODE_ENV = 'production';
delete process.env.MOCK_AUTH_ENABLED;
let threw = false;
let errMsg = '';
try { await initRegistry(() => {}); }
catch (e) { threw = true; errMsg = e.message; }
check('Throws when no providers in production', threw);
check('Error mentions auth providers', errMsg.includes('No auth providers configured'));
check('Error mentions env vars to set', errMsg.includes('AUTH0_DOMAIN') || errMsg.includes('WORKOS_API_KEY'));
check('isAuthRequired() true in production', isAuthRequired());

// Test: mock blocks itself in production
_resetForTesting();
process.env.NODE_ENV = 'production';
process.env.MOCK_AUTH_ENABLED = 'true';
let threw2 = false;
try { await initRegistry(() => {}); }
catch { threw2 = true; }
check('Mock provider refuses to load in production', threw2);

delete process.env.NODE_ENV;
delete process.env.MOCK_AUTH_ENABLED;

console.log('');
console.log('  Group 5: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 5 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 6: Shutdown and reset
# ═══════════════════════════════════════════════════════════════

function test_group_6 {
divider " Group 6: Shutdown and Reset "
echo ""
echo "  Registry should clean up on shutdown and be re-initializable."
echo ""

MOCK_AUTH_ENABLED=true node --input-type=module -e "
import { initRegistry, getProviders, isAuthEnabled, shutdownRegistry, _resetForTesting } from './src/auth/index.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// Load
_resetForTesting();
await initRegistry(() => {});
check('Provider loaded before shutdown', getProviders().length === 1);

// Shutdown
await shutdownRegistry(() => {});
check('Providers empty after shutdown', getProviders().length === 0);
check('authEnabled false after shutdown', isAuthEnabled() === false);

// Re-init
const r = await initRegistry(() => {});
check('Re-init succeeds after shutdown', r.authEnabled === true);
check('Provider reloaded after re-init', getProviders().length === 1);

// Double init returns cached
const r2 = await initRegistry(() => {});
check('Double init returns same result', r.providers === r2.providers);

console.log('');
console.log('  Group 6: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 6 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 7: Env var gating
# ═══════════════════════════════════════════════════════════════

function test_group_7 {
divider " Group 7: Env Var Gating "
echo ""
echo "  Provider file exists but only activates with correct env vars."
echo ""

node --input-type=module -e "
import { initRegistry, isAuthEnabled, _resetForTesting } from './src/auth/index.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// Without env var — file exists but provider inactive
_resetForTesting();
delete process.env.MOCK_AUTH_ENABLED;
const r1 = await initRegistry(() => {});
check('mock.js exists but inactive without MOCK_AUTH_ENABLED', !isAuthEnabled());
check('Result shows inactive status', r1.results[0]?.status === 'inactive');

// With env var = false — still inactive
_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'false';
const r2 = await initRegistry(() => {});
check('Inactive with MOCK_AUTH_ENABLED=false', !isAuthEnabled());

// With env var = true — active
_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
const r3 = await initRegistry(() => {});
check('Active with MOCK_AUTH_ENABLED=true', isAuthEnabled());

delete process.env.MOCK_AUTH_ENABLED;

console.log('');
console.log('  Group 7: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 4 - code))
FAIL=$((FAIL + code))
}

######## MAIN

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 1 — Auth Provider Registry Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Verify auth directory exists
if [ ! -f "src/auth/index.js" ]; then
  echo "  ERROR: src/auth/index.js not found."
  echo "  Apply Phase 3 Step 1 code drop first."
  exit 1
fi
# Verify node
if ! command -v node; then
  nodever
  exit 1
fi

if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> to run group 1 (interface contract)" x && test_group_1
  read -p "<Enter> to run group 2 (dev mode no providers)" x && test_group_2
  read -p "<Enter> to run group 3 (mock provider activation)" x && test_group_3
  read -p "<Enter> to run group 4 (provider methods)" x && test_group_4
  read -p "<Enter> to run group 5 (production enforcement)" x && test_group_5
  read -p "<Enter> to run group 6 (shutdown and reset)" x && test_group_6
  read -p "<Enter> to run group 7 (env var gating)" x && test_group_7
else
  test_group_1
  test_group_2
  test_group_3
  test_group_4
  test_group_5
  test_group_6
  test_group_7
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
fi

divider
echo ""

exit $FAIL
)
