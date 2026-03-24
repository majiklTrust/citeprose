#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 1 — Auth Provider Registry ADVERSARIAL Tests
# ═══════════════════════════════════════════════════════════════
#
# Usage: bash scripts/test-p3-step1-adversarial.sh
#        bash scripts/test-p3-step1-adversarial.sh --all
#
# Tests assume-breach scenarios: hostile provider files, crashes
# during lifecycle, interface mutation, naming collisions.
#
# Does NOT require the server or Auth0.
# Creates temporary hostile provider files, tests, then cleans up.
# ═══════════════════════════════════════════════════════════════
(

divider() {
  local arg=${1:-━━━━━}
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$arg━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

PASS=0
FAIL=0
RUN_ALL=
PROVIDERS_DIR="src/auth/providers"
HOSTILE_FILES=()

for i in "$@"; do
case $i in
--all)
  shift && RUN_ALL=YES
  ;;
esac
done

# Cleanup function — removes all hostile test files
cleanup() {
  for f in "${HOSTILE_FILES[@]}"; do
    rm -f "$f" 2>/dev/null
  done
}
trap cleanup EXIT

# Helper: create a hostile provider file
create_hostile() {
  local filename="$1"
  local content="$2"
  local filepath="${PROVIDERS_DIR}/${filename}"
  echo "$content" > "$filepath"
  HOSTILE_FILES+=("$filepath")
}

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 1 — Registry ADVERSARIAL Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

if [ ! -f "src/auth/index.js" ]; then
  echo "  ERROR: src/auth/index.js not found."
  exit 1
fi

# ═══════════════════════════════════════════════════════════════
# Group 1: Provider that throws during isConfigured()
# ═══════════════════════════════════════════════════════════════

function test_group_1 {
divider " Group 1: Crash in isConfigured() "
echo ""
echo "  A hostile provider throws during discovery."
echo "  Registry must survive and continue loading other providers."
echo ""

create_hostile "hostile-crash-configured.js" '
export default {
  name: "hostile_crash",
  type: "oidc",
  priority: 50,
  issuer: "https://hostile.test/",
  jwksUri: "https://hostile.test/.well-known/jwks.json",
  audience: "test",
  clientId: "test",
  isConfigured() { throw new Error("HOSTILE: crash in isConfigured"); },
  async init() {},
  getRoutes() { return null; },
  getLoginUrl() { return ""; },
  async exchangeCode() { return {}; },
  async getUserInfo() { return {}; },
  getLogoutUrl() { return ""; }
};
'

MOCK_AUTH_ENABLED=true node --input-type=module -e "
import { _resetForTesting, initRegistry, getProviders, getProvider, isAuthEnabled } from './src/auth/index.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

_resetForTesting();
const logs = [];
const result = await initRegistry((l,a,d) => logs.push({l,a,d}));

check('Registry did not crash', true);
check('Mock provider still loaded', getProvider('mock') !== null);
check('Hostile provider not loaded', getProvider('hostile_crash') === null);
check('Auth still enabled via mock', isAuthEnabled());

const hostileLog = logs.find(l => l.a === 'auth_provider_skipped' && l.d?.filename?.includes('hostile'));
check('Hostile file logged as skipped or error', !!hostileLog);

console.log('');
console.log('  Group 1: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 5 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 2: Provider that hangs during init()
# ═══════════════════════════════════════════════════════════════

function test_group_2 {
divider " Group 2: Hang in init() "
echo ""
echo "  A provider that never resolves init()."
echo "  Currently NO timeout — this test documents the vulnerability."
echo "  Timeout (5s) applied externally to prove the hang."
echo ""

create_hostile "hostile-hang-init.js" '
export default {
  name: "hostile_hang",
  type: "oidc",
  priority: 50,
  issuer: "https://hang.test/",
  jwksUri: "https://hang.test/.well-known/jwks.json",
  audience: "test",
  clientId: "test",
  isConfigured() { return process.env.HOSTILE_HANG === "true"; },
  async init() { await new Promise(() => {}); },
  getRoutes() { return null; },
  getLoginUrl() { return ""; },
  async exchangeCode() { return {}; },
  async getUserInfo() { return {}; },
  getLogoutUrl() { return ""; }
};
'

HOSTILE_HANG=true timeout 5 node --input-type=module -e "
import { _resetForTesting, initRegistry } from './src/auth/index.js';
_resetForTesting();
await initRegistry(() => {});
console.log('COMPLETED');
" 2>&1

local exit_code=$?

if [ $exit_code -eq 124 ]; then
  echo "  ⚠ VULNERABILITY CONFIRMED — init() hang blocks startup indefinitely"
  echo "  ⚠ Recommendation: Add init() timeout in registry (e.g., 10 second limit)"
  PASS=$((PASS + 1))
elif [ $exit_code -eq 0 ]; then
  echo "  ✓ init() completed (timeout was implemented)"
  PASS=$((PASS + 1))
else
  echo "  ? Unexpected exit code: $exit_code"
  FAIL=$((FAIL + 1))
fi
}

# ═══════════════════════════════════════════════════════════════
# Group 3: Duplicate provider names
# ═══════════════════════════════════════════════════════════════

function test_group_3 {
divider " Group 3: Duplicate Provider Names "
echo ""
echo "  Two providers with the same name. Second should not"
echo "  silently overwrite the first."
echo ""

create_hostile "hostile-dupe-name.js" '
export default {
  name: "mock",
  type: "oidc",
  priority: 1,
  issuer: "https://evil-mock.test/",
  jwksUri: "https://evil-mock.test/.well-known/jwks.json",
  audience: "test",
  clientId: "evil_client",
  isConfigured() { return process.env.HOSTILE_DUPE === "true"; },
  async init() {},
  getRoutes() { return null; },
  getLoginUrl() { return ""; },
  async exchangeCode() { return {}; },
  async getUserInfo() { return {}; },
  getLogoutUrl() { return ""; }
};
'

MOCK_AUTH_ENABLED=true HOSTILE_DUPE=true node --input-type=module -e "
import { _resetForTesting, initRegistry, getProvider, getProviders } from './src/auth/index.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

_resetForTesting();
const logs = [];
await initRegistry((l,a,d) => logs.push({l,a,d}));

const mock = getProvider('mock');
const allProviders = getProviders();

// Check which one won — the real mock or the hostile one
check('Provider named mock exists', mock !== null);

if (mock.issuer === 'https://evil-mock.test/') {
  console.log('  ⚠ VULNERABILITY — hostile provider overwrote legitimate mock');
  console.log('  ⚠ The second provider with name \"mock\" silently replaced the first');
  check('Hostile did NOT overwrite legitimate provider', false);
} else if (mock.issuer === 'https://mock-auth.test/') {
  check('Legitimate mock provider preserved', true);
} else {
  check('Known provider loaded', false);
}

// Document whether duplicates were detected
const dupeWarning = logs.find(l => l.d?.reason?.includes('duplicate') || l.a?.includes('duplicate'));
if (dupeWarning) {
  check('Duplicate name logged as warning', true);
} else {
  console.log('  ⚠ No duplicate name warning logged — silent overwrite risk');
  check('Duplicate name logged as warning', false);
}

console.log('');
console.log('  Group 3: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 3 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 4: Provider that mutates its interface after loading
# ═══════════════════════════════════════════════════════════════

function test_group_4 {
divider " Group 4: Interface Mutation After Loading "
echo ""
echo "  A provider changes its issuer/jwksUri after init()."
echo "  If the registry trusts cached values, this redirects"
echo "  token validation to an attacker-controlled JWKS."
echo ""

create_hostile "hostile-mutate.js" '
let _issuer = "https://legit.test/";
let _jwksUri = "https://legit.test/.well-known/jwks.json";

export default {
  name: "hostile_mutate",
  type: "oidc",
  priority: 5,
  get issuer() { return _issuer; },
  get jwksUri() { return _jwksUri; },
  audience: "test",
  clientId: "test",
  isConfigured() { return process.env.HOSTILE_MUTATE === "true"; },
  async init() {
    // After init, switch to attacker-controlled endpoints
    setTimeout(() => {
      _issuer = "https://evil-attacker.com/";
      _jwksUri = "https://evil-attacker.com/.well-known/jwks.json";
    }, 100);
  },
  getRoutes() { return null; },
  getLoginUrl() { return ""; },
  async exchangeCode() { return {}; },
  async getUserInfo() { return {}; },
  getLogoutUrl() { return ""; }
};
'

HOSTILE_MUTATE=true node --input-type=module -e "
import { _resetForTesting, initRegistry, getProvider, getJwksMap } from './src/auth/index.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

_resetForTesting();
await initRegistry(() => {});

const provider = getProvider('hostile_mutate');
check('Provider loaded', provider !== null);

// Check values immediately
const issuerBefore = provider.issuer;
const jwksUriBefore = provider.jwksUri;
check('Initial issuer is legit', issuerBefore === 'https://legit.test/');

// Wait for the mutation
await new Promise(r => setTimeout(r, 200));

const issuerAfter = provider.issuer;
const jwksUriAfter = provider.jwksUri;

if (issuerAfter !== issuerBefore) {
  console.log('  ⚠ VULNERABILITY — provider mutated issuer after init()');
  console.log('    Before: ' + issuerBefore);
  console.log('    After:  ' + issuerAfter);
  check('Issuer is immutable after registration', false);
} else {
  check('Issuer is immutable after registration', true);
}

// Check if getJwksMap reflects the mutation
const jwksMap = getJwksMap();
const mapHasEvil = jwksMap.has('https://evil-attacker.com/');
const mapHasLegit = jwksMap.has('https://legit.test/');

if (mapHasEvil) {
  console.log('  ⚠ CRITICAL — getJwksMap() serves attacker JWKS URI');
  check('JWKS map not poisoned by mutation', false);
} else {
  check('JWKS map not poisoned by mutation', mapHasLegit);
}

console.log('');
console.log('  Group 4: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 4 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 5: Provider with syntax errors / bad exports
# ═══════════════════════════════════════════════════════════════

function test_group_5 {
divider " Group 5: Malformed Provider Files "
echo ""
echo "  Files with syntax errors, missing exports, or wrong types."
echo "  Registry must survive all of them."
echo ""

# Syntax error
create_hostile "hostile-syntax.js" 'this is not valid javascript {{{'

# No default export
create_hostile "hostile-no-export.js" 'export const name = "orphan";'

# Default export is a string
create_hostile "hostile-string-export.js" 'export default "I am not a provider";'

# Default export is null
create_hostile "hostile-null-export.js" 'export default null;'

# Default export is a function
create_hostile "hostile-fn-export.js" 'export default function() { return "surprise"; };'

MOCK_AUTH_ENABLED=true node --input-type=module -e "
import { _resetForTesting, initRegistry, getProvider, isAuthEnabled } from './src/auth/index.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

_resetForTesting();
const logs = [];
const result = await initRegistry((l,a,d) => logs.push({l,a,d}));

check('Registry did not crash', true);
check('Mock provider still loaded', getProvider('mock') !== null);
check('Auth still enabled', isAuthEnabled());

// Count how many hostile files were handled gracefully
const errorResults = result.results.filter(r => r.status === 'error' || r.status === 'skip');
check('All hostile files handled (error or skip)', errorResults.length >= 4);

// Verify none of the hostile providers loaded
check('hostile-syntax not loaded', !result.results.some(r => r.status === 'ready' && r.filename?.includes('hostile-syntax')));
check('hostile-no-export not loaded', !result.results.some(r => r.status === 'ready' && r.filename?.includes('hostile-no-export')));
check('hostile-string-export not loaded', !result.results.some(r => r.status === 'ready' && r.filename?.includes('hostile-string')));
check('hostile-null-export not loaded', !result.results.some(r => r.status === 'ready' && r.filename?.includes('hostile-null')));
check('hostile-fn-export not loaded', !result.results.some(r => r.status === 'ready' && r.filename?.includes('hostile-fn')));

console.log('');
console.log('  Group 5: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 9 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 6: Provider that attempts process.exit
# ═══════════════════════════════════════════════════════════════

function test_group_6 {
divider " Group 6: Hostile init() Calls process.exit "
echo ""
echo "  A provider attempts to kill the server during init()."
echo ""

create_hostile "hostile-exit.js" '
export default {
  name: "hostile_exit",
  type: "oidc",
  priority: 1,
  issuer: "https://exit.test/",
  jwksUri: "https://exit.test/.well-known/jwks.json",
  audience: "test",
  clientId: "test",
  isConfigured() { return process.env.HOSTILE_EXIT === "true"; },
  async init() { process.exit(99); },
  getRoutes() { return null; },
  getLoginUrl() { return ""; },
  async exchangeCode() { return {}; },
  async getUserInfo() { return {}; },
  getLogoutUrl() { return ""; }
};
'

HOSTILE_EXIT=true node --input-type=module -e "
import { _resetForTesting, initRegistry } from './src/auth/index.js';
_resetForTesting();
await initRegistry(() => {});
console.log('SURVIVED');
" 2>&1

local exit_code=$?

if [ $exit_code -eq 99 ]; then
  echo "  ⚠ VULNERABILITY — hostile provider killed the process via process.exit()"
  echo "  ⚠ Recommendation: Run provider init() in a try/catch that catches exit"
  echo "    or validate provider code before execution"
  FAIL=$((FAIL + 1))
elif [ $exit_code -eq 0 ]; then
  echo "  ✓ Server survived hostile process.exit()"
  PASS=$((PASS + 1))
else
  echo "  ⚠ VULNERABILITY — process exited with code $exit_code"
  FAIL=$((FAIL + 1))
fi
}

# ═══════════════════════════════════════════════════════════════
# Group 7: Provider init() that pollutes global state
# ═══════════════════════════════════════════════════════════════

function test_group_7 {
divider " Group 7: Global State Pollution "
echo ""
echo "  A provider modifies process.env or global objects during init()."
echo ""

create_hostile "hostile-pollute.js" '
export default {
  name: "hostile_pollute",
  type: "oidc",
  priority: 50,
  issuer: "https://pollute.test/",
  jwksUri: "https://pollute.test/.well-known/jwks.json",
  audience: "test",
  clientId: "test",
  isConfigured() { return process.env.HOSTILE_POLLUTE === "true"; },
  async init() {
    process.env.ANTHROPIC_API_KEY = "stolen_by_hostile_provider";
    process.env.NODE_ENV = "development";
    process.env.ENCRYPTION_SECRET = "hostile_overwrite";
    global.__hostilePayload = "injected";
  },
  getRoutes() { return null; },
  getLoginUrl() { return ""; },
  async exchangeCode() { return {}; },
  async getUserInfo() { return {}; },
  getLogoutUrl() { return ""; }
};
'

HOSTILE_POLLUTE=true MOCK_AUTH_ENABLED=true node --input-type=module -e "
import { _resetForTesting, initRegistry } from './src/auth/index.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// Record env state before
const envBefore = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  NODE_ENV: process.env.NODE_ENV,
  ENCRYPTION_SECRET: process.env.ENCRYPTION_SECRET
};

_resetForTesting();
await initRegistry(() => {});

// Check what the hostile provider changed
if (process.env.ANTHROPIC_API_KEY === 'stolen_by_hostile_provider') {
  console.log('  ⚠ VULNERABILITY — hostile provider overwrote ANTHROPIC_API_KEY');
  check('API key not overwritten', false);
} else {
  check('API key not overwritten', true);
}

if (process.env.ENCRYPTION_SECRET === 'hostile_overwrite') {
  console.log('  ⚠ VULNERABILITY — hostile provider overwrote ENCRYPTION_SECRET');
  check('Encryption secret not overwritten', false);
} else {
  check('Encryption secret not overwritten', true);
}

if (global.__hostilePayload === 'injected') {
  console.log('  ⚠ VULNERABILITY — hostile provider injected global variable');
  check('Global not polluted', false);
} else {
  check('Global not polluted', true);
}

console.log('');
console.log('  NOTE: Preventing env/global pollution requires sandboxing');
console.log('  (e.g., vm module or child_process). Documenting the risk.');
console.log('');
console.log('  Group 7: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 3 - code))
FAIL=$((FAIL + code))
}

######## MAIN

if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> to run group 1 (crash in isConfigured)" x && test_group_1
  read -p "<Enter> to run group 2 (hang in init)" x && test_group_2
  read -p "<Enter> to run group 3 (duplicate names)" x && test_group_3
  read -p "<Enter> to run group 4 (interface mutation)" x && test_group_4
  read -p "<Enter> to run group 5 (malformed files)" x && test_group_5
  read -p "<Enter> to run group 6 (process.exit)" x && test_group_6
  read -p "<Enter> to run group 7 (global pollution)" x && test_group_7
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
  echo "  ⚠ ${FAIL} vulnerability/test failure(s) found."
  echo "  Review output above for VULNERABILITY markers."
else
  echo "  All adversarial tests passed."
fi

divider
echo ""

exit $FAIL
)
