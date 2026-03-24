#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 3 — JWT Verification + Auth Middleware Test Suite
# ═══════════════════════════════════════════════════════════════
#
# Usage: bash scripts/test-p3-step3.sh
#        bash scripts/test-p3-step3.sh --all     (skip prompts)
#
# Requires: npm install jose
# Does NOT require the server to be running.
# Does NOT require an Auth0 account.
# Spins up a local JWKS server, generates real signed tokens,
# and tests the full verification pipeline.
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
# Preflight
# ═══════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 3 — JWT Verification + Middleware Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

if [ ! -f "src/auth/jwt-verifier.js" ]; then
  echo "  ERROR: src/auth/jwt-verifier.js not found."
  echo "  Apply Phase 3 Step 3 code drop first."
  exit 1
fi

if [ ! -f "src/auth/middleware.js" ]; then
  echo "  ERROR: src/auth/middleware.js not found."
  echo "  Apply Phase 3 Step 3 code drop first."
  exit 1
fi

echo -n "  jose dependency check: "
node --input-type=module -e "import 'jose'; console.log('installed');" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "  ERROR: jose is not installed. Run: npm install jose"
  exit 1
fi

# ═══════════════════════════════════════════════════════════════
# Group 1: JWT Verifier — valid tokens
# ═══════════════════════════════════════════════════════════════

