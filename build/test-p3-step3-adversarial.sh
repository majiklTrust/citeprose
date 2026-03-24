#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 3 — JWT + Middleware ADVERSARIAL Tests
# ═══════════════════════════════════════════════════════════════
#
# Usage: bash scripts/test-p3-step3-adversarial.sh
#        bash scripts/test-p3-step3-adversarial.sh --all
#
# Requires: npm install jose
# Does NOT require the server or Auth0.
# Spins up local JWKS, generates adversarial tokens.
#
# Tests: algorithm confusion, header injection, token
# manipulation, middleware bypass, error leakage, replay,
# oversized tokens, case sensitivity, duplicate headers.
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
echo "  Phase 3 Step 3 — JWT + Middleware ADVERSARIAL Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

if [ ! -f "src/auth/jwt-verifier.js" ]; then
  echo "  ERROR: src/auth/jwt-verifier.js not found."
  exit 1
fi

echo -n "  jose dependency check: "
node --input-type=module -e "import 'jose'; console.log('installed');" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "  ERROR: jose not installed. Run: npm install jose"
  exit 1
fi

# ═══════════════════════════════════════════════════════════════
# Group 1: Algorithm confusion attacks
# ═══════════════════════════════════════════════════════════════

function test_group_1 {
divider " Group 1: Algorithm Confusion "
echo ""
echo "  The #1 JWT attack: alg:none, alg:HS256 with public key."
echo ""

node --input-type=module -e "
import { createTestJWKS } from './src/auth/_test-helper.js';
import { verifyToken, clearJwksCache } from './src/auth/jwt-verifier.js';
import crypto from 'node:crypto';

const helper = await createTestJWKS();

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

async function expectReject(label, token) {
  try {
    await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
    check(label, false);
    console.log('    ⚠ TOKEN ACCEPTED — this is a critical vulnerability');
  } catch (e) {
    check(label + ' → ' + e.message, true);
  }
}

try {
  // alg: none — unsigned token
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const nonePayload = Buffer.from(JSON.stringify({
    sub: 'attacker', iss: helper.issuer, aud: helper.audience,
    iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 3600
  })).toString('base64url');
  await expectReject('alg:none with empty signature', noneHeader + '.' + nonePayload + '.');
  await expectReject('alg:none with no signature', noneHeader + '.' + nonePayload);

  // alg: none with forged kid
  const noneKidHeader = Buffer.from(JSON.stringify({ alg: 'none', kid: helper.kid })).toString('base64url');
  await expectReject('alg:none with valid kid', noneKidHeader + '.' + nonePayload + '.');

  // alg: HS256 — symmetric algo with arbitrary secret
  const hs256Header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const hs256Sig = crypto.createHmac('sha256', 'any-secret')
    .update(hs256Header + '.' + nonePayload).digest('base64url');
  await expectReject('alg:HS256 with arbitrary secret', hs256Header + '.' + nonePayload + '.' + hs256Sig);

  // alg: HS384, HS512
  const hs384Header = Buffer.from(JSON.stringify({ alg: 'HS384' })).toString('base64url');
  const hs384Sig = crypto.createHmac('sha384', 'secret').update(hs384Header + '.' + nonePayload).digest('base64url');
  await expectReject('alg:HS384 rejected', hs384Header + '.' + nonePayload + '.' + hs384Sig);

  const hs512Header = Buffer.from(JSON.stringify({ alg: 'HS512' })).toString('base64url');
  const hs512Sig = crypto.createHmac('sha512', 'secret').update(hs512Header + '.' + nonePayload).digest('base64url');
  await expectReject('alg:HS512 rejected', hs512Header + '.' + nonePayload + '.' + hs512Sig);

  // alg: RS384 (valid algorithm but wrong key type for our RS256 JWKS)
  const rs384Header = Buffer.from(JSON.stringify({ alg: 'RS384', kid: helper.kid })).toString('base64url');
  const fakeSig384 = crypto.randomBytes(64).toString('base64url');
  await expectReject('alg:RS384 with RS256 key', rs384Header + '.' + nonePayload + '.' + fakeSig384);

} finally {
  await helper.close();
  clearJwksCache();
}

console.log('');
console.log('  Group 1: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 8 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 2: JWT header injection (jku, jwk, x5u, x5c)
# ═══════════════════════════════════════════════════════════════

function test_group_2 {
divider " Group 2: JWT Header Injection "
echo ""
echo "  Attacker embeds jku/jwk/x5u/x5c headers pointing to"
echo "  their own keys. Verifier must ignore embedded keys."
echo ""

node --input-type=module -e "
import { createTestJWKS } from './src/auth/_test-helper.js';
import { verifyToken, clearJwksCache } from './src/auth/jwt-verifier.js';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import crypto from 'node:crypto';

const helper = await createTestJWKS();

// Generate a SECOND key pair (attacker's keys)
const attacker = await generateKeyPair('RS256');
const attackerJwk = await exportJWK(attacker.publicKey);
attackerJwk.kid = 'attacker-kid';
attackerJwk.use = 'sig';
attackerJwk.alg = 'RS256';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

async function expectReject(label, token) {
  try {
    await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
    check(label, false);
    console.log('    ⚠ TOKEN ACCEPTED — attacker keys were trusted');
  } catch (e) {
    check(label + ' → ' + e.message, true);
  }
}

try {
  const now = Math.floor(Date.now() / 1000);

  // Token signed with attacker's key, jku pointing to attacker server
  const jkuToken = await new SignJWT({ sub: 'attacker', iss: helper.issuer, aud: helper.audience })
    .setProtectedHeader({ alg: 'RS256', kid: 'attacker-kid', jku: 'https://evil.com/.well-known/jwks.json' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(attacker.privateKey);
  await expectReject('jku header injection', jkuToken);

  // Token with embedded jwk (attacker's public key in header)
  const jwkToken = await new SignJWT({ sub: 'attacker', iss: helper.issuer, aud: helper.audience })
    .setProtectedHeader({ alg: 'RS256', kid: 'attacker-kid', jwk: attackerJwk })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(attacker.privateKey);
  await expectReject('jwk header injection (embedded key)', jwkToken);

  // Token with x5u (X.509 URL)
  const x5uToken = await new SignJWT({ sub: 'attacker', iss: helper.issuer, aud: helper.audience })
    .setProtectedHeader({ alg: 'RS256', kid: 'attacker-kid', x5u: 'https://evil.com/cert.pem' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(attacker.privateKey);
  await expectReject('x5u header injection', x5uToken);

  // Token signed with attacker key but using legitimate kid
  const spoofKidToken = await new SignJWT({ sub: 'attacker', iss: helper.issuer, aud: helper.audience })
    .setProtectedHeader({ alg: 'RS256', kid: helper.kid })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(attacker.privateKey);
  await expectReject('Spoofed kid with wrong key', spoofKidToken);

} finally {
  await helper.close();
  clearJwksCache();
}

console.log('');
console.log('  Group 2: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 4 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 3: Token manipulation and claims abuse
# ═══════════════════════════════════════════════════════════════

function test_group_3 {
divider " Group 3: Token Manipulation + Claims Abuse "
echo ""
echo "  Modified payloads, future nbf, oversized tokens."
echo ""

node --input-type=module -e "
import { createTestJWKS } from './src/auth/_test-helper.js';
import { verifyToken, clearJwksCache } from './src/auth/jwt-verifier.js';
import crypto from 'node:crypto';

const helper = await createTestJWKS();

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

async function expectReject(label, token) {
  try {
    await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
    check(label, false);
  } catch (e) {
    check(label + ' → ' + e.message, true);
  }
}

try {
  // Valid token — tamper with payload (change sub)
  const validToken = await helper.signToken({ sub: 'legit_user' });
  const parts = validToken.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  payload.sub = 'attacker';
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const tamperedToken = parts.join('.');
  await expectReject('Tampered payload (changed sub)', tamperedToken);

  // Token with nbf in the future (not valid yet)
  const futureNbf = await helper.signToken({ sub: 'early' });
  const nbfParts = futureNbf.split('.');
  const nbfPayload = JSON.parse(Buffer.from(nbfParts[1], 'base64url').toString());
  nbfPayload.nbf = Math.floor(Date.now()/1000) + 3600; // 1 hour from now
  nbfParts[1] = Buffer.from(JSON.stringify(nbfPayload)).toString('base64url');
  // Re-sign would be needed for valid sig — but tampered token should fail anyway
  await expectReject('Token with future nbf (tampered)', nbfParts.join('.'));

  // Multiple audiences
  const multiAud = await helper.signToken({}, { audience: ['https://linkedin-agent-api', 'https://other-api'] });
  // This might pass if jose accepts array aud containing the expected value
  try {
    const result = await verifyToken(multiAud, helper.issuer, helper.jwksUri, helper.audience);
    console.log('  ℹ Multiple audiences accepted (aud is array containing valid value)');
    check('Multiple aud — documented behavior', true);
  } catch (e) {
    check('Multiple aud rejected: ' + e.message, true);
  }

  // Extremely large token (1MB payload)
  const hugePayload = { sub: 'attacker', data: 'x'.repeat(1000000) };
  try {
    const hugeToken = await helper.signToken(hugePayload);
    await expectReject('1MB token', hugeToken);
  } catch (e) {
    check('1MB token — rejected or errored: ' + e.message?.substring(0, 40), true);
  }

  // Token with no kid header
  const noKidParts = validToken.split('.');
  const header = JSON.parse(Buffer.from(noKidParts[0], 'base64url').toString());
  delete header.kid;
  noKidParts[0] = Buffer.from(JSON.stringify(header)).toString('base64url');
  await expectReject('Token with no kid header (tampered)', noKidParts.join('.'));

  // Empty JSON object as token
  const emptyHeader = Buffer.from('{}').toString('base64url');
  const emptyPayload = Buffer.from('{}').toString('base64url');
  const emptySig = crypto.randomBytes(32).toString('base64url');
  await expectReject('Empty JSON header and payload', emptyHeader + '.' + emptyPayload + '.' + emptySig);

  // Null bytes in token
  const nullToken = 'eyJ\\x00bGciOiJ.eyJ\\x00dWIi.sig';
  await expectReject('Null bytes in token', nullToken);

} finally {
  await helper.close();
  clearJwksCache();
}

console.log('');
console.log('  Group 3: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 8 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 4: Middleware bypass attempts
# ═══════════════════════════════════════════════════════════════

function test_group_4 {
divider " Group 4: Middleware Bypass Attempts "
echo ""
echo "  Authorization header variations, case sensitivity,"
echo "  double headers, token in wrong location."
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

const { requireAuth } = createAuthMiddleware(() => {});

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

function mockReq(headers, extras = {}) { return { headers, path: '/api/test', query: extras.query || {}, cookies: extras.cookies || {} }; }
function mockRes() {
  let _s = null, _j = null;
  return { status(s) { _s = s; return this; }, json(j) { _j = j; return this; }, getStatus() { return _s; }, getJson() { return _j; } };
}

async function expectBlock(label, req) {
  const res = mockRes();
  let next = false;
  await requireAuth(req, res, () => { next = true; });
  if (!next && res.getStatus() === 401) {
    check(label, true);
  } else {
    check(label + ' (next=' + next + ', status=' + res.getStatus() + ')', false);
  }
}

async function expectPass(label, req) {
  const res = mockRes();
  let next = false;
  await requireAuth(req, res, () => { next = true; });
  check(label, next && req.user?.sub);
}

try {
  const validToken = await helper.signToken({ sub: 'user1' });

  // Case sensitivity of Bearer
  await expectPass('Bearer (correct case)', mockReq({ authorization: 'Bearer ' + validToken }));
  await expectPass('bearer (lowercase)', mockReq({ authorization: 'bearer ' + validToken }));
  await expectPass('BEARER (uppercase)', mockReq({ authorization: 'BEARER ' + validToken }));

  // Extra spaces
  await expectBlock('Double space: Bearer  token', mockReq({ authorization: 'Bearer  ' + validToken }));
  await expectBlock('Leading space:  Bearer token', mockReq({ authorization: ' Bearer ' + validToken }));

  // Wrong scheme
  await expectBlock('Basic scheme', mockReq({ authorization: 'Basic ' + validToken }));
  await expectBlock('Token scheme', mockReq({ authorization: 'Token ' + validToken }));
  await expectBlock('MAC scheme', mockReq({ authorization: 'MAC ' + validToken }));

  // Token in wrong location (should be header only)
  await expectBlock('Token in query string', mockReq({}, { query: { access_token: validToken } }));
  await expectBlock('Token in cookie', mockReq({}, { cookies: { access_token: validToken } }));

  // Empty bearer
  await expectBlock('Bearer with no token', mockReq({ authorization: 'Bearer ' }));
  await expectBlock('Bearer with spaces only', mockReq({ authorization: 'Bearer    ' }));

  // Pre-set req.user (should be overwritten, not trusted)
  const presetReq = mockReq({ authorization: 'Bearer ' + validToken });
  presetReq.user = { sub: 'pre-existing-attacker', isAdmin: true };
  const presetRes = mockRes();
  let presetNext = false;
  await requireAuth(presetReq, presetRes, () => { presetNext = true; });
  check('Pre-set req.user overwritten', presetReq.user?.sub === 'user1');
  check('Pre-set isAdmin not preserved', presetReq.user?.isAdmin === undefined);

} finally {
  await helper.close();
  clearJwksCache();
  delete process.env.MOCK_AUTH_ENABLED;
}

console.log('');
console.log('  Group 4: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 16 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 5: Error response information leakage
# ═══════════════════════════════════════════════════════════════

function test_group_5 {
divider " Group 5: Error Response Information Leakage "
echo ""
echo "  401 responses must not vary based on failure reason"
echo "  in a way that helps an attacker enumerate valid tokens."
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

const { requireAuth } = createAuthMiddleware(() => {});

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

function mockReq(headers) { return { headers, path: '/api/test' }; }
function mockRes() {
  let _s = null, _j = null;
  return { status(s) { _s = s; return this; }, json(j) { _j = j; return this; }, getStatus() { return _s; }, getJson() { return _j; } };
}

try {
  // Collect all error responses
  const responses = [];

  const scenarios = [
    ['No header', {}],
    ['Fabricated token', { authorization: 'Bearer ' + helper.fabricateToken() }],
    ['Expired token', { authorization: 'Bearer ' + await helper.signExpiredToken() }],
    ['Wrong issuer', { authorization: 'Bearer ' + await helper.signToken({}, { issuer: 'https://other.com/' }) }],
    ['Garbage', { authorization: 'Bearer not-a-jwt-at-all' }],
    ['Empty bearer', { authorization: 'Bearer ' }]
  ];

  for (const [label, headers] of scenarios) {
    const res = mockRes();
    await requireAuth(mockReq(headers), res, () => {});
    responses.push({ label, status: res.getStatus(), json: res.getJson() });
  }

  // All should be 401
  const allAre401 = responses.every(r => r.status === 401);
  check('All invalid tokens return 401', allAre401);

  // Check no response contains internal details
  for (const r of responses) {
    const json = JSON.stringify(r.json || {});
    check(r.label + ' — no stack trace', !json.includes('at ') && !json.includes('.js:'));
    check(r.label + ' — no jose errors', !json.includes('JWS') && !json.includes('JWK') && !json.includes('jose'));
    check(r.label + ' — no file paths', !json.includes('/src/') && !json.includes('node_modules'));
  }

  // The error messages should be generic enough to not help attackers
  // but specific enough to help developers. Expired is the one exception
  // where a distinct message is acceptable (user needs to know to re-login).
  const expiredResp = responses.find(r => r.label === 'Expired token');
  check('Expired has distinct message (acceptable)', expiredResp?.json?.error?.includes('expired'));

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
PASS=$((PASS + 20 - code))
FAIL=$((FAIL + code))
}

# ═══════════════════════════════════════════════════════════════
# Group 6: JWKS endpoint abuse
# ═══════════════════════════════════════════════════════════════

function test_group_6 {
divider " Group 6: JWKS Endpoint Abuse "
echo ""
echo "  Empty JWKS, malformed JWKS, unreachable JWKS."
echo ""

node --input-type=module -e "
import { verifyToken, clearJwksCache } from './src/auth/jwt-verifier.js';
import { createTestJWKS } from './src/auth/_test-helper.js';
import http from 'node:http';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label); fail++; } }

const helper = await createTestJWKS();
const validToken = await helper.signToken({ sub: 'user1' });

try {
  // Empty JWKS endpoint
  const emptyServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [] }));
  });
  await new Promise(r => emptyServer.listen(0, '127.0.0.1', r));
  const emptyUri = 'http://127.0.0.1:' + emptyServer.address().port + '/.well-known/jwks.json';

  clearJwksCache();
  try {
    await verifyToken(validToken, helper.issuer, emptyUri, helper.audience);
    check('Empty JWKS — token rejected', false);
  } catch (e) {
    check('Empty JWKS — token rejected: ' + e.message, true);
  }
  emptyServer.close();

  // Malformed JWKS (not JSON)
  const badServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('this is not json');
  });
  await new Promise(r => badServer.listen(0, '127.0.0.1', r));
  const badUri = 'http://127.0.0.1:' + badServer.address().port + '/.well-known/jwks.json';

  clearJwksCache();
  try {
    await verifyToken(validToken, helper.issuer, badUri, helper.audience);
    check('Malformed JWKS — token rejected', false);
  } catch (e) {
    check('Malformed JWKS — token rejected: ' + e.message, true);
  }
  badServer.close();

  // JWKS endpoint that returns 500
  const errorServer = http.createServer((req, res) => {
    res.writeHead(500);
    res.end('Internal Server Error');
  });
  await new Promise(r => errorServer.listen(0, '127.0.0.1', r));
  const errorUri = 'http://127.0.0.1:' + errorServer.address().port + '/.well-known/jwks.json';

  clearJwksCache();
  try {
    await verifyToken(validToken, helper.issuer, errorUri, helper.audience);
    check('500 JWKS — token rejected', false);
  } catch (e) {
    check('500 JWKS — token rejected: ' + e.message, true);
  }
  errorServer.close();

  // Unreachable JWKS
  clearJwksCache();
  try {
    await verifyToken(validToken, helper.issuer, 'http://127.0.0.1:1/.well-known/jwks.json', helper.audience);
    check('Unreachable JWKS — token rejected', false);
  } catch (e) {
    check('Unreachable JWKS — token rejected: ' + e.message, true);
  }

} finally {
  await helper.close();
  clearJwksCache();
}

console.log('');
console.log('  Group 6: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?
PASS=$((PASS + 4 - code))
FAIL=$((FAIL + code))
}

######## MAIN

if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> to run group 1 (algorithm confusion)" x && test_group_1
  read -p "<Enter> to run group 2 (header injection)" x && test_group_2
  read -p "<Enter> to run group 3 (token manipulation)" x && test_group_3
  read -p "<Enter> to run group 4 (middleware bypass)" x && test_group_4
  read -p "<Enter> to run group 5 (error leakage)" x && test_group_5
  read -p "<Enter> to run group 6 (JWKS abuse)" x && test_group_6
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
  echo "  Review output above for VULNERABILITY markers."
else
  echo "  All adversarial tests passed."
fi

divider
echo ""

exit $FAIL
)
