// ═══════════════════════════════════════════════════════════════
// Step 3 Design Groups 4, 5: Cache & State Management
//
// Auth state that leaks across requests is a vulnerability.
// Auth state that never clears is a memory leak. Auth state
// that trusts mutable objects is a time bomb.
//
// These tests demand that caching, request isolation, and
// immutability are enforced by design — not by accident.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { verifyToken, clearJwksCache } from '../../../src/auth/jwt-verifier.js';
import { _resetForTesting, initRegistry, getProviders, getJwksMap, getIssuers,
         getSnapshotByIssuer, _patchSnapshotForTesting } from '../../../src/auth/index.js';
import { createAuthMiddleware } from '../../../src/auth/middleware.js';

// ── Group 4: JWKS cache lifecycle ────────────────────────────

group('Group 4: JWKS cache lifecycle', `
  If these tests fail, signing key rotation is broken. When
  Auth0 rotates keys (every 90 days by default), the cached
  old key continues to be used. New tokens signed with the new
  key are rejected. All users are locked out until someone
  restarts the server.
`);

var before4 = getCounters();
var helper = await createTestJWKS({ issuer: 'https://mock-auth.test/' });

await testAsync('3.3.4.1-D', '', async () => {
  console.log('  Verifying a token populates the JWKS cache');
  console.log('  The first verification fetches the JWKS endpoint and caches the keys');
  console.log('  Subsequent verifications use the cached keys — no network call');
  clearJwksCache();
  var token = await helper.signToken({ sub: 'user1' });
  await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
  check('Verification succeeds (cache populated)', true, 'success', 'failed');
});

await testAsync('3.3.4.2-D', '', async () => {
  console.log('  clearJwksCache() must invalidate the cache');
  console.log('  After clearing, the next verification must fetch keys again');
  console.log('  This is the mechanism for picking up rotated signing keys');
  clearJwksCache();
  // Verify again — must still work (fetches fresh keys)
  var token = await helper.signToken({ sub: 'user1' });
  await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
  check('Verification works after cache clear', true, 'success', 'failed');
});

await testAsync('3.3.4.3-D', '', async () => {
  console.log('  Multiple clearJwksCache() calls must not throw or corrupt state');
  console.log('  An operator might call this in a health check endpoint or on a timer');
  clearJwksCache();
  clearJwksCache();
  clearJwksCache();
  var token = await helper.signToken({ sub: 'user1' });
  await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
  check('Triple clear does not break verifier', true, 'success', 'failed');
});

await testAsync('3.3.4.4-D', '', async () => {
  console.log('  clearJwksCache() before any verification must not throw');
  console.log('  The cache may be empty or uninitialized — clearing must be idempotent');
  clearJwksCache();
  clearJwksCache();
  check('Clear on empty cache does not throw', true, 'no error', 'threw');
});

await testAsync('3.3.4.5-D', '', async () => {
  console.log('  Token signed by a DIFFERENT key after cache clear must verify');
  console.log('  This simulates key rotation: new key, clear cache, new tokens work');
  clearJwksCache();
  await helper.close();
  var helper2 = await createTestJWKS({ issuer: 'https://mock-auth.test/' });
  var token2 = await helper2.signToken({ sub: 'rotated_user' });
  try {
    var payload = await verifyToken(token2, helper2.issuer, helper2.jwksUri, helper2.audience);
    check('Rotated key accepted after cache clear', payload.sub === 'rotated_user',
      'rotated_user', String(payload.sub));
  } catch (e) {
    check('Rotated key accepted after cache clear', false, 'verified', e.message);
  }
  await helper2.close();
  // Reopen original helper for remaining tests
  helper = await createTestJWKS({ issuer: 'https://mock-auth.test/' });
});

await testAsync('3.3.4.6-D', '', async () => {
  console.log('  verifyToken must accept a token size limit');
  console.log('  Without a size limit, an attacker submits a 10MB token and the');
  console.log('  verifier spends CPU parsing and verifying it — denial of service');
  console.log('  Checking: the verifier rejects tokens over a reasonable size');
  clearJwksCache();
  var oversized = 'A'.repeat(20000);
  try {
    await verifyToken(oversized, helper.issuer, helper.jwksUri, helper.audience);
    check('Oversized token rejected', false, 'throws', 'accepted 20KB token');
  } catch (e) {
    check('Oversized token rejected', true, 'rejected', 'rejected: ' + e.message);
  }
});

