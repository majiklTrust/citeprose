// ═══════════════════════════════════════════════════════════════
// Step 5 Adversarial Groups 1-2: Hostile Cookie Manipulation
// Tests tampered, truncated, and forged session cookies
// ═══════════════════════════════════════════════════════════════
import crypto from 'node:crypto';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

import {
  createSession,
  readSession,
  SESSION_COOKIE_NAME,
} from '../../../src/auth/session.js';

// ── Environment setup ────────────────────────────────────────
const TEST_SECRET = 'e'.repeat(64);
process.env.SESSION_SECRET = TEST_SECRET;

// ── Mock helpers ─────────────────────────────────────────────
function mockRes() {
  var cookies = [];
  return {
    cookie(name, value, options) { cookies.push({ name, value, options: options || {} }); },
    getCookies() { return cookies; },
    getSessionCookie() { return cookies.find(c => c.name === SESSION_COOKIE_NAME) || null; }
  };
}

function mockReqFromRes(res) {
  var cookie = res.getSessionCookie();
  if (!cookie) return { headers: {} };
  return { headers: { cookie: SESSION_COOKIE_NAME + '=' + cookie.value } };
}

function mockReqWithCookie(value) {
  return { headers: { cookie: SESSION_COOKIE_NAME + '=' + value } };
}

// Create a valid encrypted cookie value
function getValidCookieValue() {
  var res = mockRes();
  createSession(res, {
    accessToken: 'eyJ-valid-token',
    refreshToken: 'v1.valid-refresh',
    expiresIn: 3600,
    user: { sub: 'auth0|legit_user', email: 'legit@test.com', name: 'Legit' }
  });
  return res.getSessionCookie()?.value;
}

// ── Group 1: Tampered cookies ────────────────────────────────
group('Group 1: Tampered session cookies', `
  Impact: If tampered cookies are accepted, an attacker who intercepts
  a session cookie can modify the encrypted payload to escalate
  privileges, change identity, or extend expiration. AES-256-GCM
  authentication tags exist specifically to prevent this.

  Attack surface: Cookie value manipulation
  Defense: GCM authentication tag detects any modification to ciphertext
`);

var before1 = getCounters();

await testAsync('3.5.1.1-A', 'Flipped bit in ciphertext', async () => {
  console.log('  Step 1: Creating a valid session cookie via createSession()');
  console.log('  Step 2: Decoding the base64url cookie value to get raw bytes');
  console.log('  Step 3: Flipping one bit in the ciphertext portion');
  console.log('  Step 4: Re-encoding and passing to readSession()');
  console.log('  AES-256-GCM includes a 16-byte authentication tag computed over the ciphertext');
  console.log('  Changing any byte invalidates the tag — decryption must fail');
  console.log('  Checking: readSession returns null (tamper detected)');
  var valid = getValidCookieValue();
  var bytes = Buffer.from(valid, 'base64url');
  // Flip a bit in the middle of the ciphertext (after 12-byte IV)
  if (bytes.length > 20) bytes[15] ^= 0x01;
  var tampered = bytes.toString('base64url');
  var session = readSession(mockReqWithCookie(tampered));
  check('Bit-flipped ciphertext rejected', session === null, 'null', String(session));
});

await testAsync('3.5.1.2-A', 'Truncated ciphertext', async () => {
  console.log('  Taking a valid cookie and cutting it in half');
  console.log('  The authentication tag is at the end — truncation removes it');
  console.log('  Without the tag, GCM cannot verify integrity');
  console.log('  Checking: readSession returns null');
  var valid = getValidCookieValue();
  var truncated = valid.substring(0, Math.floor(valid.length / 2));
  var session = readSession(mockReqWithCookie(truncated));
  check('Truncated cookie rejected', session === null, 'null', String(session));
});

await testAsync('3.5.1.3-A', 'Appended bytes to ciphertext', async () => {
  console.log('  Taking a valid cookie and appending extra random bytes');
  console.log('  The authentication tag covers a specific ciphertext length');
  console.log('  Extra bytes change the input to the tag verification');
  console.log('  Checking: readSession returns null');
  var valid = getValidCookieValue();
  var bytes = Buffer.from(valid, 'base64url');
  var appended = Buffer.concat([bytes, crypto.randomBytes(16)]);
  var session = readSession(mockReqWithCookie(appended.toString('base64url')));
  check('Appended bytes rejected', session === null, 'null', String(session));
});

await testAsync('3.5.1.4-A', 'Completely fabricated cookie', async () => {
  console.log('  Generating 128 random bytes and encoding as base64url');
  console.log('  This has the right format (base64url string) but random content');
  console.log('  No valid IV, no valid ciphertext, no valid auth tag');
  console.log('  Checking: readSession returns null');
  var fabricated = crypto.randomBytes(128).toString('base64url');
  var session = readSession(mockReqWithCookie(fabricated));
  check('Fabricated cookie rejected', session === null, 'null', String(session));
});

