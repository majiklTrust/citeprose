// ═══════════════════════════════════════════════════════════════
// src/services/platform-secret.js — Platform-level secret crypto
// ═══════════════════════════════════════════════════════════════
// Encrypts/decrypts platform-scoped secrets (not tenant-scoped)
// for storage in environment variables as base64 ciphertext.
//
// Consumer: PLATFORM_LANGUAGE_API_KEY, the platform's own vendor
// key, read through config/platform-keys.js by the model-catalog
// endpoint and by the Generation Lab.
//
// Scheme: AES-256-GCM, key = HKDF(ENCRYPTION_SECRET).
//   Blob layout: IV (12) || AuthTag (16) || Ciphertext
//   (same packing as prompt-vault.js and credential-store.js)
//   Env storage: base64(blob)
//
// Domain separation: the HKDF salt/info below are DISTINCT from
// the prompt vault and per-tenant credential contexts, so this
// key cannot be confused with or derived from those.
//
// Zero Trust note: this is encryption-at-rest. The unlock root
// (ENCRYPTION_SECRET) is itself an env var — a leaked .env that
// also leaks ENCRYPTION_SECRET defeats it. The step-up to a KMS
// root is tracked separately (Option C).
// ═══════════════════════════════════════════════════════════════

import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";

const HKDF_SALT = "platform-secret";
const HKDF_INFO = "platform-secret-v1";
const AES_KEY_LENGTH_BYTES = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let cachedKey = null;

function deriveKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error("ENCRYPTION_SECRET is not set — platform secret cannot be decrypted");
  }
  const derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    AES_KEY_LENGTH_BYTES
  );
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

/**
 * Encrypt a plaintext secret into base64 ciphertext for env storage.
 * Used by scripts/encrypt-platform-key.js, not at runtime.
 * @param {string} plaintext
 * @returns {string} base64(IV || AuthTag || Ciphertext)
 */
export function encryptPlatformSecret(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("plaintext must be a non-empty string");
  }
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * Decrypt base64 ciphertext produced by encryptPlatformSecret.
 * Throws on missing input, bad format, or auth-tag failure.
 * @param {string} b64
 * @returns {string} plaintext
 */
export function decryptPlatformSecret(b64) {
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new Error("ciphertext is empty");
  }
  const blob = Buffer.from(b64, "base64");
  if (blob.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("ciphertext is malformed");
  }
  const key = deriveKey();
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, null, "utf8") + decipher.final("utf8");
}
