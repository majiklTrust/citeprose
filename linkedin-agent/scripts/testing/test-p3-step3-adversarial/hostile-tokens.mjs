// ═══════════════════════════════════════════════════════════════
// Step 3 Adversarial Groups 1, 2, 3: Hostile Tokens
// Algorithm confusion + JWT header injection + token manipulation
// ═══════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { createTestJWKS } from '../../../src/auth/_test-helper.js';
import { verifyToken, clearJwksCache } from '../../../src/auth/jwt-verifier.js';

var helper = await createTestJWKS();
var pl = Buffer.from(JSON.stringify({
  sub: 'attacker', iss: helper.issuer, aud: helper.audience,
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600
})).toString('base64url');

async function expectReject(label, token) {
  try {
    await verifyToken(token, helper.issuer, helper.jwksUri, helper.audience);
    check(label, false, 'rejected', 'TOKEN ACCEPTED — CRITICAL VULNERABILITY');
  } catch (e) { check(label + ' → ' + e.message, true, 'rejected', 'rejected'); }
}

// ── Group 1: Algorithm confusion ─────────────────────────────

group('Group 1: Algorithm confusion', `
  The #1 JWT attack in the wild. If alg:none or alg:HS256 tokens
  are accepted, ANY person can forge a valid-looking token without
  the signing key. Complete authentication bypass.
`);

var before1 = getCounters();

await testAsync('3.3.1.1-A', '', async () => {
  console.log('  JWT with alg:none and empty signature');
  console.log('  alg:none = "no signature required" — token is self-asserted');
  var h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  await expectReject('alg:none empty sig', h + '.' + pl + '.');
});

await testAsync('3.3.1.2-A', '', async () => {
  console.log('  alg:none with signature segment omitted entirely');
  var h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  await expectReject('alg:none no sig segment', h + '.' + pl);
});

await testAsync('3.3.1.3-A', '', async () => {
  console.log('  alg:none with legitimate kid — contradictory state');
  var h = Buffer.from(JSON.stringify({ alg: 'none', kid: helper.kid })).toString('base64url');
  await expectReject('alg:none with legit kid', h + '.' + pl + '.');
});

await testAsync('3.3.1.4-A', '', async () => {
  console.log('  alg:HS256 with arbitrary HMAC secret');
  console.log('  If verifier uses RSA public key as HMAC secret, attacker forges tokens');
  var h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  var sig = crypto.createHmac('sha256', 'any-secret').update(h + '.' + pl).digest('base64url');
  await expectReject('alg:HS256 arbitrary secret', h + '.' + pl + '.' + sig);
});

await testAsync('3.3.1.5-A', '', async () => {
  var h = Buffer.from(JSON.stringify({ alg: 'HS384' })).toString('base64url');
  var sig = crypto.createHmac('sha384', 'secret').update(h + '.' + pl).digest('base64url');
  await expectReject('alg:HS384 rejected', h + '.' + pl + '.' + sig);
});

await testAsync('3.3.1.6-A', '', async () => {
  var h = Buffer.from(JSON.stringify({ alg: 'HS512' })).toString('base64url');
  var sig = crypto.createHmac('sha512', 'secret').update(h + '.' + pl).digest('base64url');
  await expectReject('alg:HS512 rejected', h + '.' + pl + '.' + sig);
});

await testAsync('3.3.1.7-A', '', async () => {
  console.log('  RS384 — valid RSA algorithm but JWKS only has RS256 keys');
  var h = Buffer.from(JSON.stringify({ alg: 'RS384', kid: helper.kid })).toString('base64url');
  await expectReject('alg:RS384 with RS256 key', h + '.' + pl + '.' + crypto.randomBytes(64).toString('base64url'));
});

