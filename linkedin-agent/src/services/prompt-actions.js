// ═══════════════════════════════════════════════════════════════
// src/services/prompt-actions.js — Prompt Action Registry
// ═══════════════════════════════════════════════════════════════
// Central registry mapping client operations to vault keys.
// The client never sees vault keys — it triggers actions by
// calling API endpoints. The server resolves actions to keys.
//
// Signed action tokens authorize specific vault key access.
// Tokens are scoped to one request, tied to the requesting user's
// identity, and live long enough to span the full generation pipeline
// (see TOKEN_TTL_MS below).
//
// Usage (in route handler):
//   const token = createActionToken("generate-content", req.user.sub);
//   const post = await generatePost(topicId, token);
//
// Usage (in service):
//   const template = await getAuthorizedPrompt("content_generator", token);
// ═══════════════════════════════════════════════════════════════

import { createHmac, randomBytes, hkdfSync, timingSafeEqual } from "node:crypto";
import { platformLog } from "./platform-log.js";

// ── Action Registry ──────────────────────────────────────────
// Each action defines which vault keys it may access and what
// permission the user needs. The registry is the single source
// of truth for the client-to-prompt mapping.

var ACTION_REGISTRY = {
  "generate-content": {
    description: "Generate a social media post from research",
    vaultKeys: [
      "content_generator",
      "research_brief_corroborated",
      "research_brief_uncorroborated",
      "untrusted_content_prefix",
      "untrusted_content_suffix",
      "research_assistant",
      "corroboration_analyst",
      "quality_reviewer"
    ],
    requiredPermission: "edit_post"
  },
  "discover-feeds": {
    description: "AI-powered RSS feed suggestions",
    vaultKeys: ["feed_discovery"],
    requiredPermission: "manage_feeds"
  }
};

// ── Token signing ────────────────────────────────────────────
// Derived from ENCRYPTION_SECRET with a different HKDF context
// so the signing key is distinct from the vault encryption key.

// The token is minted once at the start of a generate-content request
// and threaded through the ENTIRE pipeline (research -> web search ->
// corroboration -> untrusted-content framing -> generation -> quality
// review), which legitimately runs for minutes across several API/LLM
// round-trips. Its lifetime must therefore span the whole operation.
// The token is server-internal (never leaves the process), so this
// limit is an operational ceiling, not a network-replay defense.
var TOKEN_TTL_MS = 300000; // 5 minutes
var HKDF_SALT = "prompt-action-token";
var HKDF_INFO = "action-token-v1";
var signingKey = null;

function getSigningKey() {
  if (signingKey) return signingKey;
  var secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET is not set — action tokens cannot be signed");
  }
  var derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    32
  );
  signingKey = Buffer.from(derived);
  return signingKey;
}

// ── Nonce generation ─────────────────────────────────────────
// Nonces ensure token uniqueness but are NOT tracked server-side.
// Tokens are generated and consumed within the same process —
// they never leave the server. TTL alone prevents replay since
// an attacker would need server-side code execution to intercept
// a token, at which point they can generate their own.

// ── Token structure ──────────────────────────────────────────
// Payload: action|sub|iat|nonce
// Signature: HMAC-SHA256(payload, signingKey)
// Token: payload.signature (base64url)

/**
 * Create a signed action token authorizing access to the
 * vault keys defined by the action.
 *
 * @param {string} actionId — key in ACTION_REGISTRY
 * @param {string} sub — user identifier from req.user.sub
 * @returns {string} signed token string
 */
export function createActionToken(actionId, sub) {
  if (!ACTION_REGISTRY[actionId]) {
    throw new Error("Unknown action: " + actionId);
  }
  if (!sub || typeof sub !== "string") {
    throw new Error("User identity required for action token");
  }

  var nonce = randomBytes(16).toString("base64url");
  var iat = Date.now();
  // Delimiter: double-colon avoids conflict with | in Auth0 subs
  var payload = [actionId, sub, iat, nonce].join("::");

  var key = getSigningKey();
  var signature = createHmac("sha256", key).update(payload).digest("base64url");

  return payload + "." + signature;
}

/**
 * Validate a signed action token and verify it authorizes
 * access to the requested vault key.
 *
 * @param {string} token — signed token from createActionToken
 * @param {string} vaultKey — the vault key being accessed
 * @returns {{ valid: boolean, action: string, sub: string, reason?: string }}
 */
export function validateActionToken(token, vaultKey) {
  if (!token || typeof token !== "string") {
    return { valid: false, action: null, sub: null, reason: "missing token" };
  }

  var dotIdx = token.lastIndexOf(".");
  if (dotIdx < 0) {
    return { valid: false, action: null, sub: null, reason: "malformed token" };
  }

  var payload = token.substring(0, dotIdx);
  var providedSig = token.substring(dotIdx + 1);

  // Verify signature (constant-time comparison)
  var key = getSigningKey();
  var expectedSig = createHmac("sha256", key).update(payload).digest("base64url");

  var sigBuffer = Buffer.from(providedSig, "base64url");
  var expBuffer = Buffer.from(expectedSig, "base64url");
  if (sigBuffer.length !== expBuffer.length || !timingSafeEqual(sigBuffer, expBuffer)) {
    return { valid: false, action: null, sub: null, reason: "invalid signature" };
  }

  // Parse payload (delimiter: :: to avoid conflict with | in Auth0 subs)
  var parts = payload.split("::");
  if (parts.length !== 4) {
    return { valid: false, action: null, sub: null, reason: "malformed payload" };
  }

  var [actionId, sub, iatStr] = parts;
  var iat = parseInt(iatStr, 10);

  // Check TTL
  if (Date.now() - iat > TOKEN_TTL_MS) {
    return { valid: false, action: actionId, sub, reason: "token expired" };
  }

  // Check action exists
  var actionDef = ACTION_REGISTRY[actionId];
  if (!actionDef) {
    return { valid: false, action: actionId, sub, reason: "unknown action" };
  }

  // Check vault key is authorized for this action
  if (!actionDef.vaultKeys.includes(vaultKey)) {
    platformLog("warn", "prompt_key_unauthorized", {
      action: actionId, sub, requestedKey: vaultKey,
      allowedKeys: actionDef.vaultKeys
    });
    return { valid: false, action: actionId, sub, reason: "key not authorized for action" };
  }

  return { valid: true, action: actionId, sub };
}

/**
 * Get the action definition for inspection (no secrets exposed).
 *
 * @param {string} actionId
 * @returns {{ description: string, vaultKeys: string[], requiredPermission: string } | null}
 */
export function getActionDefinition(actionId) {
  return ACTION_REGISTRY[actionId] || null;
}

/**
 * List all registered actions (for admin/debug visibility).
 * Returns action IDs and descriptions only — no vault keys.
 *
 * @returns {Array<{ actionId: string, description: string, requiredPermission: string }>}
 */
export function listActions() {
  return Object.entries(ACTION_REGISTRY).map(([id, def]) => ({
    actionId: id,
    description: def.description,
    requiredPermission: def.requiredPermission
  }));
}
