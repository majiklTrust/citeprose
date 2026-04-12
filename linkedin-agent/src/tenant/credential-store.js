// ═══════════════════════════════════════════════════════════════
// src/tenant/credential-store.js — per-tenant encrypted secrets
// ═══════════════════════════════════════════════════════════════
// Reads encrypted credentials from the `credentials` table
// and decrypts them using a per-tenant key derived via HKDF.
//
// Must be called inside a withTenant() block — the tenant id
// and the RLS-scoped pg client are read from AsyncLocalStorage.
// Calling outside a withTenant block throws immediately.
//
// PUBLIC API — typed accessors per credential, not a generic
// getCredential(key) with magic strings. Every known credential
// has its own function. Adding a new credential type is an
// explicit API change, not a silent string convention.
//
// ENCRYPTION SCHEME (must match sqlite-to-postgres.mjs exactly):
//   Key derivation: HKDF-SHA256
//     IKM:  process.env.ENCRYPTION_SECRET (UTF-8 bytes)
//     Salt: tenant UUID (UTF-8 bytes)
//     Info: "credential-encryption-v1" (UTF-8 bytes)
//     Length: 32 bytes (AES-256)
//   Ciphertext format (BYTEA in DB):
//     iv (12 bytes) || authTag (16 bytes) || ciphertext
//   Algorithm: AES-256-GCM
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import { currentTenantId, currentClient } from "../db/with-tenant.js";

// ── Constants (must match migration script) ──────────────────
const HKDF_INFO = "credential-encryption-v1";
const AES_KEY_LENGTH_BYTES = 32;
const AES_IV_LENGTH_BYTES = 12;
const AES_AUTH_TAG_LENGTH_BYTES = 16;

// Internal storage-key convention. Used only within this module
// to query the `credentials` table. Callers never see these
// strings — they use the typed accessor functions below.
const STORAGE_KEY = Object.freeze({
  ANTHROPIC_API_KEY:     "anthropic_api_key",
  LINKEDIN_ACCESS_TOKEN: "linkedin_access_token",
  LINKEDIN_PERSON_URN:   "linkedin_person_urn"
});

// ── Derived-key cache (per tenant UUID) ──────────────────────
// Keys are deterministic (same inputs = same output) so caching
// is safe. Only the derived key is cached — never plaintext.
const keyCache = new Map();

function deriveTenantKey(tenantId) {
  if (keyCache.has(tenantId)) return keyCache.get(tenantId);
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("ENCRYPTION_SECRET not set");
  const derived = crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(tenantId, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    AES_KEY_LENGTH_BYTES
  );
  const key = Buffer.from(derived);
  keyCache.set(tenantId, key);
  return key;
}

function decrypt(blob, tenantKey) {
  const iv = blob.subarray(0, AES_IV_LENGTH_BYTES);
  const authTag = blob.subarray(
    AES_IV_LENGTH_BYTES,
    AES_IV_LENGTH_BYTES + AES_AUTH_TAG_LENGTH_BYTES
  );
  const ciphertext = blob.subarray(
    AES_IV_LENGTH_BYTES + AES_AUTH_TAG_LENGTH_BYTES
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", tenantKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
}

// ── Internal core ────────────────────────────────────────────
// Not exported. Callers go through the typed accessors below.
async function fetchDecrypted(storageKey) {
  const tenantId = currentTenantId();
  if (!tenantId) {
    throw new Error("credential access called outside tenant context");
  }
  const client = currentClient();
  if (!client) {
    throw new Error("No database client in tenant context");
  }
  const result = await client.query(
    "SELECT value_enc FROM credentials WHERE key = $1",
    [storageKey]
  );
  if (result.rows.length === 0) {
    throw new Error(`Credential not found: ${storageKey}`);
  }
  const tenantKey = deriveTenantKey(tenantId);
  return decrypt(result.rows[0].value_enc, tenantKey);
}

// ── Public API — typed accessors ─────────────────────────────

// Returns the current tenant's Anthropic API key in plaintext.
// Used by content-generator and research modules to construct
// the Anthropic SDK client with per-tenant BYOK credentials.
//
// Must be called inside a withTenant() block.
// Throws if no tenant context, if the credential is missing,
// or if decryption fails.
export async function getAnthropicApiKey() {
  return fetchDecrypted(STORAGE_KEY.ANTHROPIC_API_KEY);
}

// Returns the current tenant's LinkedIn OAuth access token in
// plaintext. Used by linkedin-api module to authenticate the
// post-publishing call.
//
// Must be called inside a withTenant() block.
export async function getLinkedInAccessToken() {
  return fetchDecrypted(STORAGE_KEY.LINKEDIN_ACCESS_TOKEN);
}

// Returns the current tenant's LinkedIn person URN.
// Format: "urn:li:person:<id>". Used as the author field when
// publishing a post. Not encrypted-sensitive but stored here
// for cohesion — all per-tenant identity material in one place.
//
// Must be called inside a withTenant() block.
export async function getLinkedInPersonUrn() {
  return fetchDecrypted(STORAGE_KEY.LINKEDIN_PERSON_URN);
}