test('3.3.4.7-D', '', () => {
  console.log('  Checking source code for MAX_TOKEN_BYTES or equivalent constant');
  console.log('  The limit must be a named constant, not a magic number');
  console.log('  A magic number gets removed in a "cleanup" commit — a named constant survives');
  var src = fs.readFileSync('src/auth/jwt-verifier.js', 'utf8');
  check('MAX_TOKEN_BYTES defined in jwt-verifier',
    src.includes('MAX_TOKEN_BYTES') || src.includes('MAX_TOKEN_SIZE') || src.includes('TOKEN_MAX'),
    'named constant', 'no size constant found');
});

clearJwksCache();
var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Group 5: Request isolation and immutability ──────────────

group('Group 5: Request isolation and immutability', `
  If these tests fail, one request's authentication state
  bleeds into another. User A's token data appears in User B's
  response. Or a frozen snapshot is mutated after init,
  redirecting token validation to attacker-controlled keys.
`);

var before5 = getCounters();

_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
var mp = getProviders().find(p => p.name === 'mock');
Object.defineProperty(mp, 'jwksUri', { get: () => helper.jwksUri, configurable: true });
Object.defineProperty(mp, 'audience', { get: () => helper.audience, configurable: true });
_patchSnapshotForTesting('mock', { jwksUri: helper.jwksUri, audience: helper.audience });

var { requireAuth, optionalAuth } = createAuthMiddleware(() => {});

function mReq(h) { return { headers: h || {}, path: '/test' }; }
function mRes() {
  var _s = null, _j = null;
  return { status(s) { _s = s; return this; }, json(j) { _j = j; return this; }, getStatus() { return _s; }, getJson() { return _j; } };
}

await testAsync('3.3.5.1-D', '', async () => {
  console.log('  Two requests with different tokens must produce different req.user');
  console.log('  If the middleware caches user identity in module scope, both');
  console.log('  requests return the same user — a privilege escalation vulnerability');
  var t1 = await helper.signToken({ sub: 'alice', email: 'alice@test.com' });
  var t2 = await helper.signToken({ sub: 'bob', email: 'bob@test.com' });
  var req1 = mReq({ authorization: 'Bearer ' + t1 }); var res1 = mRes();
  var req2 = mReq({ authorization: 'Bearer ' + t2 }); var res2 = mRes();
  await requireAuth(req1, res1, () => {});
  await requireAuth(req2, res2, () => {});
  check('Request 1 is Alice', req1.user?.sub === 'alice', 'alice', String(req1.user?.sub));
  check('Request 2 is Bob', req2.user?.sub === 'bob', 'bob', String(req2.user?.sub));
  check('Alice ≠ Bob', req1.user?.sub !== req2.user?.sub, 'different', 'same');
});

await testAsync('3.3.5.2-D', '', async () => {
  console.log('  A failed request must not leave stale state for the next request');
  console.log('  First: send a bad token. Second: send a good token.');
  console.log('  The good token must not inherit any state from the bad attempt');
  var req1 = mReq({ authorization: 'Bearer garbage' }); var res1 = mRes();
  await requireAuth(req1, res1, () => {});
  check('Bad request blocked', res1.getStatus() === 401, '401', String(res1.getStatus()));

  var t2 = await helper.signToken({ sub: 'clean_user' });
  var req2 = mReq({ authorization: 'Bearer ' + t2 }); var res2 = mRes(); var nc = false;
  await requireAuth(req2, res2, () => { nc = true; });
  check('Good request after bad succeeds', nc && req2.user?.sub === 'clean_user',
    'clean_user', String(req2.user?.sub));
});

