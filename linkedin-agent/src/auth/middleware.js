// ═══════════════════════════════════════════════════════════════
// Auth Middleware — JWT validation for Express routes
// ═══════════════════════════════════════════════════════════════
//
// Provider-agnostic. Works with any OIDC provider registered
// in the auth registry. Does not import jose directly — all
// token verification is delegated to jwt-verifier.js.
//
// Authentication priority:
//   1. Dev bypass (NODE_ENV !== 'production' + DEV_BYPASS_ORIGINS)
//   2. Session cookie (browser path) — readSession()
//   3. Authorization: Bearer header (programmatic path) — verifyToken()
//   4. Neither present → 401
//
// Usage in index.js:
//   import { createAuthMiddleware } from "./auth/middleware.js";
//   const { requireAuth, optionalAuth } = createAuthMiddleware(logActivity);
//   app.use("/api", requireAuth);
// ═══════════════════════════════════════════════════════════════

import { isAuthEnabled, getProviders, getJwksMap, getIssuers, getSnapshotByIssuer } from "./index.js";
import { verifyToken } from "./jwt-verifier.js";
import { readSession } from "./session.js";

// ── Error Responses ──────────────────────────────────────────
// Generic messages — never leak token details or internal state.

const ERR_NO_TOKEN       = { status: 401, error: "Authentication required." };
const ERR_BAD_FORMAT     = { status: 401, error: "Invalid authorization header format." };
const ERR_TOKEN_EXPIRED  = { status: 401, error: "Token expired. Please log in again." };
const ERR_TOKEN_INVALID  = { status: 401, error: "Invalid token." };
const ERR_ISSUER_UNKNOWN = { status: 401, error: "Token issuer not recognized." };
const ERR_INTERNAL       = { status: 500, error: "Authentication check failed." };

// ── Dev Bypass ───────────────────────────────────────────────

/**
 * Check if the current request qualifies for dev mode bypass.
 *
 * Two conditions must BOTH be true:
 *   1. NODE_ENV is NOT 'production'
 *   2. DEV_BYPASS_ORIGINS is set and the request origin matches
 *
 * If DEV_BYPASS_ORIGINS is not set, dev bypass is disabled even
 * in non-production environments. This is intentional — explicit
 * opt-in prevents accidental bypass on staging servers.
 */
function isDevBypass(req) {
  if (process.env.NODE_ENV === 'production') return false;

  const bypassOrigins = process.env.DEV_BYPASS_ORIGINS;
  if (!bypassOrigins) return false;

  const allowed = bypassOrigins.split(',').map(o => o.trim()).filter(Boolean);
  if (allowed.length === 0) return false;

  // Check the Origin header (present on cross-origin and same-origin fetch)
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) return true;

  // For same-origin requests without Origin header (direct browser navigation),
  // construct the effective origin from protocol + host
  if (!origin) {
    const proto = req.protocol || 'http';
    const host = req.headers.host;
    if (host) {
      const effective = `${proto}://${host}`;
      if (allowed.includes(effective)) return true;
    }
  }

  return false;
}

// ── Token Extraction ─────────────────────────────────────────

function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return undefined; // present but malformed — distinct from missing
  }

  return parts[1];
}

// ── Issuer Detection ─────────────────────────────────────────
// Decode JWT header + payload without verification to read iss.
// This is safe because we verify the signature immediately after.

function decodeTokenIssuer(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );

    return payload.iss || null;
  } catch {
    return null;
  }
}

// ── Middleware Factory ────────────────────────────────────────

/**
 * Create auth middleware functions.
 *
 * @param {Function} logFn — logging function: logFn(level, action, details)
 * @returns {{ requireAuth: Function, optionalAuth: Function }}
 */
