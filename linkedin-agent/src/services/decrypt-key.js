// ═══════════════════════════════════════════════════════════════
// API Key Decryption — matches scripts/encrypt-key.js AES-256-GCM format
// ═══════════════════════════════════════════════════════════════
//
// Pure function — takes explicit parameters, reads nothing from
// process.env. Caller (index.js) is responsible for loading .env
// and passing values in.
//
// Encrypted format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
// Key derivation:   PBKDF2(passphrase, salt, 200000, 32, sha256)
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";

const ITERATIONS = 200_000;
const KEY_LENGTH = 32;
const DIGEST     = "sha256";

/**
 * Decrypt an AES-256-GCM encrypted API key.
 *
 * @param {string} encryptedKey  — "iv_hex:authTag_hex:ciphertext_hex"
 * @param {string} secret        — the passphrase used during encryption
 * @param {string} salt          — the salt used during encryption
 * @returns {string}             — the decrypted plaintext API key
 * @throws {Error}               — if any parameter is missing or decryption fails
 */
export function decryptApiKey(encryptedKey, secret, salt) {

  // ── Validate inputs ──────────────────────────────────────────
  if (!encryptedKey) {
    throw new Error(
      "encryptedKey is empty. " +
      "Check that ANTHROPIC_API_KEY_ENCRYPTED is set in your .env file. " +
      "If you haven't encrypted your key yet, run: node scripts/encrypt-key.js"
    );
  }

  if (!secret) {
    throw new Error(
      "secret is empty. " +
      "ENCRYPTION_SECRET must be provided — either in .env or as an OS environment variable. " +
      "Example: ENCRYPTION_SECRET=yourpassphrase node src/index.js"
    );
  }

  if (!salt) {
    throw new Error(
      "salt is empty. " +
      "ENCRYPTION_SALT must be provided — either in .env or as an OS environment variable. " +
      "Example: ENCRYPTION_SECRET=yourpassphrase ENCRYPTION_SALT=yoursalt node src/index.js"
    );
  }

  // ── Parse encrypted format: iv_hex:authTag_hex:ciphertext_hex
  const parts = encryptedKey.split(":");
  if (parts.length !== 3) {
    throw new Error(
      `encryptedKey has invalid format (found ${parts.length} segment(s), expected 3). ` +
      "Expected iv:authTag:ciphertext as hex segments separated by colons. " +
      "Re-run: node scripts/encrypt-key.js"
    );
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;

  // ── Decrypt ──────────────────────────────────────────────────
  try {
    const saltBuf    = Buffer.from(salt);
    const derivedKey = crypto.pbkdf2Sync(secret, saltBuf, ITERATIONS, KEY_LENGTH, DIGEST);

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      derivedKey,
      Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

    const decrypted =
      decipher.update(Buffer.from(ciphertextHex, "hex"), undefined, "utf8") +
      decipher.final("utf8");

    return decrypted.trim();
  } catch (err) {
    throw new Error(
      `Decryption failed: ${err.message}. ` +
      "This usually means ENCRYPTION_SECRET or ENCRYPTION_SALT don't match " +
      "the values used when you ran encrypt-key.js."
    );
  }
}