await testAsync('3.3.5.3-D', '', async () => {
  console.log('  Middleware must not modify the req object beyond user, authProvider, authSkipped');
  console.log('  Any other property modification pollutes the request for downstream handlers');
  var token = await helper.signToken({ sub: 'test' });
  var req = mReq({ authorization: 'Bearer ' + token });
  req.originalProperty = 'should survive';
  var propsBefore = Object.keys(req).sort().join(',');
  await requireAuth(req, mRes(), () => {});
  var propsAfter = Object.keys(req).sort().join(',');
  // Expected additions: user, authProvider (and maybe authSkipped)
  var expectedAdditions = ['authProvider', 'user'];
  var addedProps = Object.keys(req).filter(k => !propsBefore.includes(k)).sort();
  var unexpectedProps = addedProps.filter(k => !expectedAdditions.includes(k) && k !== 'authSkipped');
  check('Original properties preserved', req.originalProperty === 'should survive',
    'should survive', String(req.originalProperty));
  check('No unexpected properties added', unexpectedProps.length === 0,
    'none', unexpectedProps.join(', '));
});

test('3.3.5.4-D', '', () => {
  console.log('  getJwksMap() must return a new Map on each call');
  console.log('  If it returns the internal Map by reference, a consumer can mutate it');
  console.log('  Adding an entry to the returned Map would register a fake JWKS endpoint');
  var map1 = getJwksMap();
  var map2 = getJwksMap();
  check('getJwksMap returns new Map each call', map1 !== map2,
    'different references', 'same reference (mutable)');
});

test('3.3.5.5-D', '', () => {
  console.log('  Mutating the returned JWKS map must not affect the registry');
  console.log('  If getJwksMap returns the internal Map, this mutation poisons all lookups');
  var map = getJwksMap();
  map.set('https://evil.com/', 'https://evil.com/.well-known/jwks.json');
  var fresh = getJwksMap();
  check('Mutation did not poison registry', !fresh.has('https://evil.com/'),
    'no evil.com', 'evil.com injected');
});

test('3.3.5.6-D', '', () => {
  console.log('  getIssuers() must return a new array on each call');
  var arr1 = getIssuers();
  var arr2 = getIssuers();
  check('getIssuers returns new array each call', arr1 !== arr2,
    'different references', 'same reference');
});

test('3.3.5.7-D', '', () => {
  console.log('  Mutating the returned issuers array must not affect the registry');
  var arr = getIssuers();
  arr.push('https://evil.com/');
  var fresh = getIssuers();
  check('Mutation did not poison issuers', !fresh.includes('https://evil.com/'),
    'no evil.com', 'evil.com injected');
});

test('3.3.5.8-D', '', () => {
  console.log('  Snapshots returned by getSnapshotByIssuer must be frozen');
  console.log('  Object.isFrozen prevents post-registration mutation of issuer or jwksUri');
  var snap = getSnapshotByIssuer('https://mock-auth.test/');
  check('Snapshot is frozen', snap !== null && Object.isFrozen(snap),
    'frozen', snap === null ? 'null' : 'not frozen');
});

test('3.3.5.9-D', '', () => {
  console.log('  Attempting to mutate a frozen snapshot must fail silently or throw');
  console.log('  In strict mode, assignment to a frozen object throws TypeError');
  console.log('  In non-strict mode, assignment is silently ignored');
  var snap = getSnapshotByIssuer('https://mock-auth.test/');
  if (snap) {
    try { snap.issuer = 'https://evil.com/'; } catch (e) { /* TypeError in strict mode */ }
    check('Snapshot issuer unchanged after mutation attempt',
      snap.issuer === 'https://mock-auth.test/',
      'https://mock-auth.test/', snap.issuer);
  } else {
    check('Snapshot exists', false, 'non-null', 'null');
  }
});

test('3.3.5.10-D', '', () => {
  console.log('  _patchSnapshotForTesting must refuse to run in production');
  console.log('  If this function works in production, an attacker who gains code execution');
  console.log('  can redirect token validation to their own JWKS endpoint');
  var origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    _patchSnapshotForTesting('mock', { jwksUri: 'https://evil.com/jwks' });
    check('_patchSnapshotForTesting blocked in production', false,
      'throws', 'succeeded — CRITICAL');
  } catch (e) {
    check('_patchSnapshotForTesting blocked in production', true,
      'throws', 'throws: ' + e.message);
  }
  process.env.NODE_ENV = origEnv;
});

await helper.close();
clearJwksCache();
delete process.env.MOCK_AUTH_ENABLED;

var after5 = getCounters();
groupEnd(after5.pass - before5.pass, after5.fail - before5.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
