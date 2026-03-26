// ═══════════════════════════════════════════════════════════════
// JWT Verifier — Token signature and claims validation
// ═══════════════════════════════════════════════════════════════
//
// This is the ONLY file in the codebase that imports `jose`.
// To replace with hand-coded verification later:
//   1. Remove the jose import
//   2. Implement verifyToken() using Node's crypto module
//   3. Keep the same function signature and return shape
//   4. Keep the same error messages (middleware depends on them)
//
// Function signature:
//   verifyToken(token, issuer, jwksUri, audience) → Promise<payload>
//
// Returns: decoded JWT payload object on success
// Throws:  Error with descriptive message on failure
// ═══════════════════════════════════════════════════════════════

import { createRemoteJWKSet, jwtVerify, errors } from "jose";

// ── JWKS Cache ───────────────────────────────────────────────
// One JWKS endpoint per issuer. createRemoteJWKSet handles
// key caching and rotation internally.

const jwksSets = new Map();

function getJwksSet(jwksUri) {
  if (!jwksSets.has(jwksUri)) {
    jwksSets.set(jwksUri, createRemoteJWKSet(new URL(jwksUri)));
  }
  return jwksSets.get(jwksUri);
}

// ── Public API ───────────────────────────────────────────────

// ── FIX 3.3.3.3-A | MEDIUM ──────────────────────────────────
// Threat closed: An attacker can no longer submit oversized JWTs
// (e.g., 1MB) to consume server CPU and memory during signature
// verification. Tokens exceeding this limit are rejected before
// any cryptographic operations occur. Auth0 tokens are typically
// 1-2KB; 16KB provides generous headroom for custom claims.
const MAX_TOKEN_BYTES = 16_384;

/**
 * Verify a JWT token against a specific issuer's JWKS endpoint.
 *
 * @param {string} token     — raw JWT string (from Authorization header)
 * @param {string} issuer    — expected iss claim (e.g. "https://tenant.auth0.com/")
 * @param {string} jwksUri   — JWKS endpoint URL for public key retrieval
 * @param {string} audience  — expected aud claim (e.g. "https://linkedin-agent-api")
 * @returns {Promise<object>} decoded JWT payload
 * @throws {Error} with message describing the failure reason
 */
export async function verifyToken(token, issuer, jwksUri, audience) {
  if (!token) {
    throw new Error("TOKEN_MISSING");
  }

  if (typeof token === "string" && Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw new Error("TOKEN_INVALID");
  }

  if (!issuer || !jwksUri) {
    throw new Error("VERIFIER_MISCONFIGURED");
  }

  try {
    const jwks = getJwksSet(jwksUri);

    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      clockTolerance: 30  // 30 seconds leeway for clock skew
    });

    return payload;
  } catch (err) {
    // Map jose errors to predictable error messages
    // that the middleware can handle consistently.
    if (err instanceof errors.JWTExpired) {
      throw new Error("TOKEN_EXPIRED");
    }
    if (err instanceof errors.JWTClaimValidationFailed) {
      const claim = err.claim || "unknown";
      if (claim === "iss") throw new Error("TOKEN_INVALID_ISSUER");
      if (claim === "aud") throw new Error("TOKEN_INVALID_AUDIENCE");
      throw new Error("TOKEN_CLAIM_INVALID");
    }
    if (err instanceof errors.JWSSignatureVerificationFailed) {
      throw new Error("TOKEN_SIGNATURE_INVALID");
    }
    if (err instanceof errors.JWKSNoMatchingKey) {
      throw new Error("TOKEN_KEY_NOT_FOUND");
    }
    if (err instanceof errors.JWKSTimeout || err.code === "ERR_JOSE_GENERIC") {
      throw new Error("JWKS_FETCH_FAILED");
    }

    // Catch-all for unexpected jose errors
    throw new Error("TOKEN_INVALID");
  }
}

/**
 * Clear the cached JWKS sets (for testing or key rotation events).
 */
export function clearJwksCache() {
  jwksSets.clear();
}

// ── Error code reference ─────────────────────────────────────
//
// TOKEN_MISSING            — no token provided
// TOKEN_EXPIRED            — token past its exp claim
// TOKEN_INVALID_ISSUER     — iss claim doesn't match expected issuer
// TOKEN_INVALID_AUDIENCE   — aud claim doesn't match expected audience
// TOKEN_CLAIM_INVALID      — other claim validation failure
// TOKEN_SIGNATURE_INVALID  — signature doesn't match any known key
// TOKEN_KEY_NOT_FOUND      — no matching key in JWKS for this token's kid
// TOKEN_INVALID            — catch-all for malformed or unverifiable tokens
// JWKS_FETCH_FAILED        — could not reach the JWKS endpoint
// VERIFIER_MISCONFIGURED   — issuer or jwksUri not provided
