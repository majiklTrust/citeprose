// ═══════════════════════════════════════════════════════════════
// trial-store.js - the ONLY module touching trial_keys and
// trial_key_activations, and the only one decrypting trial ciphertext
// (platform-secret scheme: trial keys are PLATFORM property, never
// the tenant vault). Caps are ledger sums via the SECURITY DEFINER
// aggregates; there is no counter to drift.
// ═══════════════════════════════════════════════════════════════
import { createHash } from "node:crypto";
import { pool } from "../db/pool.js";
import { encryptPlatformSecret, decryptPlatformSecret } from "../services/platform-secret.js";

export function keyFingerprint(material) {
  return createHash("sha256").update(String(material)).digest("hex").slice(0, 16);
}

// Runtime resolution for the key-resolver chain. Returns null when no
// active in-window grant exists; returns { refused, code } when a
// grant EXISTS but its caps or window refuse: precedence with no
// silent fallback, per the standing ruling default.
export async function resolveActiveTrial(tenantId, providerId, deps = {}) {
  const q = deps.query || ((sql, params) => pool.query(sql, params));
  const now = deps.now ? deps.now() : new Date();
  const r = await q(
    `SELECT ta.id AS activation_id, ta.max_spend_usd AS activation_cap,
            k.id AS key_id, k.key_ciphertext, k.key_fingerprint,
            k.max_spend_usd AS key_cap, k.starts_at, k.ends_at, k.active AS key_active
     FROM trial_key_activations ta
     JOIN trial_keys k ON k.id = ta.trial_key_id
     WHERE ta.tenant_id = $1 AND ta.active AND k.provider = $2
     ORDER BY ta.activated_at DESC LIMIT 1`,
    [tenantId, providerId]
  );
  if (r.rows.length === 0) return null;
  const t = r.rows[0];
  if (!t.key_active) return { refused: true, code: "TRIAL_REVOKED" };
  if (now < new Date(t.starts_at) || now > new Date(t.ends_at)) return { refused: true, code: "TRIAL_EXPIRED" };
  const actSpent = Number((await q(`SELECT trial_activation_spend_usd($1) AS s`, [t.activation_id])).rows[0].s);
  if (t.activation_cap !== null && actSpent >= Number(t.activation_cap)) return { refused: true, code: "TRIAL_EXHAUSTED" };
  const keySpent = Number((await q(`SELECT trial_key_spend_usd($1) AS s`, [t.key_id])).rows[0].s);
  if (keySpent >= Number(t.key_cap)) return { refused: true, code: "TRIAL_EXHAUSTED" };
  // Newest-wins when an admin has granted multiple keys for one
  // provider (unique index is per key+tenant, not per provider).
  let apiKey;
  try {
    apiKey = (deps.decrypt || decryptPlatformSecret)(t.key_ciphertext);
  } catch (e) {
    throw new Error("trial key ciphertext failed decryption (rotated ENCRYPTION_SECRET?): " + (e && e.message));
  }
  return {
    apiKey,
    keyFingerprint: t.key_fingerprint,
    trialActivationId: Number(t.activation_id)
  };
}

// ── platform-admin write helpers (routes gate + audit) ─────────
export async function createTrialKey({ provider, name, apiKey, maxSpendUsd, startsAt, endsAt, createdBy }, deps = {}) {
  const q = deps.query || ((sql, params) => pool.query(sql, params));
  const enc = deps.encrypt || encryptPlatformSecret;
  const r = await q(
    `INSERT INTO trial_keys (provider, name, key_ciphertext, key_fingerprint, max_spend_usd, starts_at, ends_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [provider, name, enc(apiKey), keyFingerprint(apiKey), maxSpendUsd, startsAt, endsAt, createdBy]
  );
  return { id: Number(r.rows[0].id) };
}

export async function listTrialKeys(deps = {}) {
  const q = deps.query || ((sql, params) => pool.query(sql, params));
  const r = await q(
    `SELECT k.id, k.provider::text, k.name, k.key_fingerprint, k.max_spend_usd, k.starts_at, k.ends_at,
            k.active, k.created_at, k.revoked_at,
            trial_key_spend_usd(k.id) AS spent_usd,
            (SELECT COUNT(*)::int FROM trial_key_activations ta WHERE ta.trial_key_id = k.id AND ta.active) AS active_grants
     FROM trial_keys k ORDER BY k.created_at DESC`, []
  );
  return r.rows;
}

export async function setTrialKeyActive(id, active, actorSub, deps = {}) {
  const q = deps.query || ((sql, params) => pool.query(sql, params));
  await q(
    `UPDATE trial_keys SET active = $2, revoked_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE id = $1`,
    [id, !!active]
  );
  return { id, active: !!active, by: actorSub };
}

export async function activateForTenant({ trialKeyId, tenantId, maxSpendUsd, activatedBy }, deps = {}) {
  const q = deps.query || ((sql, params) => pool.query(sql, params));
  const r = await q(
    `INSERT INTO trial_key_activations (trial_key_id, tenant_id, max_spend_usd, activated_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [trialKeyId, tenantId, maxSpendUsd ?? null, activatedBy]
  );
  return { id: Number(r.rows[0].id) };
}

export async function deactivateActivation(activationId, actorSub, deps = {}) {
  const q = deps.query || ((sql, params) => pool.query(sql, params));
  await q(
    `UPDATE trial_key_activations SET active = false, deactivated_by = $2, deactivated_at = now() WHERE id = $1`,
    [activationId, actorSub]
  );
  return { id: activationId, by: actorSub };
}

// Auto-deactivation: a tenant storing their OWN key for a provider
// immediately retires any active trial grant for that pair. The
// tenant's key then has precedence until a NEW trial is assigned.
export async function deactivateForTenantProvider(tenantId, providerId, actorSub, deps = {}) {
  const q = deps.query || ((sql, params) => pool.query(sql, params));
  const r = await q(
    `UPDATE trial_key_activations ta
     SET active = false, deactivated_by = $3, deactivated_at = now()
     FROM trial_keys k
     WHERE k.id = ta.trial_key_id AND ta.tenant_id = $1 AND k.provider = $2 AND ta.active
     RETURNING ta.id`,
    [tenantId, providerId, actorSub]
  );
  return { deactivated: r.rows.map((x) => Number(x.id)) };
}
