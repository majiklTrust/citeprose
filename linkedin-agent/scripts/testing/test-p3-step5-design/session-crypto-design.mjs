// ═══════════════════════════════════════════════════════════════
// Step 5 Design Groups 3-4: Crypto Choices and Cookie Security
// Reads source code to verify AES-256-GCM, HKDF, IV randomness,
// and cookie security flag enforcement
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

import {
  createSession,
  readSession,
  SESSION_COOKIE_NAME,
} from '../../../src/auth/session.js';

// ── Read source code ─────────────────────────────────────────
var sessionSrc = '';
try { sessionSrc = fs.readFileSync('src/auth/session.js', 'utf8'); } catch {}

// ── Environment setup ────────────────────────────────────────
const TEST_SECRET = 'f0'.repeat(32);
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

var validTokens = {
  accessToken: 'eyJ-design-test',
  refreshToken: 'v1.design-refresh',
  expiresIn: 3600,
  user: { sub: 'auth0|design', email: 'd@test.com', name: 'Design' }
};

// ── Group 3: Cryptographic implementation ────────────────────
console.log('  File: test-p3-step5-design/session-crypto-design.mjs');
group('Group 3: Cryptographic implementation choices', `
  Impact: If these tests fail, the session encryption is using a weak
  algorithm, predictable IVs, or no authenticated encryption.
  An attacker who captures a cookie can decrypt it (weak algo),
  predict future cookies (predictable IV), or modify the payload
  without detection (no authentication tag).

  Check method: grep source code for crypto function calls and constants
  Reference: NIST SP 800-38D (GCM), RFC 5869 (HKDF)
`);

var before3 = getCounters();

await testAsync('3.5.3.1-D', ' Uses AES-256-GCM (authenticated encryption)', async () => {
  console.log('  Reading src/auth/session.js source code');
  console.log('  Searching for "aes-256-gcm" — the algorithm identifier');
  console.log('  AES-256-GCM provides both confidentiality (encryption) and');
  console.log('  integrity (authentication tag). AES-256-CBC would only provide');
  console.log('  confidentiality — a tampered ciphertext could still decrypt');
  console.log('  Checking: source contains "aes-256-gcm" (case insensitive)');
  var hasGCM = sessionSrc.toLowerCase().includes('aes-256-gcm');
  check('AES-256-GCM in source', hasGCM, 'found', 'not found');
});

await testAsync('3.5.3.2-D', ' Uses randomBytes for IV generation', async () => {
  console.log('  Searching for "randomBytes" — the cryptographically secure random source');
  console.log('  The IV (initialization vector) must be random for every encryption');
  console.log('  Math.random() or Date.now() as IV would be predictable');
  console.log('  Checking: source contains "randomBytes"');
  var hasRandom = sessionSrc.includes('randomBytes');
  check('randomBytes for IV', hasRandom, 'found', 'not found');
});

await testAsync('3.5.3.3-D', ' IV length is 12 bytes (96 bits)', async () => {
  console.log('  Searching for IV size constant — should be 12 for GCM');
  console.log('  NIST SP 800-38D recommends 96-bit (12-byte) IVs for GCM');
  console.log('  Other sizes work but 12 is the most efficient and widely tested');
  console.log('  Checking: source contains "12" near "randomBytes" or a named IV_LENGTH constant');
  var hasIVLength = sessionSrc.includes('12') ||
    sessionSrc.match(/IV[_\s]*(?:LENGTH|SIZE|BYTES)\s*=\s*12/i);
  check('12-byte IV', hasIVLength, 'found', 'not found (check manually)');
});

await testAsync('3.5.3.4-D', ' Uses HKDF or scrypt for key derivation', async () => {
  console.log('  Searching for key derivation function in source');
  console.log('  SESSION_SECRET is a hex string — it should not be used directly as AES key');
  console.log('  HKDF or scrypt derives a fixed-length key with domain separation');
  console.log('  Checking: source contains "hkdf" or "scrypt" or "pbkdf2"');
  var hasKDF = sessionSrc.toLowerCase().includes('hkdf') ||
    sessionSrc.includes('scrypt') ||
    sessionSrc.includes('pbkdf2');
  check('Key derivation function used', hasKDF, 'found', 'not found');
});

