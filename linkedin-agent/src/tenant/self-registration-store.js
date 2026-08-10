// ===============================================================
// src/tenant/self-registration-store.js - the self-service seam
// ===============================================================
// The ONLY module that writes self-service registrations (2.5.66
// data-module discipline: the route carries no SQL). One exported
// verb, one atomic statement.
//
// DISTRIBUTED-CORRECTNESS RULE (the reason this module exists):
// every eligibility predicate and the INSERT ride ONE SQL
// statement, so two concurrent requests, on one instance or on
// two instances behind the load balancer, can never both pass a
// read check and double-mint. The database, the single shared
// authority, adjudicates; the statement is the transaction.
//
// Zero Trust posture:
//   - callers pass an email and a subject the ROUTE has already
//     bound to a verified session; this module trusts neither and
//     re-checks every durable predicate inside the statement
//   - the token is minted here (crypto randomBytes), never
//     accepted from a caller
//   - no key material is ever written: the api_key_enc admin path
//     does not exist in this statement by construction
//   - outcomes are a closed enum; unknown database states surface
//     as thrown errors, never as a default-allow
//
// Outcome precedence (first match wins, mirroring the statement):
//   already_member > invite_pending > reissued/registration_exists
//   > rate_limited > created
// ===============================================================

import { randomBytes } from "node:crypto";

// Import discipline (module-loads-DB-free, the 2.5.x convention):
// the pool arrives lazily inside the default resolver, so this
// module loads in any environment and tests inject a fake query
// through deps without a database present.
async function defaultQuery(sql, params) {
  const { query } = await import("../db/pool.js");
  return query(sql, params);
}

export const SELF_REG_OUTCOME = Object.freeze({
  CREATED: "created",
  REISSUED: "reissued",
  ALREADY_MEMBER: "already_member",
  INVITE_PENDING: "invite_pending",
  REGISTRATION_EXISTS: "registration_exists",
  RATE_LIMITED: "rate_limited"
});

// Mirrors platform-db.js getRegistrationTTL (not exported there);
// same env, same default, so self and admin links age identically.
const DEFAULT_TTL_MINUTES = 15;
function getRegistrationTTL() {
  const envVal = parseInt(process.env.REGISTRATION_INVITE_TTL_MINUTES, 10);
  return envVal > 0 ? envVal : DEFAULT_TTL_MINUTES;
}

// Durable per-subject lifetime cap on self-minted registrations.
// This bound lives in the DATABASE, so it holds across instances
// and restarts (the route's in-memory counter is only a cheap
// local burst filter). Hardcoded default flagged per project
// convention; env-overridable.
const DEFAULT_MAX_SELF_REGISTRATIONS = 10;
export function getMaxSelfRegistrations() {
  const envVal = parseInt(process.env.SELF_REGISTRATION_MAX_PER_SUBJECT, 10);
  return envVal > 0 ? envVal : DEFAULT_MAX_SELF_REGISTRATIONS;
}

/**
 * Atomically evaluate eligibility and mint a self-service
 * registration for (email, subject). Single statement; no TOCTOU.
 *
 * @param {string} email - the SESSION email (route-verified)
 * @param {string} sub   - the SESSION subject (route-verified)
 * @param {object} deps  - { query } injectable for DB-free tests
 * @returns {Promise<{outcome: string, token: string|null, expiresAt: string|null}>}
 *
 * REISSUED (idempotent retry): a live registration THIS subject
 * already minted for this email returns its existing token again,
 * so a client retry after a timeout converges instead of erroring.
 * A live registration minted by anyone else (a platform admin)
 * refuses with REGISTRATION_EXISTS: an admin-issued link may carry
 * provisioning intent and is never re-routed through self-service.
 */
export async function attemptSelfRegistration(email, sub, deps = {}) {
  const q = deps.query || defaultQuery;
  const token = randomBytes(32).toString("base64url");
  const invitedBy = `self:${sub}`;
  const ttl = String(getRegistrationTTL());
  const cap = getMaxSelfRegistrations();

  const { rows } = await q(
    `WITH me AS (
       SELECT 1 FROM memberships WHERE auth_sub = $2 LIMIT 1
     ),
     pending_invite AS (
       SELECT 1 FROM invites
        WHERE lower(email) = lower($1) AND status = 'pending'::invite_status
        LIMIT 1
     ),
     live_reg AS (
       SELECT token, invited_by_sub, expires_at
         FROM tenant_registrations
        WHERE lower(email) = lower($1)
          AND status IN ('pending', 'active')
          AND expires_at > now()
        ORDER BY expires_at DESC
        LIMIT 1
     ),
     minted AS (
       SELECT count(*)::int AS n FROM tenant_registrations
        WHERE invited_by_sub = $3
     ),
     ins AS (
       INSERT INTO tenant_registrations (token, email, invited_by_sub, expires_at)
       SELECT $4, lower($1), $3, now() + ($5 || ' minutes')::interval
        WHERE NOT EXISTS (SELECT 1 FROM me)
          AND NOT EXISTS (SELECT 1 FROM pending_invite)
          AND NOT EXISTS (SELECT 1 FROM live_reg)
          AND (SELECT n FROM minted) < $6
       RETURNING token, expires_at
     )
     SELECT
       EXISTS (SELECT 1 FROM me)             AS already_member,
       EXISTS (SELECT 1 FROM pending_invite) AS invite_pending,
       (SELECT token FROM live_reg)          AS live_token,
       (SELECT invited_by_sub FROM live_reg) AS live_invited_by,
       (SELECT expires_at FROM live_reg)     AS live_expires_at,
       (SELECT n FROM minted)                AS minted_count,
       (SELECT token FROM ins)               AS created_token,
       (SELECT expires_at FROM ins)          AS created_expires_at`,
    [email, sub, invitedBy, token, ttl, cap]
  );

  const r = rows[0];
  if (!r) throw new Error("self-registration adjudication returned no verdict row");

  if (r.created_token) {
    return { outcome: SELF_REG_OUTCOME.CREATED, token: r.created_token, expiresAt: r.created_expires_at };
  }
  if (r.already_member) {
    return { outcome: SELF_REG_OUTCOME.ALREADY_MEMBER, token: null, expiresAt: null };
  }
  if (r.invite_pending) {
    return { outcome: SELF_REG_OUTCOME.INVITE_PENDING, token: null, expiresAt: null };
  }
  if (r.live_token) {
    // Idempotent convergence, but ONLY onto a link this same
    // subject minted; an admin-issued live link is not re-routed.
    if (r.live_invited_by === invitedBy) {
      return { outcome: SELF_REG_OUTCOME.REISSUED, token: r.live_token, expiresAt: r.live_expires_at };
    }
    return { outcome: SELF_REG_OUTCOME.REGISTRATION_EXISTS, token: null, expiresAt: null };
  }
  if (typeof r.minted_count === "number" && r.minted_count >= cap) {
    return { outcome: SELF_REG_OUTCOME.RATE_LIMITED, token: null, expiresAt: null };
  }
  // Every branch above is a named database state; anything else is
  // an invariant violation and must be loud, never a silent allow.
  throw new Error("self-registration adjudication reached an unmapped state");
}
