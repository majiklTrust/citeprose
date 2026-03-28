// ═══════════════════════════════════════════════════════════════
// Step 3 Design Group 3: Error Taxonomy
//
// Error codes are not strings — they are a contract between
// the auth layer and every consumer. If a code changes, the
// frontend's error handling breaks. If codes are constructed
// at runtime with string concatenation, they drift silently.
//
// This group demands that error codes are enumerated, stable,
// and distinguishable — not just "safe" but architecturally
// sound enough to survive versioning.
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { verifyToken, clearJwksCache } from '../../../src/auth/jwt-verifier.js';
import { _resetForTesting, initRegistry, getProviders, _patchSnapshotForTesting } from '../../../src/auth/index.js';
import { createAuthMiddleware } from '../../../src/auth/middleware.js';

// ── Group 3: Error code architecture ─────────────────────────

group('Group 3: Error code architecture', `
  If these tests fail, the auth layer produces error codes that
  are ambiguous, unsafe, or unstable. The frontend cannot
  distinguish "token expired" from "token forged" — it shows
  the same generic error for both. Users get no guidance.
  Operators cannot triage from logs.
`);

var before3 = getCounters();

// ── Collect all verifier error codes ─────────────────────────

var helper = await createTestJWKS({ issuer: 'https://mock-auth.test/' });

var errorScenarios = [
  ['null token', async () => verifyToken(null, helper.issuer, helper.jwksUri, helper.audience)],
  ['empty token', async () => verifyToken('', helper.issuer, helper.jwksUri, helper.audience)],
  ['garbage token', async () => verifyToken('not.a.jwt', helper.issuer, helper.jwksUri, helper.audience)],
  ['fabricated sig', async () => verifyToken(helper.fabricateToken(), helper.issuer, helper.jwksUri, helper.audience)],
  ['expired token', async () => verifyToken(await helper.signExpiredToken(), helper.issuer, helper.jwksUri, helper.audience)],
  ['wrong issuer', async () => verifyToken(await helper.signToken({}, { issuer: 'https://wrong.com/' }), helper.issuer, helper.jwksUri, helper.audience)],
  ['wrong audience', async () => verifyToken(await helper.signToken({}, { audience: 'wrong-aud' }), helper.issuer, helper.jwksUri, helper.audience)],
  ['null issuer config', async () => verifyToken('x.y.z', null, helper.jwksUri, helper.audience)],
  ['null jwks config', async () => verifyToken('x.y.z', helper.issuer, null, helper.audience)],
];

var collectedCodes = [];

for (var [scenarioName, fn] of errorScenarios) {
  try { await fn(); collectedCodes.push({ scenario: scenarioName, code: null }); }
  catch (e) { collectedCodes.push({ scenario: scenarioName, code: e.message }); }
}

test('3.3.3.1-D', '', () => {
  console.log('  Every error scenario must produce an error code (not null)');
  console.log('  A missing code means the error path returns success — silent bypass');
  for (var entry of collectedCodes) {
    check(entry.scenario + ' produces error code',
      entry.code !== null, 'error thrown', 'no error thrown');
  }
});

test('3.3.3.2-D', '', () => {
  console.log('  All error codes must be UPPER_SNAKE_CASE');
  console.log('  This convention signals that codes are constants, not prose');
  console.log('  Prose messages change with rewording — constants are stable');
  for (var entry of collectedCodes) {
    if (entry.code) {
      check(entry.scenario + ' code is UPPER_SNAKE: ' + entry.code,
        /^[A-Z][A-Z0-9_]+$/.test(entry.code),
        'UPPER_SNAKE_CASE', entry.code);
    }
  }
});

test('3.3.3.3-D', '', () => {
  console.log('  Error codes must contain no spaces');
  console.log('  Spaces indicate a human-readable message, not a machine-parseable code');
  for (var entry of collectedCodes) {
    if (entry.code) {
      check(entry.scenario + ' — no spaces', !entry.code.includes(' '),
        'no spaces', entry.code);
    }
  }
});

test('3.3.3.4-D', '', () => {
  console.log('  Error codes must contain no file paths, class names, or stack fragments');
  console.log('  These leak implementation details through the error boundary');
  for (var entry of collectedCodes) {
    if (entry.code) {
      check(entry.scenario + ' — no internals',
        !entry.code.includes('/') && !entry.code.includes('.js') &&
        !entry.code.includes('at ') && !entry.code.includes('Error:'),
        'no internals', entry.code);
    }
  }
});

test('3.3.3.5-D', '', () => {
  console.log('  All codes must start with TOKEN_ or VERIFIER_');
  console.log('  A consistent prefix lets consumers pattern-match error origin');
  console.log('  TOKEN_ = problem with the token itself');
  console.log('  VERIFIER_ = problem with the verifier configuration');
  for (var entry of collectedCodes) {
    if (entry.code) {
      check(entry.scenario + ' — prefixed: ' + entry.code,
        entry.code.startsWith('TOKEN_') || entry.code.startsWith('VERIFIER_'),
        'TOKEN_* or VERIFIER_*', entry.code);
    }
  }
});

