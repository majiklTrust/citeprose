// ═══════════════════════════════════════════════════════════════
// Auth Middleware — JWT validation for Express routes
// ═══════════════════════════════════════════════════════════════
//
// Provider-agnostic. Works with any OIDC provider registered
// in the auth registry. Does not import jose directly — all
// token verification is delegated to jwt-verifier.js.
//
// Usage in index.js:
//   import { createAuthMiddleware } from "./auth/middleware.js";
//   const { requireAuth, optionalAuth } = createAuthMiddleware(logActivity);
//   app.use("/api", requireAuth);
//
// The middleware reads the Authorization header, decodes the
// JWT header to find the issuer, looks up the matching provider,
// and validates the token against that provider's JWKS.
// ═══════════════════════════════════════════════════════════════

import { isAuthEnabled, getProviders, getJwksMap, getIssuers } from "./index.js";
import { verifyToken } from "./jwt-verifier.js";

// ── Error Responses ──────────────────────────────────────────
// Generic messages — never leak token details or internal state.

const ERR_NO_TOKEN       = { status: 401, error: "Authentication required." };
const ERR_BAD_FORMAT     = { status: 401, error: "Invalid authorization header format." };
const ERR_TOKEN_EXPIRED  = { status: 401, error: "Token expired. Please log in again." };
const ERR_TOKEN_INVALID  = { status: 401, error: "Invalid token." };
const ERR_ISSUER_UNKNOWN = { status: 401, error: "Token issuer not recognized." };
const ERR_INTERNAL       = { status: 500, error: "Authentication check failed." };

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

  /**
   * requireAuth — blocks requests without a valid token.
   * Attaches req.user (decoded JWT payload) on success.
   */
  async function requireAuth(req, res, next) {
    // If no auth providers are configured, pass through
    // (dev mode without auth — controlled by NODE_ENV in registry)
    if (!isAuthEnabled()) {
      req.user = null;
      req.authSkipped = true;
      return next();
    }

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
      if (logFn) logFn("warn", "auth_token_unreadable", { path: req.path });
      return res.status(ERR_TOKEN_INVALID.status).json({ error: ERR_TOKEN_INVALID.error });
    }

    // Find matching provider by issuer
    const jwksMap = getJwksMap();
    const jwksUri = jwksMap.get(issuer);

    if (!jwksUri) {
      if (logFn) logFn("warn", "auth_issuer_unknown", {
        path: req.path,
        issuer,
        knownIssuers: getIssuers()
      });
      return res.status(ERR_ISSUER_UNKNOWN.status).json({ error: ERR_ISSUER_UNKNOWN.error });
    }

    // Find the audience from the provider that matches this issuer
    const provider = getProviders().find(p => p.issuer === issuer);
    const audience = provider?.audience || null;

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
        raw: payload
      };

      req.authProvider = provider?.name || "unknown";
      return next();

    } catch (err) {
      const code = err.message;

      if (code === "TOKEN_EXPIRED") {
        if (logFn) logFn("info", "auth_token_expired", { path: req.path, issuer });
        return res.status(ERR_TOKEN_EXPIRED.status).json({ error: ERR_TOKEN_EXPIRED.error });
      }

      if (code === "JWKS_FETCH_FAILED") {
        if (logFn) logFn("error", "auth_jwks_fetch_failed", { path: req.path, issuer, jwksUri });
        return res.status(ERR_INTERNAL.status).json({ error: ERR_INTERNAL.error });
      }

      // All other verification failures
      if (logFn) logFn("warn", "auth_token_rejected", {
        path: req.path,
        issuer,
        reason: code
      });

      return res.status(ERR_TOKEN_INVALID.status).json({ error: ERR_TOKEN_INVALID.error });
    }
  }

  /**
   * optionalAuth — attempts to validate token if present,
   * but allows the request through even without one.
   * Attaches req.user if token is valid, null otherwise.
   */
  async function optionalAuth(req, res, next) {
    if (!isAuthEnabled()) {
      req.user = null;
      req.authSkipped = true;
      return next();
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

    const provider = getProviders().find(p => p.issuer === issuer);
    const audience = provider?.audience || null;

    try {
      const payload = await verifyToken(token, issuer, jwksUri, audience);
      req.user = {
        sub: payload.sub,
        email: payload.email || null,
        name: payload.name || null,
        issuer: payload.iss,
        audience: payload.aud,
        expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
        raw: payload
      };
      req.authProvider = provider?.name || "unknown";
    } catch {
      req.user = null;
    }

    return next();
  }

  return { requireAuth, optionalAuth };
}
