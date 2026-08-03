// ═══════════════════════════════════════════════════════════════
// Session Management — Encrypted httpOnly Cookie Sessions
// ═══════════════════════════════════════════════════════════════
//
// Encrypts authenticated user tokens into an httpOnly cookie.
// The browser sends the cookie automatically on every request.
// The middleware decrypts it to restore the session.
//
// Encryption: AES-256-GCM with HKDF-derived key
// Cookie: httpOnly, sameSite=lax, secure in production
//
// This module imports ONLY from Node crypto. It does not know
// about providers, routes, jose, or the database.
// ═══════════════════════════════════════════════════════════════

import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

// ── Injectable logger (keeps this module free of the services layer)
// session.js is a foundational crypto/session module and must import
// only Node built-ins, so it cannot import platformLog directly. The
// orchestration layer (auth/middleware.js) wires the real logger in
// at startup via setSessionLogger(); until then this is a no-op, so
// the module is silent and safe in tests or any unwired context. Only
// non-secret, debug-level session lifecycle events are ever passed.
let sessionLog = () => {};
export function setSessionLogger(fn) {
  sessionLog = typeof fn === 'function' ? fn : (() => {});
}

// ── Constants ────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = '__la_session';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
export const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;

// Default OAuth token lifetime when the provider does not specify
// expiresIn. Auth0 typically returns 86400 (24h); this fallback
// covers providers that omit the field entirely.
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600;

// export const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS, 10) || 86400000; // 24h
// export const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS, 10) || 3600000; // 1h
export const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS, 10) || 300000; // 5m

// Sliding window refresh ratio. The session cookie is re-issued
// when (elapsed time / SESSION_MAX_AGE_MS) exceeds this ratio.
// At 0.75 with a 4-hour TTL, refresh triggers after 3 hours of
// the session's life, guaranteeing 1 hour of idle time after the
// last interaction.
//
// Env: SESSION_MAX_AGE_REFRESH_RATIO (0.0–1.0). Default: 0.75.
const SESSION_MAX_AGE_REFRESH_RATIO = (() => {
  const val = parseFloat(process.env.SESSION_MAX_AGE_REFRESH_RATIO);
  if (isNaN(val) || val < 0 || val > 1) return 0.75;
  return val;
})();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;          // 96 bits — NIST SP 800-38D recommended for GCM
const AUTH_TAG_LENGTH = 16;    // 128 bits
const MIN_SECRET_LENGTH = 32;  // 32 hex chars = 16 bytes minimum (64 recommended)
const HKDF_INFO = 'linkedin-agent-session-v1';

// ── Key Derivation ───────────────────────────────────────────

/**
 * Derive a 256-bit AES key from SESSION_SECRET using HKDF.
 * HKDF provides domain separation — even if two applications
 * share the same secret, different info strings produce
 * different keys.
 */
function deriveKey(secret) {
  const keyMaterial = Buffer.from(secret, 'hex');
  return Buffer.from(
    hkdfSync('sha256', keyMaterial, '', HKDF_INFO, 32)
  );
}

/**
 * Read and validate SESSION_SECRET from environment.
 * Throws if missing, too short, or not valid hex.
 * Must be at least 64 hex characters (32 bytes = 256 bits).
 */
function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error('Session configuration invalid.');
  }
  if (!/^[0-9a-f]+$/i.test(secret)) {
    throw new Error('Session configuration invalid.');
  }
  return secret;
}

// ── Encryption ───────────────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns base64url(IV || ciphertext || authTag).
 */
function encrypt(plaintext, key) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  // Pack: IV (12) + ciphertext (variable) + authTag (16)
  return Buffer.concat([iv, encrypted, authTag]).toString('base64url');
}

/**
 * Decrypt a base64url(IV || ciphertext || authTag) string.
 * Returns the plaintext string, or null if decryption fails.
 */
function decrypt(packed, key) {
  try {
    const data = Buffer.from(packed, 'base64url');

    // Minimum length: IV (12) + at least 1 byte ciphertext + authTag (16) = 29
    if (data.length < IV_LENGTH + 1 + AUTH_TAG_LENGTH) {
      return null;
    }

    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  } catch {
    // Any decryption failure (bad key, tampered data, wrong format)
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Create an encrypted session cookie on the response.
 *
 * @param {object} res   — Express response object
 * @param {object} tokens — { accessToken, refreshToken?, expiresIn, user: { sub, email?, name? } }
 */
export function createSession(res, tokens) {
  if (!tokens?.accessToken) {
    throw new Error('Session requires an access token.');
  }
  if (!tokens?.user?.sub) {
    throw new Error('Session requires user claims.');
  }

  const secret = getSecret();
  const key = deriveKey(secret);

  const payload = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || null,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (tokens.expiresIn ?? DEFAULT_TOKEN_EXPIRY_SECONDS) * MS_PER_SECOND,
    user: {
      sub: tokens.user.sub,
      email: tokens.user.email || null,
      name: tokens.user.name || null,
      emailVerified: tokens.user.emailVerified === true,
    }
  };

  const encrypted = encrypt(JSON.stringify(payload), key);

  res.cookie(SESSION_COOKIE_NAME, encrypted, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  });

  sessionLog("debug", "session_created", {
    sub: tokens.user.sub,
    ttlMinutes: Math.round(SESSION_MAX_AGE_MS / MS_PER_MINUTE)
  });
}

