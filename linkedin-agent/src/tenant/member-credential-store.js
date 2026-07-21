// =================================================================
// src/tenant/member-credential-store.js, per-member secrets (TD-3)
// =================================================================
// Phase 2 adds a member dimension: each advocacy member's personal
// LinkedIn tokens. Storage mirrors the tenant credentials table
// (AES-256-GCM blobs) in member_credentials, keyed
// (tenant_id, auth_sub, key).
//
// TD-3, Zero Trust key isolation: the AES key derives via
// HKDF(ENCRYPTION_SECRET) with a DISTINCT domain from both the
// tenant-credential domain ("credential-encryption-v1") and the
// platform-secret domain, and the member auth_sub is BOUND into
// the info string. A leaked derived key therefore exposes exactly
// one member in one tenant, never siblings, and can never be
// confused with a tenant or platform key.
//
// Import discipline: the crypto core is pure and exported for
// DB-free testing; DB access loads with-tenant lazily so this
// module imports with zero environment.
// =================================================================

import crypto from "node:crypto";

const MEMBER_HKDF_INFO_PREFIX = "member-credential-encryption-v1|";
const AES_KEY_LENGTH_BYTES = 32;
const AES_IV_LENGTH_BYTES = 12;
const AES_AUTH_TAG_LENGTH_BYTES = 16;

// -- Pure crypto core (testable with an injected secret) ---------

export function deriveMemberKey(tenantId, authSub, deps = {}) {
  const secret = deps.secret !== undefined ? deps.secret : process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("ENCRYPTION_SECRET not set");
  if (typeof tenantId !== "string" || tenantId.length === 0) throw new Error("deriveMemberKey requires tenantId");
  if (typeof authSub !== "string" || authSub.length === 0) throw new Error("deriveMemberKey requires authSub");
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(tenantId, "utf8"),
    Buffer.from(MEMBER_HKDF_INFO_PREFIX + authSub, "utf8"),
    AES_KEY_LENGTH_BYTES
  ));
}

// Binary format identical to the tenant store: iv(12)||tag(16)||ct.
export function encryptMemberValue(plaintext, memberKey) {
  const iv = crypto.randomBytes(AES_IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", memberKey, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

export function decryptMemberValue(blob, memberKey) {
  const iv = blob.subarray(0, AES_IV_LENGTH_BYTES);
  const authTag = blob.subarray(AES_IV_LENGTH_BYTES, AES_IV_LENGTH_BYTES + AES_AUTH_TAG_LENGTH_BYTES);
  const ciphertext = blob.subarray(AES_IV_LENGTH_BYTES + AES_AUTH_TAG_LENGTH_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", memberKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// -- Tenant-context helpers (lazy DB) ----------------------------

async function ctx() {
  const { currentTenantId, currentClient } = await import("../db/with-tenant.js");
  const tenantId = currentTenantId();
  if (!tenantId) throw new Error("member credential access called outside tenant context");
  const client = currentClient();
  if (!client) throw new Error("No database client in tenant context");
  return { tenantId, client };
}

export async function storeMemberCredential(authSub, key, plaintext) {
  const { tenantId, client } = await ctx();
  const blob = encryptMemberValue(plaintext, deriveMemberKey(tenantId, authSub));
  await client.query(
    `INSERT INTO member_credentials (tenant_id, auth_sub, key, value_enc, encryption_version)
     VALUES (current_tenant_id(), $1, $2, $3, 1)
     ON CONFLICT (tenant_id, auth_sub, key)
     DO UPDATE SET value_enc = EXCLUDED.value_enc,
                   encryption_version = EXCLUDED.encryption_version,
                   updated_at = now()`,
    [authSub, key, blob]
  );
}

export async function fetchMemberCredential(authSub, key) {
  const { tenantId, client } = await ctx();
  const r = await client.query(
    "SELECT value_enc FROM member_credentials WHERE auth_sub = $1 AND key = $2",
    [authSub, key]
  );
  if (r.rows.length === 0) throw new Error(`Member credential not found: ${key}`);
  return decryptMemberValue(r.rows[0].value_enc, deriveMemberKey(tenantId, authSub));
}

export async function hasMemberCredential(authSub, key) {
  try {
    await fetchMemberCredential(authSub, key);
    return true;
  } catch {
    // KNOWN CONFLATION (audit 2.4.27): absence and infrastructure
    // failure both answer false here. Absence is the common path,
    // so logging would flood; separating them needs typed not-found
    // errors from the fetch layer (backlogged). Until then a DB
    // outage reads as "not connected" on this probe.
    return false;
  }
}

// Disconnect wipes EVERY secret the member ever stored (FR-P2-02).
export async function deleteAllMemberCredentials(authSub) {
  const { client } = await ctx();
  const r = await client.query(
    "DELETE FROM member_credentials WHERE auth_sub = $1",
    [authSub]
  );
  return r.rowCount || 0;
}