await testAsync('3.3.1.8-A', '', async () => {
  console.log('  PS256 (RSA-PSS) — different padding scheme than RS256');
  var h = Buffer.from(JSON.stringify({ alg: 'PS256', kid: helper.kid })).toString('base64url');
  await expectReject('alg:PS256 with RS256 key', h + '.' + pl + '.' + crypto.randomBytes(64).toString('base64url'));
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: JWT header injection ────────────────────────────

group('Group 2: JWT header injection (jku/jwk/x5u)', `
  If the verifier follows jku or jwk headers in the token, an
  attacker signs with their own keys and tells the verifier where
  to find them. Complete bypass without touching our JWKS.
`);

var before2 = getCounters();
var attacker = await generateKeyPair('RS256');
var attackerJwk = await exportJWK(attacker.publicKey);
attackerJwk.kid = 'attacker-kid'; attackerJwk.use = 'sig'; attackerJwk.alg = 'RS256';
var now = Math.floor(Date.now() / 1000);

await testAsync('3.3.2.1-A', '', async () => {
  console.log('  Token with jku pointing to attacker JWKS endpoint');
  var t = await new SignJWT({ sub: 'attacker', iss: helper.issuer, aud: helper.audience })
    .setProtectedHeader({ alg: 'RS256', kid: 'attacker-kid', jku: 'https://evil.com/.well-known/jwks.json' })
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(attacker.privateKey);
  await expectReject('jku header injection', t);
});

await testAsync('3.3.2.2-A', '', async () => {
  console.log('  Token with embedded attacker public key in jwk header');
  var t = await new SignJWT({ sub: 'attacker', iss: helper.issuer, aud: helper.audience })
    .setProtectedHeader({ alg: 'RS256', kid: 'attacker-kid', jwk: attackerJwk })
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(attacker.privateKey);
  await expectReject('jwk header injection', t);
});

await testAsync('3.3.2.3-A', '', async () => {
  console.log('  Token with x5u pointing to attacker certificate URL');
  var t = await new SignJWT({ sub: 'attacker', iss: helper.issuer, aud: helper.audience })
    .setProtectedHeader({ alg: 'RS256', kid: 'attacker-kid', x5u: 'https://evil.com/cert.pem' })
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(attacker.privateKey);
  await expectReject('x5u header injection', t);
});

await testAsync('3.3.2.4-A', '', async () => {
  console.log('  Spoofed kid — attacker key but using our legitimate kid');
  var t = await new SignJWT({ sub: 'attacker', iss: helper.issuer, aud: helper.audience })
    .setProtectedHeader({ alg: 'RS256', kid: helper.kid })
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(attacker.privateKey);
  await expectReject('Spoofed kid', t);
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Group 3: Token manipulation ──────────────────────────────

group('Group 3: Token manipulation', `
  If tampered tokens pass verification, an attacker modifies
  their valid token to escalate privileges, change identity,
  or extend expiration indefinitely.
`);

var before3 = getCounters();

await testAsync('3.3.3.1-A', '', async () => {
  console.log('  Signing valid token, then changing sub to "attacker"');
  var valid = await helper.signToken({ sub: 'legit_user' });
  var parts = valid.split('.');
  var payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  payload.sub = 'attacker';
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  await expectReject('Tampered payload', parts.join('.'));
});

await testAsync('3.3.3.2-A', '', async () => {
  console.log('  Token with multiple audiences');
  var multiAud = await helper.signToken({}, { audience: ['https://linkedin-agent-api', 'https://other-api'] });
  try {
    await verifyToken(multiAud, helper.issuer, helper.jwksUri, helper.audience);
    console.log('  ℹ Multiple audiences accepted (array contains valid value)');
    check('Multiple aud documented', true, 'documented', 'documented');
  } catch (e) { check('Multiple aud rejected: ' + e.message, true, 'documented', 'documented'); }
});

await testAsync('3.3.3.3-A', '', async () => {
  console.log('  1MB token — oversized payload as DoS vector');
  try {
    var huge = await helper.signToken({ sub: 'a', data: 'x'.repeat(1000000) });
    await expectReject('1MB token', huge);
  } catch (e) { check('1MB token errored: ' + e.message?.substring(0, 40), true, 'rejected', 'rejected'); }
});

await testAsync('3.3.3.4-A', '', async () => {
  console.log('  Empty JSON header and payload');
  var h = Buffer.from('{}').toString('base64url');
  var p = Buffer.from('{}').toString('base64url');
  await expectReject('Empty JSON', h + '.' + p + '.' + crypto.randomBytes(32).toString('base64url'));
});

await testAsync('3.3.3.5-A', '', async () => {
  console.log('  Token with kid removed from header');
  var valid = await helper.signToken({ sub: 'test' });
  var parts = valid.split('.');
  var hdr = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  delete hdr.kid; parts[0] = Buffer.from(JSON.stringify(hdr)).toString('base64url');
  await expectReject('kid removed', parts.join('.'));
});

await testAsync('3.3.3.6-A', '', async () => {
  await expectReject('Null bytes', 'eyJ\x00.eyJ\x00.sig');
});

await testAsync('3.3.3.7-A', '', async () => {
  await expectReject('Four segments', 'a.b.c.d');
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Cleanup & Exit ───────────────────────────────────────────
await helper.close(); clearJwksCache();
var summary = getCounters();
process.exit(summary.fail);