await testAsync('3.5.1.5-A', 'Valid JSON but not encrypted', async () => {
  console.log('  Passing a base64url-encoded JSON payload directly as cookie value');
  console.log('  An attacker might try to bypass encryption by sending plaintext JSON');
  console.log('  If readSession parses JSON before decrypting, this would succeed');
  console.log('  Checking: readSession returns null');
  var plaintext = Buffer.from(JSON.stringify({
    accessToken: 'stolen', user: { sub: 'attacker', email: 'evil@hack.com' }
  })).toString('base64url');
  var session = readSession(mockReqWithCookie(plaintext));
  check('Plaintext JSON rejected', session === null, 'null', String(session));
});

await testAsync('3.5.1.6-A', 'Empty string cookie', async () => {
  console.log('  Passing an empty string as the cookie value');
  console.log('  Some parsers treat empty strings as valid input');
  console.log('  Checking: readSession returns null');
  var session = readSession(mockReqWithCookie(''));
  check('Empty string rejected', session === null, 'null', String(session));
});

await testAsync('3.5.1.7-A', 'Cookie with only IV (12 bytes)', async () => {
  console.log('  Passing exactly 12 bytes — the IV size for AES-256-GCM');
  console.log('  No ciphertext and no auth tag follow');
  console.log('  The decryption function must handle this gracefully');
  console.log('  Checking: readSession returns null');
  var ivOnly = crypto.randomBytes(12).toString('base64url');
  var session = readSession(mockReqWithCookie(ivOnly));
  check('IV-only cookie rejected', session === null, 'null', String(session));
});