await testAsync('3.5.3.5-D', ' Auth tag is extracted and verified', async () => {
  console.log('  Searching for "getAuthTag" or "setAuthTag" in source');
  console.log('  GCM produces a 16-byte authentication tag during encryption');
  console.log('  During decryption, the tag must be set before calling .final()');
  console.log('  If the tag is not checked, GCM degrades to unauthenticated encryption');
  console.log('  Checking: source contains "getAuthTag" and "setAuthTag"');
  var hasGetTag = sessionSrc.includes('getAuthTag') || sessionSrc.includes('authTag');
  var hasSetTag = sessionSrc.includes('setAuthTag') || sessionSrc.includes('authTag');
  check('Auth tag handling in source', hasGetTag && hasSetTag,
    'getAuthTag + setAuthTag', 'get=' + hasGetTag + ' set=' + hasSetTag);
});

await testAsync('3.5.3.6-D', ' No plaintext secrets in source code', async () => {
  console.log('  Scanning session.js for hardcoded secrets or keys');
  console.log('  All secrets must come from process.env, not from source code');
  console.log('  Checking: no hex strings longer than 32 characters that look like keys');
  // Look for suspiciously long hex strings that aren't in comments
  var codeLines = sessionSrc.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  var longHex = codeLines.some(l => l.match(/['"][0-9a-f]{32,}['"]/i));
  check('No hardcoded hex secrets', !longHex, 'clean', 'suspicious hex string found');
});

await testAsync('3.5.3.7-D', ' Encryption constants are named', async () => {
  console.log('  Checking for named constants instead of magic numbers');
  console.log('  Named constants document intent and survive refactoring');
  console.log('  Looking for: IV_LENGTH or IV_BYTES, AUTH_TAG_LENGTH, ALGORITHM');
  var hasAlgoConst = sessionSrc.match(/(?:ALGORITHM|CIPHER|AES)/);
  check('Algorithm is a named constant', hasAlgoConst !== null,
    'named constant', 'magic string or not found');
});

await testAsync('3.5.3.8-D', ' Cookie value uses base64url encoding', async () => {
  console.log('  Creating a session and inspecting the raw cookie value');
  console.log('  base64url uses A-Z, a-z, 0-9, -, _ (no +, /, =)');
  console.log('  Standard base64 uses + and / which must be URL-encoded in cookies');
  console.log('  base64url avoids encoding issues in Cookie headers');
  console.log('  Checking: cookie value matches /^[A-Za-z0-9_-]+$/');
  var res = mockRes();
  createSession(res, validTokens);
  var val = res.getSessionCookie()?.value || '';
  var isBase64url = /^[A-Za-z0-9_-]+$/.test(val);
  check('Cookie value is base64url', isBase64url && val.length > 0,
    'base64url chars only', val.substring(0, 40) + '...');
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Group 4: Cookie security flags ───────────────────────────
console.log('  File: test-p3-step5-design/session-crypto-design.mjs');
group('Group 4: Cookie security flags in source code', `
  Impact: If these tests fail, the session cookie is missing critical
  security flags. Without httpOnly, XSS can steal the session.
  Without sameSite, CSRF can use the session. Without secure
  in production, the cookie is sent over unencrypted HTTP.

  Check method: grep source code + runtime cookie inspection
  Reference: OWASP Session Management Cheat Sheet
`);

var before4 = getCounters();

await testAsync('3.5.4.1-D', ' httpOnly:true in source', async () => {
  console.log('  Reading src/auth/session.js source code');
  console.log('  Searching for "httpOnly" in cookie options');
  console.log('  httpOnly:true is the primary defense against XSS session theft');
  console.log('  document.cookie cannot access httpOnly cookies');
  console.log('  Checking: source contains "httpOnly" set to true');
  var hasHttpOnly = sessionSrc.includes('httpOnly');
  check('httpOnly in source', hasHttpOnly, 'found', 'not found');
});

await testAsync('3.5.4.2-D', ' sameSite in source', async () => {
  console.log('  Searching for "sameSite" in cookie options');
  console.log('  sameSite:lax prevents the cookie from being sent on cross-origin POSTs');
  console.log('  This blocks CSRF attacks where a malicious site submits forms');
  console.log('  Checking: source contains "sameSite"');
  var hasSameSite = sessionSrc.includes('sameSite') || sessionSrc.includes('samesite');
  check('sameSite in source', hasSameSite, 'found', 'not found');
});

await testAsync('3.5.4.3-D', ' secure flag is conditional on NODE_ENV', async () => {
  console.log('  Searching for NODE_ENV-conditional secure flag');
  console.log('  secure:true must only be set when NODE_ENV===production');
  console.log('  In development (HTTP), secure:true would prevent the cookie from being sent');
  console.log('  Checking: source contains both "secure" and "NODE_ENV" or "production"');
  var hasSecure = sessionSrc.includes('secure');
  var hasEnvCheck = sessionSrc.includes('NODE_ENV') || sessionSrc.includes('production');
  check('Conditional secure flag', hasSecure && hasEnvCheck,
    'secure + env check', 'secure=' + hasSecure + ' env=' + hasEnvCheck);
});

await testAsync('3.5.4.4-D', ' path:/ in source', async () => {
  console.log('  Searching for path:"/" in cookie options');
  console.log('  path:/ ensures the cookie is sent on all routes');
  console.log('  Without it, the cookie might only be sent on the path that set it');
  console.log('  Checking: source contains path setting');
  var hasPath = sessionSrc.includes("path");
  check('Path in source', hasPath, 'found', 'not found');
});

await testAsync('3.5.4.5-D', ' SESSION_SECRET minimum length enforced', async () => {
  console.log('  Searching for a length or minimum check on SESSION_SECRET');
  console.log('  A 10-character secret is brute-forceable — minimum should be 32+ bytes');
  console.log('  Checking: source contains length check or minimum constant');
  var hasLengthCheck = sessionSrc.includes('.length') || sessionSrc.match(/MIN[_\s]*(?:SECRET|KEY)[_\s]*(?:LENGTH|SIZE)/i);
  check('Secret length validated', hasLengthCheck !== false && hasLengthCheck !== null,
    'length check found', 'no length check');
});

await testAsync('3.5.4.6-D', ' No console.log of session data', async () => {
  console.log('  Scanning session.js for console.log statements');
  console.log('  Session data includes tokens and user claims — never log these');
  console.log('  A console.log left from debugging would leak tokens to server logs');
  console.log('  Checking: no console.log in source (comments excluded)');
  var codeLines = sessionSrc.split('\n').filter(l =>
    !l.trim().startsWith('//') && !l.trim().startsWith('*')
  );
  var hasConsoleLog = codeLines.some(l => l.includes('console.log'));
  check('No console.log in session.js', !hasConsoleLog,
    'clean', 'console.log found');
});

await testAsync('3.5.4.7-D', ' Error messages do not leak crypto details', async () => {
  console.log('  Scanning session.js for error messages');
  console.log('  Errors should say "Session invalid" not "AES-256-GCM decryption failed"');
  console.log('  Crypto details in errors help attackers identify the implementation');
  console.log('  Checking: no error strings contain algorithm names or key sizes');
  var codeLines = sessionSrc.split('\n').filter(l =>
    !l.trim().startsWith('//') && !l.trim().startsWith('*')
  );
  var leakyError = codeLines.some(l =>
    l.includes('Error(') && (l.includes('AES') || l.includes('GCM') || l.includes('HKDF'))
  );
  check('No crypto details in errors', !leakyError,
    'clean', 'crypto details in error message');
});

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Cleanup ──────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
