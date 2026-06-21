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
import { computeTemplateFingerprint } from "./template-crypto.js";

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
 * @param {string} [genre="default"] — genre variant; falls back
 *        to the default-genre template if the requested genre
 *        has no row.
 * @returns {Promise<string|null>}
 */
export async function getAuthorizedPrompt(key, actionToken, genre = "default") {
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

  return _decryptFromVault(key, genre);
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
 * @param {string} [genre="default"] — genre variant; falls back
 *        to the default-genre template if absent.
 * @returns {Promise<string|null>}
 */
export async function getPrompt(key, genre = "default") {
  platformLog("debug", "prompt_access_internal", { key, genre });
  return _decryptFromVault(key, genre);
}

/**
 * Internal: fetch and decrypt from the vault table.
 *
 * Looks up the (key, genre) row first. If the requested genre is
 * not 'default' and has no row, falls back to the default-genre
 * template so content generation never fails for a missing genre.
 * The fallback is logged so a missing genre is visible.
 * @private
 */
async function _decryptFromVault(key, genre = "default") {
  var result = await query(
    "SELECT value_enc FROM prompt_vault WHERE key = $1 AND genre = $2",
    [key, genre]
  );

  // Fall back to the default genre when a non-default genre is
  // requested but not present. This guarantees a usable template.
  if (result.rows.length === 0 && genre !== "default") {
    platformLog("info", "prompt_genre_fallback", { key, requestedGenre: genre });
    result = await query(
      "SELECT value_enc FROM prompt_vault WHERE key = $1 AND genre = $2",
      [key, "default"]
    );
  }

  if (result.rows.length === 0) return null;
  return decrypt(result.rows[0].value_enc);
}

/**
 * Encrypt and store a prompt template. Upserts — inserts if
 * new, updates if the (key, genre) pair already exists.
 *
 * Defaults to the 'default' genre so existing seed callers that
 * pass only (key, plaintext, description) continue to target the
 * base template unchanged.
 *
 * @param {string} key — prompt identifier
 * @param {string} plaintext — the prompt template text
 * @param {string} [description] — human-readable description
 * @param {string} [genre="default"] — genre variant
 */
export async function storePrompt(key, plaintext, description, genre = "default") {
  const encrypted = encrypt(plaintext);
  await query(
    `INSERT INTO prompt_vault (key, genre, value_enc, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key, genre) DO UPDATE
       SET value_enc = $3, description = $4, updated_at = now()`,
    [key, genre, encrypted, description || null]
  );
  platformLog("info", "prompt_stored", {
    key, genre, descriptionLength: (description || "").length
  });
}

// ── Genre validation ─────────────────────────────────────────
// Mirrors the DB CHECK constraint in 19-prompt-genre.sql.
// Lowercase, starts with a letter, 2-32 chars. 'default' is a
// valid genre id and may be created or updated like any other.
const GENRE_RE = /^[a-z][a-z0-9_]{1,31}$/;

// Keywords whose presence in a template's plaintext marks the genre
// as metric-bearing. Scanned at submit time (before encryption) and
// stored as a flag, so reads never decrypt. Substring match. Extend
// this list as new metric placeholders are introduced.
const METRIC_KEYWORDS = ["METRIC_BLOCK"];

function detectMetricBearing(plaintext) {
  const text = typeof plaintext === "string" ? plaintext : "";
  return METRIC_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * Create or update a genre template for a prompt key (upsert).
 *
 * Any genre — including 'default' — may be written. Creating a
 * brand-new (key, genre) needs no confirmation. Overwriting an
 * existing one requires `confirmed = true`; without it the call
 * throws CONFIRM_OVERWRITE so the caller can ask the operator to
 * confirm. This keeps new-genre creation a single action while
 * making an overwrite of a live template deliberate.
 *
 * Encryption is identical to every other prompt (same key, same
 * AES-256-GCM, fresh IV). Plaintext is never logged or returned.
 *
 * @param {string} key — prompt identifier (e.g. "content_generator")
 * @param {string} genre — genre id; must match GENRE_RE ('default' allowed)
 * @param {string} plaintext — the prompt template text
 * @param {string} [description] — human-readable description
 * @param {boolean} [confirmed=false] — required to overwrite an existing row
 * @returns {Promise<{action: "created"|"updated"}>}
 * @throws {Error} with a stable `.code`:
 *           INVALID_GENRE     — genre fails validation
 *           EMPTY_TEMPLATE    — plaintext missing/blank
 *           EMPTY_DESCRIPTION — description missing/blank
 *           CONFIRM_OVERWRITE — row exists and confirmed !== true
 */
export async function storePromptGenre(key, genre, plaintext, description, confirmed = false) {
  if (typeof genre !== "string" || !GENRE_RE.test(genre)) {
    const e = new Error("Genre must be lowercase, start with a letter, 2-32 chars");
    e.code = "INVALID_GENRE";
    throw e;
  }
  if (typeof plaintext !== "string" || plaintext.trim().length === 0) {
    const e = new Error("Template text is required");
    e.code = "EMPTY_TEMPLATE";
    throw e;
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    const e = new Error("Description is required");
    e.code = "EMPTY_DESCRIPTION";
    throw e;
  }

  // Does this (key, genre) already exist? Determines create-vs-update
  // and whether confirmation is required.
  const existing = await query(
    "SELECT 1 FROM prompt_vault WHERE key = $1 AND genre = $2",
    [key, genre]
  );
  const exists = existing.rows.length > 0;

  // Overwriting a live template is a deliberate, confirmed action.
  if (exists && confirmed !== true) {
    const e = new Error("A template for this genre already exists; confirm to overwrite");
    e.code = "CONFIRM_OVERWRITE";
    throw e;
  }

  // Derive the metric-bearing flag from the plaintext at submit time
  // (source of truth, no read-time decryption). Then run the
  // pre-encryption crypto hook (placeholder) while plaintext is in
  // hand. Both happen before encrypt().
  const metricBearing = detectMetricBearing(plaintext);
  computeTemplateFingerprint(plaintext);

  const encrypted = encrypt(plaintext);

  await query(
    `INSERT INTO prompt_vault (key, genre, value_enc, description, metric_bearing)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key, genre) DO UPDATE
       SET value_enc = $3, description = $4, metric_bearing = $5, updated_at = now()`,
    [key, genre, encrypted, description || null, metricBearing]
  );

  platformLog("info", exists ? "content_genre_updated" : "content_genre_inserted", {
    key, genre, metricBearing, descriptionLength: (description || "").length
  });

  return { action: exists ? "updated" : "created" };
}

/**
 * Metadata-only existence check for a (key, genre) pair. Reads no
 * ciphertext — used by the Composer boundary to validate a requested
 * genre before generation, so an unknown genre is rejected with a
 * clear error rather than silently falling back to default.
 *
 * @param {string} key — prompt identifier (e.g. "content_generator")
 * @param {string} genre — genre id to check
 * @returns {Promise<boolean>}
 */
export async function genreExists(key, genre) {
  const result = await query(
    "SELECT 1 FROM prompt_vault WHERE key = $1 AND genre = $2 LIMIT 1",
    [key, genre]
  );
  return result.rows.length > 0;
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
 * Safe for admin visibility. Includes genre so admins can see
 * which genre variants exist per key.
 *
 * @returns {Promise<Array<{key, genre, description, updated_at}>>}
 */
export async function listPrompts() {
  const result = await query(
    "SELECT key, genre, description, updated_at FROM prompt_vault ORDER BY key, genre"
  );
  return result.rows;
}
