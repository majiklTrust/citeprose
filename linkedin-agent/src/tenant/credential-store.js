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
  OPENAI_API_KEY:        "openai_api_key",
  GROK_API_KEY:          "grok_api_key",
  CUSTOM_LLM_API_KEY:    "custom_llm_api_key",
  LINKEDIN_ACCESS_TOKEN: "linkedin_access_token",
  LINKEDIN_REFRESH_TOKEN: "linkedin_refresh_token",
  LINKEDIN_PERSON_URN:   "linkedin_person_urn",
  LINKEDIN_ORG_URN:      "linkedin_org_urn"
});

// LLM provider dimension: each vendor's key lives under its own
// storage key, so the effective credential lookup is keyed by
// (tenant, provider). The tenant half comes from RLS plus the
// HKDF salt; the provider half is this map. Fail closed: a
// provider missing from this map has no credential path at all.
// anthropic deliberately reuses the legacy storage key so
// existing tenants keep working with zero data migration.
const LLM_PROVIDER_STORAGE_KEY = Object.freeze({
  anthropic: STORAGE_KEY.ANTHROPIC_API_KEY,
  openai:    STORAGE_KEY.OPENAI_API_KEY,
  grok:      STORAGE_KEY.GROK_API_KEY,
  custom:    STORAGE_KEY.CUSTOM_LLM_API_KEY
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

function encrypt(plaintext, tenantKey) {
  const iv = crypto.randomBytes(AES_IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", tenantKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  // Binary format: iv (12) || authTag (16) || ciphertext
  // Must match the format decrypt() expects.
  return Buffer.concat([iv, authTag, encrypted]);
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

// Encrypts plaintext and upserts into the credentials table.
// Uses ON CONFLICT to update if the key already exists.
// encryption_version is always 1 (current scheme).
async function storeEncrypted(storageKey, plaintext) {
  const tenantId = currentTenantId();
  if (!tenantId) {
    throw new Error("credential store called outside tenant context");
  }
  const client = currentClient();
  if (!client) {
    throw new Error("No database client in tenant context");
  }
  const tenantKey = deriveTenantKey(tenantId);
  const blob = encrypt(plaintext, tenantKey);
  await client.query(
    `INSERT INTO credentials (tenant_id, key, value_enc, encryption_version)
     VALUES (current_tenant_id(), $1, $2, 1)
     ON CONFLICT (tenant_id, key)
     DO UPDATE SET value_enc = EXCLUDED.value_enc,
                   encryption_version = EXCLUDED.encryption_version,
                   updated_at = now()`,
    [storageKey, blob]
  );
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

// Returns the current tenant's LinkedIn OAuth REFRESH token in
// plaintext (FR-CC-03). Throws when absent, same contract as the
// other accessors. Must be called inside a withTenant() block.
export async function getLinkedInRefreshToken() {
  return fetchDecrypted(STORAGE_KEY.LINKEDIN_REFRESH_TOKEN);
}

// Presence probe that never decrypts and never throws on absence:
// the refresher uses it to decide whether a tenant participates in
// proactive renewal at all. Must run inside withTenant().
export async function hasLinkedInRefreshToken() {
  try {
    await fetchDecrypted(STORAGE_KEY.LINKEDIN_REFRESH_TOKEN);
    return true;
  } catch {
    return false;
  }
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

// Returns the current tenant's LinkedIn organization page URN.
// Format: "urn:li:organization:<id>". Used as the author field
// when publishing to an org page via the Community Management API.
// Throws if the credential is missing — indicates the tenant
// has not connected an org page via /auth/linkedin.
export async function getLinkedInOrgUrn() {
  return fetchDecrypted(STORAGE_KEY.LINKEDIN_ORG_URN);
}

// ── Public API - LLM provider dimension ──────────────────────

// Maps an LLM provider id to its credentials-table storage key.
// Own-property lookup only: prototype names like __proto__ or
// constructor can never resolve to a storage key.
// Throws on unknown providers BEFORE any tenant or data access.
export function llmCredentialKeyFor(providerId) {
  const id = typeof providerId === "string" ? providerId.trim() : "";
  if (!Object.prototype.hasOwnProperty.call(LLM_PROVIDER_STORAGE_KEY, id)) {
    throw new Error(`No credential storage key for LLM provider: ${String(providerId)}`);
  }
  return LLM_PROVIDER_STORAGE_KEY[id];
}

// Returns the current tenant's API key for the given LLM provider,
// in plaintext. The (tenant, provider) pair fully determines the
// row: tenant via RLS + derived key, provider via storage key.
//
// Must be called inside a withTenant() block. Throws if the
// provider is unknown, if there is no tenant context, if the
// credential is missing, or if decryption fails.
export async function getLlmApiKey(providerId) {
  return fetchDecrypted(llmCredentialKeyFor(providerId));
}

// True when the current tenant has a stored key for the provider.
// Existence probe only: the ciphertext is never fetched, nothing
// is decrypted. Must be called inside a withTenant() block.
export async function hasLlmApiKey(providerId) {
  const storageKey = llmCredentialKeyFor(providerId);
  const tenantId = currentTenantId();
  if (!tenantId) {
    throw new Error("credential access called outside tenant context");
  }
  const client = currentClient();
  if (!client) {
    throw new Error("No database client in tenant context");
  }
  const result = await client.query(
    "SELECT 1 FROM credentials WHERE key = $1",
    [storageKey]
  );
  return result.rows.length > 0;
}

// ── Public API — generic store ───────────────────────────────

// Encrypts a plaintext value and upserts it into the credentials
// table for the current tenant. Accepts any key — not restricted
// to STORAGE_KEY entries, so callers can store arbitrary secrets.
//
// Used by the LinkedIn OAuth callback to persist tokens to the
// database instead of process.env. Also usable for future
// credential types without adding a new typed accessor.
//
// Must be called inside a withTenant() block.
// Throws if no tenant context or no database client.
export async function storeCredential(key, plaintext) {
  return storeEncrypted(key, plaintext);
}
