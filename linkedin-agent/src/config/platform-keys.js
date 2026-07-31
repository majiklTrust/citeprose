// ═══════════════════════════════════════════════════════════════
// Platform Keys Configuration - platform-owned generation defaults
// ═══════════════════════════════════════════════════════════════
//
// Single source of truth for the platform's own vendor API keys,
// used by the key-resolution chain as the LAST step when a tenant
// has neither a trial grant nor a stored key of their own (ruled
// 2.5.60). Getter-per-value per project convention.
//
// Environment variables (values are ENCRYPTED at rest under the
// platform-secret scheme, never plaintext in .env):
//
//   PLATFORM_ANTHROPIC_API_KEY
//   PLATFORM_OPENAI_API_KEY
//
// Behavior mirrors src/config/ai.js discipline: a missing variable
// means "no platform default for this provider" and resolves null,
// never throws. An UNDECRYPTABLE value (rotated ENCRYPTION_SECRET,
// malformed ciphertext) is a configuration fault: it logs loudly
// via platformLog and resolves null, fail-visible, so generation
// fails with the ordinary missing-credential path instead of
// transmitting ciphertext to a vendor as an API key.

import { decryptPlatformSecret } from "../services/platform-secret.js";
import { platformLog } from "../services/platform-log.js";

// The allowlist of providers the platform holds default keys for.
// Extending it is a config-and-.env change plus one entry here;
// grok and custom deliberately have no platform default.
const PLATFORM_KEY_ENV = Object.freeze({
  anthropic: "PLATFORM_ANTHROPIC_API_KEY",
  openai: "PLATFORM_OPENAI_API_KEY"
});

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