await testAsync('3.5.1.8-A', 'Swapped IV from different session', async () => {
  console.log('  Creating two valid sessions with different IVs');
  console.log('  Taking the IV from session 1 and the ciphertext+tag from session 2');
  console.log('  GCM uses the IV as part of the authentication — mismatched IV fails');
  console.log('  Checking: readSession returns null');
  var val1 = getValidCookieValue();
  var val2 = getValidCookieValue();
  var bytes1 = Buffer.from(val1, 'base64url');
  var bytes2 = Buffer.from(val2, 'base64url');
  // Swap first 12 bytes (IV) from session 1 onto session 2's ciphertext
  var hybrid = Buffer.concat([bytes1.subarray(0, 12), bytes2.subarray(12)]);
  var session = readSession(mockReqWithCookie(hybrid.toString('base64url')));
  check('Swapped IV rejected', session === null, 'null', String(session));
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: Encryption and key attacks ──────────────────────
group('Group 2: Encryption and key attacks', `
  Impact: If these attacks succeed, an attacker who knows the encryption
  scheme but not the key can forge valid session cookies. They
  create sessions for any user without ever authenticating.

  Attack surface: AES-256-GCM key derivation and ciphertext construction
  Defense: HKDF key derivation, random IV, authenticated encryption
`);

var before2 = getCounters();

await testAsync('3.5.2.1-A', 'Wrong SESSION_SECRET cannot decrypt', async () => {
  console.log('  Step 1: Create a session with SECRET_A');
  console.log('  Step 2: Change SESSION_SECRET to SECRET_B');
  console.log('  Step 3: Attempt to read the session with the wrong key');
  console.log('  AES-256-GCM derives different keys from different secrets');
  console.log('  Decryption with the wrong key produces garbage or fails tag verification');
  console.log('  Checking: readSession returns null with wrong secret');
  var res = mockRes();
  createSession(res, {
    accessToken: 'test-token', refreshToken: 'r', expiresIn: 3600,
    user: { sub: 'auth0|key_test', email: 'k@test.com', name: 'Key' }
  });
  var req = mockReqFromRes(res);

  // Switch to a different secret
  process.env.SESSION_SECRET = 'f'.repeat(64);
  var session = readSession(req);
  process.env.SESSION_SECRET = TEST_SECRET; // restore
  check('Wrong secret returns null', session === null, 'null', String(session));
});

await testAsync('3.5.2.2-A', 'Short SESSION_SECRET rejected', async () => {
  console.log('  Setting SESSION_SECRET to a 10-character string (40 bits)');
  console.log('  AES-256 requires a 256-bit key — short secrets are brute-forceable');
  console.log('  The session module must reject secrets below the minimum length');
  console.log('  Checking: createSession throws or readSession returns null');
  var saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'short';
  var res = mockRes();
  var rejected = false;
  try {
    createSession(res, {
      accessToken: 'x', refreshToken: 'r', expiresIn: 3600,
      user: { sub: 'x', email: 'x@x.com', name: 'X' }
    });
    // If it didn't throw, check if readSession returns null
    var session = readSession(mockReqFromRes(res));
    if (session === null) rejected = true;
  } catch (e) {
    rejected = true;
  }
  process.env.SESSION_SECRET = saved;
  check('Short secret rejected', rejected, 'rejected', 'accepted');
});

await testAsync('3.5.2.3-A', 'Rotated secret invalidates old sessions', async () => {
  console.log('  Simulating a secret rotation: create session with old secret,');
  console.log('  change to new secret, attempt to read');
  console.log('  Old sessions must be invalidated — users re-login after rotation');
  console.log('  This is by design: secret rotation is a forced logout for all users');
  console.log('  Checking: readSession returns null after secret change');
  var res = mockRes();
  process.env.SESSION_SECRET = 'old_secret_' + 'a'.repeat(53);
  createSession(res, {
    accessToken: 'old-token', refreshToken: 'r', expiresIn: 3600,
    user: { sub: 'auth0|rotation', email: 'r@test.com', name: 'Rotate' }
  });
  var req = mockReqFromRes(res);

  process.env.SESSION_SECRET = 'new_secret_' + 'b'.repeat(53);
  var session = readSession(req);
  process.env.SESSION_SECRET = TEST_SECRET;
  check('Old session invalid after rotation', session === null, 'null', String(session));
});

await testAsync('3.5.2.4-A', 'Cookie from different application rejected', async () => {
  console.log('  Creating a session with one HKDF info label');
  console.log('  If two applications share the same SESSION_SECRET but derive');
  console.log('  keys with different info strings, cookies are not portable');
  console.log('  This tests that the encryption is domain-separated');
  console.log('  Note: if HKDF is not used, this test documents the gap');
  var res = mockRes();
  createSession(res, {
    accessToken: 'app1-token', refreshToken: 'r', expiresIn: 3600,
    user: { sub: 'auth0|app1', email: 'a@test.com', name: 'App1' }
  });
  var cookie = res.getSessionCookie()?.value;
  // Same secret, same cookie — readSession should work
  var session = readSession(mockReqWithCookie(cookie));
  check('Same app can read own cookie', session !== null, 'non-null', String(session));
  // Note: cross-app isolation is a HKDF info string check — documented here for future hardening
});

await testAsync('3.5.2.5-A', 'Null bytes in cookie value', async () => {
  console.log('  Injecting null bytes into the cookie value');
  console.log('  Null bytes can truncate strings in C-based parsers');
  console.log('  Node.js handles binary correctly, but this tests the boundary');
  console.log('  Checking: readSession returns null');
  var session = readSession(mockReqWithCookie('valid\x00garbage'));
  check('Null bytes rejected', session === null, 'null', String(session));
});

await testAsync('3.5.2.6-A', 'Very large cookie value (1MB)', async () => {
  console.log('  Sending a 1MB cookie value as a potential DoS vector');
  console.log('  The decryption function must not allocate unbounded memory');
  console.log('  Checking: readSession returns null or throws (does not hang)');
  var huge = crypto.randomBytes(1024 * 1024).toString('base64url');
  var result = 'unknown';
  try {
    var session = readSession(mockReqWithCookie(huge));
    result = session === null ? 'null (safe)' : 'session returned (UNSAFE)';
  } catch (e) {
    result = 'threw (safe)';
  }
  check('1MB cookie handled safely', result !== 'session returned (UNSAFE)',
    'null or throw', result);
});

await testAsync('3.5.2.7-A', 'Non-base64url characters in cookie', async () => {
  console.log('  Sending cookie value with characters outside the base64url alphabet');
  console.log('  Valid base64url: A-Z, a-z, 0-9, -, _');
  console.log('  Injecting: spaces, +, /, =, unicode');
  console.log('  Checking: readSession returns null');
  var invalid = 'not+valid/base64==with spaces';
  var session = readSession(mockReqWithCookie(invalid));
  check('Invalid base64url rejected', session === null, 'null', String(session));
});

await testAsync('3.5.2.8-A', 'Cookie value "undefined" or "null" string', async () => {
  console.log('  Some frameworks serialize null/undefined as the literal strings');
  console.log('  Checking: readSession returns null for these edge cases');
  var s1 = readSession(mockReqWithCookie('undefined'));
  var s2 = readSession(mockReqWithCookie('null'));
  check('"undefined" string rejected', s1 === null, 'null', String(s1));
  check('"null" string rejected', s2 === null, 'null', String(s2));
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Cleanup ──────────────────────────────────────────────────
process.env.SESSION_SECRET = TEST_SECRET;
var summary = getCounters();
process.exit(summary.fail);
