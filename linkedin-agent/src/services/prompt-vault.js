// ═══════════════════════════════════════════════════════════════
// src/services/prompt-vault.js — Encrypted prompt storage
// ═══════════════════════════════════════════════════════════════
// Reads and writes AI prompt templates from the prompt_vault
// table. Prompts are encrypted at rest using AES-256-GCM with
// a key derived from ENCRYPTION_SECRET via HKDF.
//
// Templates use {{VARIABLE}} placeholders. The calling code
// retrieves the template and substitutes variables at runtime.
//
// Usage:
//   const template = await getPrompt("quality_reviewer");
//   const assembled = renderPrompt(template, {
//     CONTENT: postContent,
//     SOURCE_CONTEXT: sourceCtx
//   });
//
// The assembled prompt exists only in memory and is never
// logged, persisted, or returned to the client.
// ═══════════════════════════════════════════════════════════════

import {
  createCipheriv, createDecipheriv, randomBytes, hkdfSync
} from "node:crypto";
import { query } from "../db/pool.js";
import { platformLog } from "./platform-log.js";

// ── Encryption constants ─────────────────────────────────────

const AES_KEY_LENGTH_BYTES = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HKDF_SALT = "prompt-vault";
const HKDF_INFO = "prompt-vault-v1";

// ── Key derivation ───────────────────────────────────────────
// Platform-level key — no tenant salt. All prompts share the
// same derived key since they're platform-wide, not per-tenant.

let cachedKey = null;

function deriveKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET is not set — prompt vault cannot operate");
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

// ── Encrypt / Decrypt ────────────────────────────────────────
// Format: IV (12) || AuthTag (16) || Ciphertext
// Same layout as credential-store.js for consistency.

function encrypt(plaintext) {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decrypt(blob) {
  const key = deriveKey();
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, null, "utf8") + decipher.final("utf8");
}

// ── Public API ───────────────────────────────────────────────

/**
 * Retrieve and decrypt a prompt template by key, authorized
 * by a signed action token. This is the primary access path.
 *
 * @param {string} key — prompt identifier
 * @param {string} actionToken — signed token from createActionToken
 * @returns {Promise<string|null>}
 */
export async function getAuthorizedPrompt(key, actionToken) {
  // Lazy import to avoid circular dependency at module load
  var { validateActionToken } = await import("./prompt-actions.js");

  var validation = validateActionToken(actionToken, key);
  if (!validation.valid) {
    platformLog("warn", "prompt_access_denied", {
      key, action: validation.action, sub: validation.sub,
      reason: validation.reason
    });
    throw new Error("Prompt access denied: " + validation.reason);
  }

  platformLog("debug", "prompt_access_granted", {
    key, action: validation.action, sub: validation.sub
  });

  return _decryptFromVault(key);
}

/**
 * Retrieve and decrypt a prompt template by key WITHOUT token
 * validation. Reserved for internal framework operations that
 * run outside a user request context (e.g., prompt-framing
 * boundary markers during pipeline assembly).
 *
 * SECURITY: Callers must never expose this to client-reachable
 * code paths. Use getAuthorizedPrompt for all user-triggered
 * operations.
 *
 * @param {string} key — prompt identifier
 * @returns {Promise<string|null>}
 */
export async function getPrompt(key) {
  platformLog("debug", "prompt_access_internal", { key });
  return _decryptFromVault(key);
}

/**
 * Internal: fetch and decrypt from the vault table.
 * @private
 */
async function _decryptFromVault(key) {
  var result = await query(
    "SELECT value_enc FROM prompt_vault WHERE key = $1",
    [key]
  );
  if (result.rows.length === 0) return null;
  return decrypt(result.rows[0].value_enc);
}

/**
 * Encrypt and store a prompt template. Upserts — inserts if
 * new, updates if the key already exists.
 *
 * @param {string} key — prompt identifier
 * @param {string} plaintext — the prompt template text
 * @param {string} [description] — human-readable description
 */
export async function storePrompt(key, plaintext, description) {
  const encrypted = encrypt(plaintext);
  await query(
    `INSERT INTO prompt_vault (key, value_enc, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE
       SET value_enc = $2, description = $3, updated_at = now()`,
    [key, encrypted, description || null]
  );
  platformLog("info", "prompt_stored", { key, descriptionLength: (description || "").length });
}

/**
 * Substitute {{VARIABLE}} placeholders in a prompt template.
 * Unknown placeholders are left as-is (defense against partial
 * rendering producing broken prompts).
 *
 * @param {string} template — prompt text with {{VAR}} placeholders
 * @param {Object<string, string>} vars — key-value substitutions
 * @returns {string}
 */
export function renderPrompt(template, vars) {
  if (!template) return "";
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match;
  });
}

/**
 * List prompt keys and metadata (no decrypted content).
 * Safe for admin visibility.
 *
 * @returns {Promise<Array<{key, description, updated_at}>>}
 */
export async function listPrompts() {
  const result = await query(
    "SELECT key, description, updated_at FROM prompt_vault ORDER BY key"
  );
  return result.rows;
}
