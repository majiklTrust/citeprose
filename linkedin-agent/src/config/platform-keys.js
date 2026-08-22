// ═══════════════════════════════════════════════════════════════
// Platform Keys Configuration - platform-owned vendor keys
// ═══════════════════════════════════════════════════════════════
//
// Single source of truth for the platform's OWN vendor API keys, as
// opposed to a tenant's BYOK key or a trial grant.
//
// Keyed by CAPABILITY, not by vendor. What the platform needs to know
// is which key pays for language work and which pays for image work;
// which vendor receives it is a routing decision made elsewhere, and
// the same key may serve more than one provider. A vendor-keyed map
// would force a new entry every time a provider is added, for no gain.
//
// Environment variables (values are ENCRYPTED at rest under the
// platform-secret scheme, never plaintext in .env):
//
//   PLATFORM_LANGUAGE_API_KEY
//   PLATFORM_IMAGES_API_KEY
//
// Behavior mirrors src/config/ai.js discipline: a missing variable
// means "no platform key for this capability" and resolves null,
// never throws. An UNDECRYPTABLE value (rotated ENCRYPTION_SECRET,
// malformed ciphertext) is a configuration fault: it logs loudly via
// platformLog and resolves null, fail-visible, so a caller fails with
// the ordinary missing-credential path instead of transmitting
// ciphertext to a vendor as an API key.
//
// Consumers of the language key: the Generation Lab, which spends the
// platform's key by ruling rather than a tenant's, and
// GET /api/platform-admin/models, whose global model listing must
// never decrypt a tenant secret. The images key has no consumer yet.
// ═══════════════════════════════════════════════════════════════

import { decryptPlatformSecret } from "../services/platform-secret.js";
import { platformLog } from "../services/platform-log.js";

const PLATFORM_KEY_ENV = Object.freeze({
  language: "PLATFORM_LANGUAGE_API_KEY",
  images: "PLATFORM_IMAGES_API_KEY"
});

// Membership in the allowlist, NOT whether the variable is set.
// A caller asking "can the platform hold a key for this?" gets true
// here even when the variable is empty; getPlatformApiKey is what
// answers "is there a usable key right now".
export function hasPlatformKeyEnv(providerId) {
  return Object.prototype.hasOwnProperty.call(PLATFORM_KEY_ENV, providerId);
}

// Returns the DECRYPTED platform key for the provider, or null when
// unconfigured or undecryptable. Never returns ciphertext.
export function getPlatformApiKey(providerId, deps = {}) {
  if (!hasPlatformKeyEnv(providerId)) return null;
  const env = deps.env || process.env;
  const enc = env[PLATFORM_KEY_ENV[providerId]];
  if (typeof enc !== "string" || enc.trim().length === 0) return null;
  try {
    const plain = (deps.decrypt || decryptPlatformSecret)(enc.trim());
    return typeof plain === "string" && plain.length > 0 ? plain : null;
  } catch (err) {
    (deps.log || platformLog)("error", "platform_key_decrypt_failed", {
      providerId, envVar: PLATFORM_KEY_ENV[providerId], error: err && err.message
    });
    return null;
  }
}
