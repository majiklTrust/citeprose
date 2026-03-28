// ═══════════════════════════════════════════════════════════════
// Step 3 Groups 1, 2: JWT Verifier
// Valid token acceptance + invalid token rejection
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, testAsync, check, expectError, getCounters } from '../lib/test-harness.mjs';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { verifyToken, clearJwksCache } from '../../../src/auth/jwt-verifier.js';

var helper = await createTestJWKS();

// ── Group 1: JWT verifier — valid tokens ─────────────────────

console.log('  File: test-p3-step3/jwt-verifier.mjs');
group('Group 1: JWT verifier — valid tokens', `
  If these tests fail, no user can authenticate. Every API
  request is rejected even with a valid login. The entire
  platform is inaccessible.
`);

var before1 = getCounters();

await testAsync('3.3.1.1', ' Valid token accepted', async () => {
  console.log('  Signing JWT with sub=user_001, email=user@test.com, name=Test User');
  console.log('  Using local RSA key pair — simulates what Auth0 does in production');
  var token = await helper.signToken({ sub: 'user_001', email: 'user@test.com', name: 'Test User' });
  console.log('  Token generated (' + token.length + ' chars). Calling verifyToken()...');
  var payload = await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
  check('Valid token accepted', !!payload, 'decoded payload', 'null/undefined');
});

await testAsync('3.3.1.2', ' Payload contains sub', async () => {
  var token = await helper.signToken({ sub: 'user_001', email: 'user@test.com', name: 'Test User' });
  var payload = await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
  check('Payload contains sub', payload.sub === 'user_001', 'user_001', String(payload.sub));
  check('Payload contains email', payload.email === 'user@test.com', 'user@test.com', String(payload.email));
  check('Payload contains name', payload.name === 'Test User', 'Test User', String(payload.name));
  check('Payload has correct issuer', payload.iss === helper.issuer, helper.issuer, String(payload.iss));
  check('Payload has correct audience', payload.aud === helper.audience, helper.audience, String(payload.aud));
  check('Payload has expiration', typeof payload.exp === 'number', 'number', typeof payload.exp);
  check('Payload has issued-at', typeof payload.iat === 'number', 'number', typeof payload.iat);
});

await testAsync('3.3.1.9', ' Token with custom claims: role=admin, orgId=org_123', async () => {
  console.log('  Token with custom claims: role=admin, orgId=org_123');
  var token = await helper.signToken({ sub: 'admin', role: 'admin', orgId: 'org_123' });
  var payload = await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
  check('Custom claim preserved (role)', payload.role === 'admin', 'admin', String(payload.role));
  check('Custom claim preserved (orgId)', payload.orgId === 'org_123', 'org_123', String(payload.orgId));
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: JWT verifier — invalid tokens ───────────────────

console.log('  File: test-p3-step3/jwt-verifier.mjs');
group('Group 2: JWT verifier — invalid tokens rejected', `
  If these tests fail, forged, expired, or tampered tokens are
  accepted. An attacker fabricates credentials and accesses any
  user's data or LinkedIn account.
`);

var before2 = getCounters();

await testAsync('3.3.2.1', ' Null token — simulates missing Authorization header', async () => {
  console.log('  Null token — simulates missing Authorization header');
  await expectError('Null token rejected', () => verifyToken(null, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_MISSING');
});
await testAsync('3.3.2.2', ' "not.a.jwt" — 3 dot-separated parts but not base64url', async () => {
  await expectError('Empty string rejected', () => verifyToken('', helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_MISSING');
});
await testAsync('3.3.2.3', ' "not.a.jwt" — 3 dot-separated parts but not base64url', async () => {
  await expectError('Undefined rejected', () => verifyToken(undefined, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_MISSING');
});
await testAsync('3.3.2.4', ' "not.a.jwt" — 3 dot-separated parts but not base64url', async () => {
  console.log('  "not.a.jwt" — 3 dot-separated parts but not base64url');
  await expectError('Random string rejected', () => verifyToken('not.a.jwt', helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_INVALID');
});
await testAsync('3.3.2.5', ' Expired token — valid signature but exp is in the past', async () => {
  await expectError('Single segment rejected', () => verifyToken('justonepart', helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_INVALID');
});
await testAsync('3.3.2.6', ' Expired token — valid signature but exp is in the past', async () => {
  console.log('  Fabricated signature — correct structure, random bytes for sig');
  var fake = helper.fabricateToken();
  await expectError('Fabricated sig rejected', () => verifyToken(fake, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_SIGNATURE_INVALID');
});
await testAsync('3.3.2.7', ' Expired token — valid signature but exp is in the past', async () => {
  console.log('  Expired token — valid signature but exp is in the past');
  var expired = await helper.signExpiredToken();
  await expectError('Expired token rejected', () => verifyToken(expired, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_EXPIRED');
});
await testAsync('3.3.2.8', ' Wrong issuer — token from a different Auth0 tenant', async () => {
  console.log('  Wrong issuer — token from a different Auth0 tenant');
  var wrongIss = await helper.signWrongIssuerToken();
  await expectError('Wrong issuer rejected', () => verifyToken(wrongIss, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_INVALID_ISSUER');
});
await testAsync('3.3.2.9', ' Wrong audience — token for a different API', async () => {
  console.log('  Wrong audience — token for a different API');
  var wrongAud = await helper.signWrongAudienceToken();
  await expectError('Wrong audience rejected', () => verifyToken(wrongAud, helper.issuer, helper.jwksUri, helper.audience), 'TOKEN_INVALID_AUDIENCE');
});
await testAsync('3.3.2.10', ' Null issuer config rejected', async () => {
  var vt = await helper.signToken();
  await expectError('Null issuer config rejected', () => verifyToken(vt, null, helper.jwksUri, helper.audience), 'VERIFIER_MISCONFIGURED');
});
await testAsync('3.3.2.11', ' Null JWKS URI rejected', async () => {
  var vt = await helper.signToken();
  await expectError('Null JWKS URI rejected', () => verifyToken(vt, helper.issuer, null, helper.audience), 'VERIFIER_MISCONFIGURED');
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Cleanup & Exit ───────────────────────────────────────────
await helper.close();
clearJwksCache();
var summary = getCounters();
process.exit(summary.fail);