export function createAuthMiddleware(logFn) {

  // Safe logging wrapper — a logging failure must never crash
  // auth enforcement. If logFn throws (e.g. database not
  // initialized), the auth decision is unaffected.
  function safeLog(level, action, details) {
    if (!logFn) return;
    try {
      logFn(level, action, details);
    } catch {
      // Logging failed — swallow silently.
      // Auth enforcement continues regardless.
    }
  }

  /**
   * requireAuth — blocks requests without a valid token or session.
   * Attaches req.user (decoded JWT payload or session user) on success.
   *
   * Priority: no providers → dev bypass → session cookie → Bearer → 401
   */
  async function requireAuth(req, res, next) {
    // If no auth providers are configured, pass through
    if (!isAuthEnabled()) {
      req.user = null;
      req.authSkipped = true;
      return next();
    }

    // Dev bypass: non-production + request from DEV_BYPASS_ORIGINS
    // Auth providers may be configured (for testing the login flow)
    // but enforcement is disabled for matching origins.
    if (isDevBypass(req)) {
      req.user = null;
      req.authSkipped = true;
      req.devBypass = true;
      return next();
    }

    // ── Path 1: Session cookie ─────────────────────────────
    // Browser requests include the session cookie automatically.
    // readSession decrypts and validates. Returns null on any failure.
    try {
      const session = readSession(req);
      if (session && session.user && session.user.sub) {
        req.user = {
          sub: session.user.sub,
          email: session.user.email || null,
          name: session.user.name || null,
          expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
          authMethod: 'session',
        };
        return next();
      }
    } catch {
      // Session read failed — fall through to Bearer check.
    }

    // ── Path 2: Bearer token ───────────────────────────────
    const token = extractBearerToken(req);

    // No Authorization header
    if (token === null) {
      return res.status(ERR_NO_TOKEN.status).json({ error: ERR_NO_TOKEN.error });
    }

    // Header present but malformed
    if (token === undefined) {
      return res.status(ERR_BAD_FORMAT.status).json({ error: ERR_BAD_FORMAT.error });
    }

    // Decode issuer from token (pre-verification)
    const issuer = decodeTokenIssuer(token);
    if (!issuer) {
      safeLog("warn", "auth_token_unreadable", { path: req.path });
      return res.status(ERR_TOKEN_INVALID.status).json({ error: ERR_TOKEN_INVALID.error });
    }

    // Find matching provider by issuer
    const jwksMap = getJwksMap();
    const jwksUri = jwksMap.get(issuer);

    if (!jwksUri) {
      safeLog("warn", "auth_issuer_unknown", {
        path: req.path,
        issuer,
        knownIssuers: getIssuers()
      });
      return res.status(ERR_ISSUER_UNKNOWN.status).json({ error: ERR_ISSUER_UNKNOWN.error });
    }

    // Find the audience from the frozen registration snapshot.
    const snapshot = getSnapshotByIssuer(issuer);
    const audience = snapshot?.audience || null;

    // Verify token signature and claims
    try {
      const payload = await verifyToken(token, issuer, jwksUri, audience);

      // Attach decoded user to request
      req.user = {
        sub: payload.sub,
        email: payload.email || payload[`${issuer}email`] || null,
        name: payload.name || null,
        issuer: payload.iss,
        audience: payload.aud,
        expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
        raw: payload,
        authMethod: 'bearer',
      };

      req.authProvider = snapshot?.name || "unknown";
      return next();

    } catch (err) {
      const code = err.message;

      if (code === "TOKEN_EXPIRED") {
        safeLog("info", "auth_token_expired", { path: req.path, issuer });
        return res.status(ERR_TOKEN_EXPIRED.status).json({ error: ERR_TOKEN_EXPIRED.error });
      }

      if (code === "JWKS_FETCH_FAILED") {
        safeLog("error", "auth_jwks_fetch_failed", { path: req.path, issuer, jwksUri });
        return res.status(ERR_INTERNAL.status).json({ error: ERR_INTERNAL.error });
      }

      // All other verification failures
      safeLog("warn", "auth_token_rejected", {
        path: req.path,
        issuer,
        reason: code
      });

      return res.status(ERR_TOKEN_INVALID.status).json({ error: ERR_TOKEN_INVALID.error });
    }
  }

  /**
   * optionalAuth — attempts to validate token or session if present,
   * but allows the request through even without one.
   * Attaches req.user if valid, null otherwise.
   */
  async function optionalAuth(req, res, next) {
    if (!isAuthEnabled()) {
      req.user = null;
      req.authSkipped = true;
      return next();
    }

    // Dev bypass
    if (isDevBypass(req)) {
      req.user = null;
      req.authSkipped = true;
      req.devBypass = true;
      return next();
    }

    // Try session cookie first
    try {
      const session = readSession(req);
      if (session && session.user && session.user.sub) {
        req.user = {
          sub: session.user.sub,
          email: session.user.email || null,
          name: session.user.name || null,
          expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
          authMethod: 'session',
        };
        return next();
      }
    } catch {
      // Fall through to Bearer check
    }

    const token = extractBearerToken(req);

    // No token — that's fine for optional auth
    if (token === null || token === undefined) {
      req.user = null;
      return next();
    }

    // Try to validate — if it fails, continue without user
    const issuer = decodeTokenIssuer(token);
    if (!issuer) {
      req.user = null;
      return next();
    }

    const jwksMap = getJwksMap();
    const jwksUri = jwksMap.get(issuer);
    if (!jwksUri) {
      req.user = null;
      return next();
    }

    const snapshot = getSnapshotByIssuer(issuer);
    const audience = snapshot?.audience || null;

    try {
      const payload = await verifyToken(token, issuer, jwksUri, audience);
      req.user = {
        sub: payload.sub,
        email: payload.email || null,
        name: payload.name || null,
        issuer: payload.iss,
        audience: payload.aud,
        expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
        raw: payload,
        authMethod: 'bearer',
      };
      req.authProvider = snapshot?.name || "unknown";
    } catch {
      req.user = null;
    }

    return next();
  }

  return { requireAuth, optionalAuth };
}
