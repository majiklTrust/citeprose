// ===============================================================
// src/tenant/self-registration-store.js - the self-service seam
// ===============================================================
// The ONLY module that writes self-service registrations (2.5.66
// data-module discipline: the route carries no SQL). One exported
// verb, one atomic statement.
//
// DISTRIBUTED-CORRECTNESS RULE (the reason this module exists):
// every eligibility predicate and the INSERT ride ONE SQL
// statement, so no request can pass a read check and then act on
// it later (no check-then-insert window WITHIN a request). The
// database, the single shared authority, adjudicates; the
// statement is the transaction.
//
// KNOWN LIMIT (review finding F6, open): one statement does not
// serialize CONCURRENT requests against each other. Under READ
// COMMITTED, two simultaneous requests can each see no live row
// and both insert. Closing this requires a database-level
// uniqueness backstop (partial unique index on lower(email) over
// live statuses) plus a named 23505 mapping here; that is a
// schema change and ships only on an explicit ruling.
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
  ROTATED: "rotated",
  ALREADY_MEMBER: "already_member",
  INVITE_PENDING: "invite_pending",
  REGISTRATION_EXISTS: "registration_exists",
  RATE_LIMITED: "rate_limited",
  RETRY: "retry"
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
 * Live-link policy, ruled for the recreated-account case:
 *   REISSUED  same subject, same live self link: the identical
 *             token returns again, so a client retry after a
 *             timeout converges instead of erroring. No row is
 *             minted; the lifetime cap is not consumed.
 *   ROTATED   a DIFFERENT subject who has verified the SAME email
 *             (account deleted and recreated, address reassigned)
 *             holds strictly sufficient authority for a fresh
 *             mint, so the stale self link is atomically expired
 *             and a new token minted IN THE SAME STATEMENT. The
 *             old token, wherever it is still remembered, dies.
 *             Rotation mints a row and therefore consumes the
 *             lifetime cap; at the cap it refuses RATE_LIMITED.
 *   REGISTRATION_EXISTS  only for ADMIN-issued live links, which
 *             may carry provisioning intent (an encrypted key)
 *             and are never re-routed through self-service. The
 *             adjudicating row is chosen admin-first, so a live
 *             admin link takes precedence over any coexisting
 *             self link regardless of expiry order. The 'self:'
 *             provenance prefix is reserved: subjects arriving
 *             with it are refused before any SQL.
 *   RETRY     the rotation race loser (two sessions, same email,
 *             same instant): the statement updated zero rows, so
 *             nothing was minted; the caller simply tries again
 *             and converges on the winner's link.
 */
export async function attemptSelfRegistration(email, sub, deps = {}) {
  const q = deps.query || defaultQuery;
  // Defense in depth: 'self:' is this module's reserved provenance
  // namespace. No IDP issues such subjects; one arriving here is
  // forged input and is refused before any SQL runs.
  if (typeof sub !== "string" || sub.length === 0 || sub.startsWith("self:")) {
    throw new Error("self-registration requires a non-reserved IDP subject");
  }
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
       -- F2 resolution: admin-issued links sort FIRST (false sorts
       -- before true), so a live admin link ALWAYS wins
       -- adjudication and can never be shadowed out of the verdict
       -- by a longer-lived self link. The policy "admin links are
       -- never re-routed" is now structural, not an accident of
       -- equal TTLs.
       SELECT id, token, invited_by_sub, expires_at
         FROM tenant_registrations
        WHERE lower(email) = lower($1)
          AND status IN ('pending', 'active')
          AND expires_at > now()
        ORDER BY (invited_by_sub LIKE 'self:%') ASC, expires_at DESC
        LIMIT 1
     ),
     minted AS (
       SELECT count(*)::int AS n FROM tenant_registrations
        WHERE invited_by_sub = $3
     ),
     rot AS (
       UPDATE tenant_registrations
          SET status = 'expired', api_key_enc = NULL
        WHERE id = (SELECT id FROM live_reg
                     WHERE invited_by_sub LIKE 'self:%'
                       AND invited_by_sub <> $3)
          AND status IN ('pending', 'active')
          AND NOT EXISTS (SELECT 1 FROM me)
          AND NOT EXISTS (SELECT 1 FROM pending_invite)
          AND (SELECT n FROM minted) < $6
       RETURNING id
     ),
     ins AS (
       INSERT INTO tenant_registrations (token, email, invited_by_sub, expires_at)
       SELECT $4, lower($1), $3, now() + ($5 || ' minutes')::interval
        WHERE NOT EXISTS (SELECT 1 FROM me)
          AND NOT EXISTS (SELECT 1 FROM pending_invite)
          AND (SELECT n FROM minted) < $6
          AND (NOT EXISTS (SELECT 1 FROM live_reg)
               OR EXISTS (SELECT 1 FROM rot))
       RETURNING token, expires_at
     )
     SELECT
       EXISTS (SELECT 1 FROM me)             AS already_member,
       EXISTS (SELECT 1 FROM pending_invite) AS invite_pending,
       (SELECT token FROM live_reg)          AS live_token,
       (SELECT invited_by_sub FROM live_reg) AS live_invited_by,
       (SELECT expires_at FROM live_reg)     AS live_expires_at,
       EXISTS (SELECT 1 FROM rot)            AS rotated,
       (SELECT n FROM minted)                AS minted_count,
       (SELECT token FROM ins)               AS created_token,
       (SELECT expires_at FROM ins)          AS created_expires_at`,
    [email, sub, invitedBy, token, ttl, cap]
  );

  const r = rows[0];
  if (!r) throw new Error("self-registration adjudication returned no verdict row");

  if (r.created_token) {
    const outcome = r.rotated ? SELF_REG_OUTCOME.ROTATED : SELF_REG_OUTCOME.CREATED;
    return { outcome, token: r.created_token, expiresAt: r.created_expires_at };
  }
  if (r.already_member) {
    return { outcome: SELF_REG_OUTCOME.ALREADY_MEMBER, token: null, expiresAt: null };
  }
  if (r.invite_pending) {
    return { outcome: SELF_REG_OUTCOME.INVITE_PENDING, token: null, expiresAt: null };
  }
  if (r.live_token) {
    if (r.live_invited_by === invitedBy) {
      // Same subject: pure idempotency, nothing minted, cap untouched.
      return { outcome: SELF_REG_OUTCOME.REISSUED, token: r.live_token, expiresAt: r.live_expires_at };
    }
    if (typeof r.live_invited_by === "string" && r.live_invited_by.startsWith("self:")) {
      // A rotatable link existed but nothing was minted: either the
      // lifetime cap refused the rotation, or a concurrent rotation
      // won the row. Both are named states, never a silent fallback.
      if (typeof r.minted_count === "number" && r.minted_count >= cap) {
        return { outcome: SELF_REG_OUTCOME.RATE_LIMITED, token: null, expiresAt: null };
      }
      return { outcome: SELF_REG_OUTCOME.RETRY, token: null, expiresAt: null };
    }
    // Not self-provenance: an ADMIN-issued live link, never re-routed.
    return { outcome: SELF_REG_OUTCOME.REGISTRATION_EXISTS, token: null, expiresAt: null };
  }
  if (typeof r.minted_count === "number" && r.minted_count >= cap) {
    return { outcome: SELF_REG_OUTCOME.RATE_LIMITED, token: null, expiresAt: null };
  }
  // Every branch above is a named database state; anything else is
  // an invariant violation and must be loud, never a silent allow.
  throw new Error("self-registration adjudication reached an unmapped state");
}