/**
 * Read and decrypt the session cookie from a request.
 *
 * @param {object} req — Express request object (or mock with headers.cookie)
 * @returns {object|null} — { accessToken, refreshToken, expiresAt, user } or null
 */
export function readSession(req) {
  const cookieHeader = req?.headers?.cookie;
  if (!cookieHeader) return null;

  // Parse the Cookie header to find our session cookie
  const value = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  if (!value) return null;

  let secret;
  try {
    secret = getSecret();
  } catch {
    return null;
  }

  const key = deriveKey(secret);
  const plaintext = decrypt(value, key);
  if (!plaintext) return null;

  try {
    const payload = JSON.parse(plaintext);
    if (!payload?.accessToken || !payload?.user?.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Clear the session cookie.
 *
 * @param {object} res — Express response object
 */
export function clearSession(res) {
  res.cookie(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

// ── Sliding Window Refresh ──────────────────────────────────

/**
 * Check if a session should be refreshed based on elapsed time.
 * Returns true when the session has consumed more than
 * SESSION_MAX_AGE_REFRESH_RATIO of its TTL.
 *
 * @param {object} session — decrypted session from readSession()
 * @returns {boolean}
 */
export function shouldRefreshSession(session) {
  if (!session || typeof session.issuedAt !== 'number') return false;
  const elapsed = Date.now() - session.issuedAt;
  const threshold = SESSION_MAX_AGE_MS * SESSION_MAX_AGE_REFRESH_RATIO;
  return elapsed > threshold;
}

/**
 * Re-issue the session cookie with a fresh expiresAt.
 * Called at response time (not request time) so long-running
 * requests don't consume the session window.
 *
 * The session payload is re-encrypted with the same key.
 * The cookie attributes (httpOnly, secure, sameSite) are
 * identical to createSession.
 *
 * @param {object} res     — Express response object
 * @param {object} session — decrypted session from readSession()
 */
export function refreshSession(res, session) {
  if (!session || !session.user?.sub) return;

  try {
    const key = deriveKey(getSecret());

    const now = Date.now();
    const oldRemainingMs = (session.issuedAt + SESSION_MAX_AGE_MS) - now;

    const payload = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken || null,
      issuedAt: now,
      expiresAt: session.expiresAt,
      user: {
        sub: session.user.sub,
        email: session.user.email || null,
        name: session.user.name || null,
        emailVerified: session.user.emailVerified === true,
      }
    };

    const encrypted = encrypt(JSON.stringify(payload), key);

    res.cookie(SESSION_COOKIE_NAME, encrypted, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    });

    sessionLog("debug", "session_refreshed", {
      sub: session.user.sub,
      oldRemainingMinutes: Math.round(oldRemainingMs / MS_PER_MINUTE),
      newTtlMinutes: Math.round(SESSION_MAX_AGE_MS / MS_PER_MINUTE)
    });
  } catch (err) {
    sessionLog("debug", "session_refresh_failed", {
      sub: session.user?.sub,
      error: err.message
    });
    // Refresh failed — the original cookie continues with its
    // existing expiresAt. No new attack surface; the session
    // simply won't be extended this cycle.
  }
}

/**
 * Check if a session's access token is nearing expiry.
 *
 * @param {object|null} session — session object from readSession()
 * @param {number} [thresholdMs=300000] — milliseconds before expiry to consider "expiring" (default 5 min)
 * @returns {boolean} — true if session is null, missing expiresAt, or within threshold
 */
// Default threshold: 25% of the session TTL. With a 4-hour TTL
// this is 1 hour; with 10 minutes it's 2.5 minutes.
const SESSION_EXPIRING_THRESHOLD_MS = Math.round(SESSION_MAX_AGE_MS / 4);

export function isSessionExpiring(session, thresholdMs = SESSION_EXPIRING_THRESHOLD_MS) {
  if (!session) return true;
  if (typeof session.expiresAt !== 'number') return true;
  return session.expiresAt - Date.now() <= thresholdMs;
}

// ── Cookie Parsing ───────────────────────────────────────────

/**
 * Extract a named value from a Cookie header string.
 * Handles multiple cookies separated by "; ".
 */
function parseCookieValue(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;

  const prefix = name + '=';
  const cookies = cookieHeader.split(';');

  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.substring(prefix.length);
      return value || null;
    }
  }

  return null;
}