function test_group_1 {
divider " Group 1: JWT Verifier — Valid Tokens "
echo ""

node --input-type=module -e "
import { createTestJWKS } from './src/auth/_test-helper.js';
import { verifyToken, clearJwksCache } from './src/auth/jwt-verifier.js';

const helper = await createTestJWKS();

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

try {
  // Basic valid token
  const token = await helper.signToken({ sub: 'user_001', email: 'user@test.com', name: 'Test User' });
  const payload = await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
  check('Valid token accepted', !!payload);
  check('Payload has sub', payload.sub === 'user_001');
  check('Payload has email', payload.email === 'user@test.com');
  check('Payload has name', payload.name === 'Test User');
  check('Payload has iss', payload.iss === helper.issuer);
  check('Payload has aud', payload.aud === helper.audience);
  check('Payload has exp', typeof payload.exp === 'number');
  check('Payload has iat', typeof payload.iat === 'number');

  // Token with custom claims
  const token2 = await helper.signToken({ sub: 'admin', role: 'admin', orgId: 'org_123' });
  const payload2 = await verifyToken(token2, helper.issuer, helper.jwksUri, helper.audience);
  check('Custom claims preserved — role', payload2.role === 'admin');
  check('Custom claims preserved — orgId', payload2.orgId === 'org_123');

} finally {
  await helper.close();
  clearJwksCache();
}

console.log('');
console.log('  Group 1: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 10 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 2: JWT Verifier — rejection cases
# ═══════════════════════════════════════════════════════════════

function test_group_2 {
divider " Group 2: JWT Verifier — Rejection Cases "
echo ""

node --input-type=module -e "
import { createTestJWKS } from './src/auth/_test-helper.js';
import { verifyToken, clearJwksCache } from './src/auth/jwt-verifier.js';

const helper = await createTestJWKS();

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

async function expectError(label, fn, expectedCode) {
  try {
    await fn();
    check(label + ' (should have thrown)', false);
  } catch (e) {
    check(label + ' → ' + e.message, e.message === expectedCode);
  }
}

try {
  // Null/missing token
  await expectError('Null token', () => verifyToken(null, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_MISSING');
  await expectError('Empty token', () => verifyToken('', helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_MISSING');
  await expectError('Undefined token', () => verifyToken(undefined, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_MISSING');

  // Malformed tokens
  await expectError('Random string', () => verifyToken('not.a.jwt', helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_INVALID');
  await expectError('Single segment', () => verifyToken('justonepart', helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_INVALID');

  // Fabricated signature
  const fake = helper.fabricateToken();
  await expectError('Fabricated signature', () => verifyToken(fake, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_SIGNATURE_INVALID');

  // Expired token
  const expired = await helper.signExpiredToken();
  await expectError('Expired token', () => verifyToken(expired, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_EXPIRED');

  // Wrong issuer
  const wrongIss = await helper.signWrongIssuerToken();
  await expectError('Wrong issuer', () => verifyToken(wrongIss, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_INVALID_ISSUER');

  // Wrong audience
  const wrongAud = await helper.signWrongAudienceToken();
  await expectError('Wrong audience', () => verifyToken(wrongAud, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_INVALID_AUDIENCE');

  // Missing config
  const validToken = await helper.signToken();
  await expectError('No issuer config', () => verifyToken(validToken, null, helper.jwksUri, helper.audience), 'VERIFIER_MISCONFIGURED');
  await expectError('No jwksUri config', () => verifyToken(validToken, helper.issuer, null, helper.audience), 'VERIFIER_MISCONFIGURED');

} finally {
  await helper.close();
  clearJwksCache();
}

console.log('');
console.log('  Group 2: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 11 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 3: Middleware — requireAuth with auth enabled
# ═══════════════════════════════════════════════════════════════

function test_group_3 {
divider " Group 3: Middleware — requireAuth (auth enabled) "
echo ""

node --input-type=module -e "
import { createTestJWKS } from './src/auth/_test-helper.js';
import { clearJwksCache } from './src/auth/jwt-verifier.js';
import { _resetForTesting, initRegistry, getProviders } from './src/auth/index.js';
import { createAuthMiddleware } from './src/auth/middleware.js';

// Boot a local JWKS server
const helper = await createTestJWKS({ issuer: 'https://mock-auth.test/' });

// Configure mock provider to use our local JWKS
_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';

// We need to override the mock provider's jwksUri to point to our local server.
// The cleanest way: init the registry, then monkey-patch the provider for testing.
await initRegistry(() => {});
const providers = getProviders();
const mockProv = providers.find(p => p.name === 'mock');
// Patch the provider fields to match our test JWKS
Object.defineProperty(mockProv, 'jwksUri', { get: () => helper.jwksUri, configurable: true });
Object.defineProperty(mockProv, 'audience', { get: () => helper.audience, configurable: true });

const logs = [];
const logFn = (level, action, details) => logs.push({ level, action, details });
const { requireAuth } = createAuthMiddleware(logFn);

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// Mock Express req/res/next
function mockReq(headers = {}) {
  return { headers, path: '/api/test' };
}
function mockRes() {
  let _status = null, _json = null;
  return {
    status(s) { _status = s; return this; },
    json(j) { _json = j; return this; },
    getStatus() { return _status; },
    getJson() { return _json; }
  };
}

try {
  // 1. Valid token
  const token = await helper.signToken({ sub: 'user1', email: 'u@test.com' });
  const req1 = mockReq({ authorization: 'Bearer ' + token });
  const res1 = mockRes();
  let nextCalled = false;
  await requireAuth(req1, res1, () => { nextCalled = true; });
  check('Valid token — next() called', nextCalled);
  check('Valid token — req.user set', req1.user?.sub === 'user1');
  check('Valid token — req.user.email', req1.user?.email === 'u@test.com');
  check('Valid token — req.authProvider', req1.authProvider === 'mock');

  // 2. No Authorization header
  const req2 = mockReq({});
  const res2 = mockRes();
  nextCalled = false;
  await requireAuth(req2, res2, () => { nextCalled = true; });
  check('No header — blocked', !nextCalled);
  check('No header — 401', res2.getStatus() === 401);
  check('No header — message', res2.getJson()?.error === 'Authentication required.');

  // 3. Malformed header
  const req3 = mockReq({ authorization: 'NotBearer token' });
  const res3 = mockRes();
  nextCalled = false;
  await requireAuth(req3, res3, () => { nextCalled = true; });
  check('Bad format — blocked', !nextCalled);
  check('Bad format — 401', res3.getStatus() === 401);
  check('Bad format — message', res3.getJson()?.error === 'Invalid authorization header format.');

  // 4. Expired token
  const expired = await helper.signExpiredToken();
  const req4 = mockReq({ authorization: 'Bearer ' + expired });
  const res4 = mockRes();
  nextCalled = false;
  await requireAuth(req4, res4, () => { nextCalled = true; });
  check('Expired — blocked', !nextCalled);
  check('Expired — 401', res4.getStatus() === 401);
  check('Expired — message', res4.getJson()?.error === 'Token expired. Please log in again.');

  // 5. Fabricated signature
  const fake = helper.fabricateToken();
  const req5 = mockReq({ authorization: 'Bearer ' + fake });
  const res5 = mockRes();
  nextCalled = false;
  await requireAuth(req5, res5, () => { nextCalled = true; });
  check('Fake sig — blocked', !nextCalled);
  check('Fake sig — 401', res5.getStatus() === 401);
  check('Fake sig — message', res5.getJson()?.error === 'Invalid token.');

  // 6. Wrong issuer (unknown to registry)
  const wrongIss = await helper.signToken({}, { issuer: 'https://unknown.com/' });
  const req6 = mockReq({ authorization: 'Bearer ' + wrongIss });
  const res6 = mockRes();
  nextCalled = false;
  await requireAuth(req6, res6, () => { nextCalled = true; });
  check('Unknown issuer — blocked', !nextCalled);
  check('Unknown issuer — 401', res6.getStatus() === 401);
  check('Unknown issuer — message', res6.getJson()?.error === 'Token issuer not recognized.');

  // 7. Garbage token
  const req7 = mockReq({ authorization: 'Bearer totalnonsense' });
  const res7 = mockRes();
  nextCalled = false;
  await requireAuth(req7, res7, () => { nextCalled = true; });
  check('Garbage — blocked', !nextCalled);
  check('Garbage — 401', res7.getStatus() === 401);

  // 8. No error details leaked
  check('No stack traces in any response', [res2, res3, res4, res5, res6, res7].every(r => {
    const j = r.getJson();
    return !j?.stack && !j?.detail && !j?.code;
  }));

} finally {
  await helper.close();
  clearJwksCache();
  delete process.env.MOCK_AUTH_ENABLED;
}

console.log('');
console.log('  Group 3: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 24 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 4: Middleware — requireAuth with auth disabled (dev mode)
# ═══════════════════════════════════════════════════════════════

function test_group_4 {
divider " Group 4: Middleware — requireAuth (auth disabled) "
echo ""

node --input-type=module -e "
import { _resetForTesting, initRegistry } from './src/auth/index.js';
import { createAuthMiddleware } from './src/auth/middleware.js';

// No providers configured — dev mode
_resetForTesting();
delete process.env.MOCK_AUTH_ENABLED;
delete process.env.AUTH0_DOMAIN;
await initRegistry(() => {});

const { requireAuth } = createAuthMiddleware(() => {});

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

function mockReq(headers = {}) { return { headers, path: '/api/test' }; }
function mockRes() {
  let _status = null, _json = null;
  return {
    status(s) { _status = s; return this; },
    json(j) { _json = j; return this; },
    getStatus() { return _status; },
    getJson() { return _json; }
  };
}

// No token — should pass through in dev mode
const req1 = mockReq({});
const res1 = mockRes();
let nextCalled = false;
await requireAuth(req1, res1, () => { nextCalled = true; });
check('Dev mode — next() called without token', nextCalled);
check('Dev mode — req.user is null', req1.user === null);
check('Dev mode — req.authSkipped is true', req1.authSkipped === true);

// With a garbage token — should still pass through
const req2 = mockReq({ authorization: 'Bearer garbage' });
const res2 = mockRes();
nextCalled = false;
await requireAuth(req2, res2, () => { nextCalled = true; });
check('Dev mode — passes even with bad token', nextCalled);
check('Dev mode — req.authSkipped with bad token', req2.authSkipped === true);

console.log('');
console.log('  Group 4: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 5 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 5: Middleware — optionalAuth
# ═══════════════════════════════════════════════════════════════

function test_group_5 {
divider " Group 5: Middleware — optionalAuth "
echo ""

node --input-type=module -e "
import { createTestJWKS } from './src/auth/_test-helper.js';
import { clearJwksCache } from './src/auth/jwt-verifier.js';
import { _resetForTesting, initRegistry, getProviders } from './src/auth/index.js';
import { createAuthMiddleware } from './src/auth/middleware.js';

const helper = await createTestJWKS({ issuer: 'https://mock-auth.test/' });

_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});

const mockProv = getProviders().find(p => p.name === 'mock');
Object.defineProperty(mockProv, 'jwksUri', { get: () => helper.jwksUri, configurable: true });
Object.defineProperty(mockProv, 'audience', { get: () => helper.audience, configurable: true });

const { optionalAuth } = createAuthMiddleware(() => {});

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

function mockReq(headers = {}) { return { headers, path: '/test' }; }
function mockRes() {
  let _status = null, _json = null;
  return {
    status(s) { _status = s; return this; },
    json(j) { _json = j; return this; },
    getStatus() { return _status; },
    getJson() { return _json; }
  };
}

try {
  // Valid token — user attached
  const token = await helper.signToken({ sub: 'opt_user' });
  const req1 = mockReq({ authorization: 'Bearer ' + token });
  const res1 = mockRes();
  let nextCalled = false;
  await optionalAuth(req1, res1, () => { nextCalled = true; });
  check('Valid token — next() called', nextCalled);
  check('Valid token — req.user.sub', req1.user?.sub === 'opt_user');

  // No token — passes through with null user
  const req2 = mockReq({});
  const res2 = mockRes();
  nextCalled = false;
  await optionalAuth(req2, res2, () => { nextCalled = true; });
  check('No token — next() called', nextCalled);
  check('No token — req.user is null', req2.user === null);

  // Bad token — passes through with null user (no error)
  const req3 = mockReq({ authorization: 'Bearer expired_or_bad' });
  const res3 = mockRes();
  nextCalled = false;
  await optionalAuth(req3, res3, () => { nextCalled = true; });
  check('Bad token — next() called (no block)', nextCalled);
  check('Bad token — req.user is null', req3.user === null);
  check('Bad token — no error response', res3.getStatus() === null);

  // Expired token — passes through silently
  const expired = await helper.signExpiredToken();
  const req4 = mockReq({ authorization: 'Bearer ' + expired });
  const res4 = mockRes();
  nextCalled = false;
  await optionalAuth(req4, res4, () => { nextCalled = true; });
  check('Expired — next() called (no block)', nextCalled);
  check('Expired — req.user is null', req4.user === null);

} finally {
  await helper.close();
  clearJwksCache();
  delete process.env.MOCK_AUTH_ENABLED;
}

console.log('');
console.log('  Group 5: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 9 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 6: Error message safety
# ═══════════════════════════════════════════════════════════════

function test_group_6 {
divider " Group 6: Error Message Safety "
echo ""
echo "  Verify no internal details leak in auth error responses."
echo ""

node --input-type=module -e "
import { verifyToken } from './src/auth/jwt-verifier.js';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

// Collect all error messages the verifier can produce
const errorCodes = [];
const tests = [
  [null, 'x', 'x', 'x'],
  ['bad', 'x', 'x', 'x'],
  ['a.b.c', 'iss', 'http://localhost:1/j', 'aud']
];

for (const args of tests) {
  try { await verifyToken(...args); }
  catch (e) { errorCodes.push(e.message); }
}

// None should contain stack traces, file paths, or jose internals
for (const code of errorCodes) {
  check('No file paths: ' + code, !code.includes('/') && !code.includes('\\\\'));
  check('No stack trace: ' + code, !code.includes('at ') && !code.includes('.js:'));
  check('Uppercase code format: ' + code, /^[A-Z_]+$/.test(code));
}

console.log('');
console.log('  Group 6: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 9 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 7: jose isolation verification
# ═══════════════════════════════════════════════════════════════

function test_group_7 {
divider " Group 7: jose Isolation Verification "
echo ""
echo "  Confirm jose is imported ONLY in jwt-verifier.js."
echo ""

local jose_in_verifier=$(grep -c "from ['\"]jose['\"]" src/auth/jwt-verifier.js)
local jose_in_middleware=$(grep -c "from ['\"]jose['\"]" src/auth/middleware.js)
local jose_in_registry=$(grep -c "from ['\"]jose['\"]" src/auth/index.js)
local jose_in_auth0=$(grep -c "from ['\"]jose['\"]" src/auth/providers/auth0.js)
local jose_in_mock=$(grep -c "from ['\"]jose['\"]" src/auth/providers/mock.js)

local p=0 f=0
if [ "$jose_in_verifier" -ge 1 ]; then echo "  ✓ jwt-verifier.js imports jose"; p=$((p+1)); else echo "  ✗ jwt-verifier.js should import jose"; f=$((f+1)); fi
if [ "$jose_in_middleware" -eq 0 ]; then echo "  ✓ middleware.js does not import jose"; p=$((p+1)); else echo "  ✗ middleware.js should not reference jose"; f=$((f+1)); fi
if [ "$jose_in_registry" -eq 0 ]; then echo "  ✓ index.js does not import jose"; p=$((p+1)); else echo "  ✗ index.js should not reference jose"; f=$((f+1)); fi
if [ "$jose_in_auth0" -eq 0 ]; then echo "  ✓ auth0.js does not import jose"; p=$((p+1)); else echo "  ✗ auth0.js should not import jose"; f=$((f+1)); fi
if [ "$jose_in_mock" -eq 0 ]; then echo "  ✓ mock.js does not import jose"; p=$((p+1)); else echo "  ✗ mock.js should not import jose"; f=$((f+1)); fi

PASS=$((PASS + p))
FAIL=$((FAIL + f))
echo ""
echo "  Group 7: $p passed, $f failed"
}

######## MAIN
# Verify node
if ! command -v node; then
  nodever
  exit 1
fi

if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> to run group 1 (verifier — valid tokens)" x && test_group_1
  read -p "<Enter> to run group 2 (verifier — rejections)" x && test_group_2
  read -p "<Enter> to run group 3 (middleware — requireAuth enabled)" x && test_group_3
  read -p "<Enter> to run group 4 (middleware — requireAuth disabled)" x && test_group_4
  read -p "<Enter> to run group 5 (middleware — optionalAuth)" x && test_group_5
  read -p "<Enter> to run group 6 (error message safety)" x && test_group_6
  read -p "<Enter> to run group 7 (jose isolation)" x && test_group_7
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