test('3.3.3.6-D', '', () => {
  console.log('  Different failure modes must produce DIFFERENT codes');
  console.log('  If expired and forged both return TOKEN_INVALID, the frontend cannot');
  console.log('  show "session expired, please log in again" vs "invalid credentials"');
  var codes = collectedCodes.filter(e => e.code).map(e => e.code);
  var unique = new Set(codes);
  console.log('  Codes collected: ' + JSON.stringify(codes));
  console.log('  Unique codes: ' + unique.size + ' / ' + codes.length + ' scenarios');
  // At minimum: missing, invalid, expired, wrong issuer, wrong audience, misconfigured
  // should be distinct
  check('At least 4 distinct error codes', unique.size >= 4,
    '≥4 distinct', unique.size + ' distinct');
});

test('3.3.3.7-D', '', () => {
  console.log('  TOKEN_MISSING must be distinct from TOKEN_INVALID');
  console.log('  Missing = no token was sent (user is not logged in)');
  console.log('  Invalid = token was sent but it is broken (possible attack)');
  console.log('  The frontend handles these differently: redirect to login vs show error');
  var missingCode = collectedCodes.find(e => e.scenario === 'null token')?.code;
  var invalidCode = collectedCodes.find(e => e.scenario === 'garbage token')?.code;
  check('TOKEN_MISSING ≠ TOKEN_INVALID',
    missingCode !== invalidCode,
    'different codes', missingCode + ' === ' + invalidCode);
});

test('3.3.3.8-D', '', () => {
  console.log('  TOKEN_EXPIRED must be a distinct code');
  console.log('  The frontend uses this to trigger silent token refresh');
  console.log('  If it is lumped with TOKEN_INVALID, the refresh never fires');
  var expiredCode = collectedCodes.find(e => e.scenario === 'expired token')?.code;
  var invalidCode = collectedCodes.find(e => e.scenario === 'garbage token')?.code;
  check('Expired has distinct code: ' + expiredCode,
    expiredCode !== invalidCode && expiredCode !== undefined,
    'distinct from invalid', expiredCode + ' vs ' + invalidCode);
});

test('3.3.3.9-D', '', () => {
  console.log('  VERIFIER_MISCONFIGURED must be a distinct code');
  console.log('  This code means the server is broken, not the token');
  console.log('  The operator needs to see this in logs to know the issue is on their side');
  var misconfigCode = collectedCodes.find(e => e.scenario === 'null issuer config')?.code;
  var tokenCodes = collectedCodes
    .filter(e => e.scenario !== 'null issuer config' && e.scenario !== 'null jwks config')
    .map(e => e.code);
  check('VERIFIER_MISCONFIGURED distinct from token errors',
    !tokenCodes.includes(misconfigCode),
    'distinct from TOKEN_*', misconfigCode + ' also used for token errors');
});

// ── Middleware error message contract ─────────────────────────

_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
var mp = getProviders().find(p => p.name === 'mock');
Object.defineProperty(mp, 'jwksUri', { get: () => helper.jwksUri, configurable: true });
Object.defineProperty(mp, 'audience', { get: () => helper.audience, configurable: true });
_patchSnapshotForTesting('mock', { jwksUri: helper.jwksUri, audience: helper.audience });
var { requireAuth } = createAuthMiddleware(() => {});

function mReq(h) { return { headers: h || {}, path: '/api/test' }; }
function mRes() {
  var _s = null, _j = null;
  return { status(s) { _s = s; return this; }, json(j) { _j = j; return this; }, getStatus() { return _s; }, getJson() { return _j; } };
}

var middlewareScenarios = [
  ['no header', {}],
  ['expired token', { authorization: 'Bearer ' + await helper.signExpiredToken() }],
  ['forged token', { authorization: 'Bearer ' + helper.fabricateToken() }],
  ['garbage token', { authorization: 'Bearer not.a.jwt' }],
];

var middlewareResponses = [];
for (var [label, headers] of middlewareScenarios) {
  var res = mRes();
  await requireAuth(mReq(headers), res, () => {});
  middlewareResponses.push({ label, json: res.getJson() });
}

test('3.3.3.10-D', '', () => {
  console.log('  Middleware must translate verifier codes into user-facing messages');
  console.log('  The verifier returns TOKEN_EXPIRED — the middleware returns');
  console.log('  "Token expired. Please log in again." — not the raw code');
  console.log('  Raw codes are for logs. Messages are for users.');
  for (var r of middlewareResponses) {
    check(r.label + ' — has error field in JSON',
      r.json?.error !== undefined, 'error field present', 'missing');
  }
});

test('3.3.3.11-D', '', () => {
  console.log('  User-facing messages must be complete English sentences');
  console.log('  Not "TOKEN_EXPIRED" — that is a developer artifact');
  console.log('  Not "invalid" — that is ambiguous');
  console.log('  The message must end with a period and start with a capital letter');
  for (var r of middlewareResponses) {
    var msg = r.json?.error || '';
    check(r.label + ' — message is a sentence',
      msg.length > 10 && msg[0] === msg[0].toUpperCase() && msg.endsWith('.'),
      'capitalized sentence ending with period', msg);
  }
});

test('3.3.3.12-D', '', () => {
  console.log('  User-facing messages must NOT contain raw error codes');
  console.log('  TOKEN_EXPIRED in the response body means the code leaked through');
  for (var r of middlewareResponses) {
    var msg = r.json?.error || '';
    check(r.label + ' — no raw codes in message',
      !(/^[A-Z_]+$/.test(msg)) && !msg.includes('TOKEN_') && !msg.includes('VERIFIER_'),
      'human message', msg);
  }
});

await helper.close();
clearJwksCache();
delete process.env.MOCK_AUTH_ENABLED;

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
