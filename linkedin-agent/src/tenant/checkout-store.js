// ═══════════════════════════════════════════════════════════════
// checkout-store.js: the ONLY module touching registration_checkouts
// ═══════════════════════════════════════════════════════════════
// 4.25111.78. A purchase that starts on the public pricing page has
// no workspace to attach to yet. The row here is the pre-payment
// identity: keyed to the buyer's self-registration and login, its id
// is the client_reference_id the Payment Link carries to Stripe.
//
//   openCheckout       the door: one open row per registration; a
//                      second Purchase click changes the tier on it.
//   findById           the processor's message names the row by id.
//   findBySubscription later processor messages (renewal invoices)
//                      carry only the Stripe subscription.
//   findOpenForLogin   the return page and the register page find
//                      the buyer's purchase by login.
//   findForRegistration the register page's completion finds it by
//                      registration first.
//   liveTokenForRegistration the return page needs the token that
//                      opens the register page (read-only on
//                      tenant_registrations).
//   setSession         4.25111.82: the Checkout Session the server
//                      minted for this row (the latest; an earlier one
//                      is expired at the processor when re-tiering).
//   markPaid           checkout_completed: paid_event_ref is unique,
//                      so a replayed message updates nothing.
//   bindTenant         the register page created the workspace
//                      before the processor spoke; the row remembers
//                      the tenant so the message takes the tenant path.
//   markApplied        the subscription exists on the tenant.
//   markSettled        the message came after the workspace: the
//                      tenant path wrote the subscription; close the row.
//
// Platform table: no tenant scope, plain pool queries, no DELETE.
// ═══════════════════════════════════════════════════════════════
import { pool } from "../db/pool.js";

const q = (deps) => deps.query || ((sql, params) => pool.query(sql, params));

const COLUMNS = `id, registration_id, auth_sub, email, tier, status, provider, paid_event_ref, paid_tier, paid_trial,
  provider_customer_ref, provider_subscription_ref, provider_session_ref, occurred_at, paid_at, tenant_id, applied_at,
  created_at, updated_at`;

export async function openCheckout({ registrationId, authSub, email, tier }, deps = {}) {
  // The partial unique index (one open row per registration) makes
  // the UPDATE-then-INSERT race-safe: a concurrent second click hits
  // the index and is answered by the re-read below.
  const upd = await q(deps)(
    `UPDATE registration_checkouts
        SET tier = $2, updated_at = now()
      WHERE registration_id = $1 AND status = 'started'
      RETURNING ${COLUMNS}`,
    [registrationId, tier]
  );
  if (upd.rows.length) return upd.rows[0];
  const paid = await q(deps)(
    `SELECT ${COLUMNS} FROM registration_checkouts WHERE registration_id = $1 AND status = 'paid' LIMIT 1`,
    [registrationId]
  );
  if (paid.rows.length) return paid.rows[0];
  try {
    const ins = await q(deps)(
      `INSERT INTO registration_checkouts (registration_id, auth_sub, email, tier)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [registrationId, authSub, email, tier]
    );
    return ins.rows[0];
  } catch (err) {
    if (err && err.code === "23505") {
      const again = await q(deps)(
        `SELECT ${COLUMNS} FROM registration_checkouts
          WHERE registration_id = $1 AND status IN ('started', 'paid')
          ORDER BY created_at DESC LIMIT 1`,
        [registrationId]
      );
      if (again.rows.length) return again.rows[0];
    }
    throw err;
  }
}

export async function findById(id, deps = {}) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await q(deps)(`SELECT ${COLUMNS} FROM registration_checkouts WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

export async function findBySubscription(providerSubscriptionRef, deps = {}) {
  if (typeof providerSubscriptionRef !== "string" || !providerSubscriptionRef) return null;
  const r = await q(deps)(
    `SELECT ${COLUMNS} FROM registration_checkouts
      WHERE provider_subscription_ref = $1
      ORDER BY created_at DESC LIMIT 1`,
    [providerSubscriptionRef]
  );
  return r.rows[0] || null;
}

export async function setSession(id, sessionRef, deps = {}) {
  const r = await q(deps)(
    `UPDATE registration_checkouts SET provider_session_ref = $2, updated_at = now()
      WHERE id = $1 AND status = 'started' RETURNING ${COLUMNS}`,
    [id, sessionRef]
  );
  return r.rows[0] || null;
}

export async function findOpenForLogin(authSub, deps = {}) {
  if (typeof authSub !== "string" || !authSub) return null;
  const r = await q(deps)(
    `SELECT ${COLUMNS} FROM registration_checkouts
      WHERE auth_sub = $1 AND status IN ('started', 'paid')
      ORDER BY (status = 'paid') DESC, created_at DESC LIMIT 1`,
    [authSub]
  );
  return r.rows[0] || null;
}

// The register page needs a live token for the buyer's registration
// (status pending or active, not expired). Read-only on
// tenant_registrations; the token itself is never logged.
export async function liveTokenForRegistration(registrationId, deps = {}) {
  const r = await q(deps)(
    `SELECT token FROM tenant_registrations
      WHERE id = $1 AND status IN ('pending', 'active') AND expires_at > now()`,
    [registrationId]
  );
  return r.rows.length ? r.rows[0].token : null;
}

export async function findForRegistration(registrationId, deps = {}) {
  const r = await q(deps)(
    `SELECT ${COLUMNS} FROM registration_checkouts
      WHERE registration_id = $1 AND status IN ('started', 'paid')
      ORDER BY (status = 'paid') DESC, created_at DESC LIMIT 1`,
    [registrationId]
  );
  return r.rows[0] || null;
}

// Returns the updated row, or null when the row was not in 'started'
// (already paid: a replay, or a second checkout session for the same
// registration). A duplicate paid_event_ref raises 23505, which the
// caller treats as the same replay.
export async function markPaid({ id, provider, paidEventRef, paidTier, paidTrial, providerCustomerRef, providerSubscriptionRef, occurredAt }, deps = {}) {
  const r = await q(deps)(
    `UPDATE registration_checkouts
        SET status = 'paid', provider = $2, paid_event_ref = $3, paid_tier = $4, paid_trial = $5,
            provider_customer_ref = $6, provider_subscription_ref = $7,
            occurred_at = $8, paid_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'started'
      RETURNING ${COLUMNS}`,
    [id, provider, paidEventRef, paidTier, paidTrial === true, providerCustomerRef || null, providerSubscriptionRef || null, occurredAt || null]
  );
  return r.rows[0] || null;
}

export async function bindTenant(id, tenantId, deps = {}) {
  const r = await q(deps)(
    `UPDATE registration_checkouts SET tenant_id = $2, updated_at = now()
      WHERE id = $1 AND tenant_id IS NULL RETURNING ${COLUMNS}`,
    [id, tenantId]
  );
  return r.rows[0] || null;
}

// The processor's message arrived after the register page had already
// created the workspace (the row carried tenant_id): the subscription
// was written on the tenant path, and the row closes with the facts
// of that message in one step.
export async function markSettled({ id, tenantId, provider, paidEventRef, paidTier, paidTrial, providerCustomerRef, providerSubscriptionRef, occurredAt }, deps = {}) {
  const r = await q(deps)(
    `UPDATE registration_checkouts
        SET status = 'applied', tenant_id = $2, provider = $3, paid_event_ref = COALESCE(paid_event_ref, $4),
            paid_tier = $5, paid_trial = $6, provider_customer_ref = COALESCE($7, provider_customer_ref),
            provider_subscription_ref = COALESCE($8, provider_subscription_ref),
            occurred_at = COALESCE(occurred_at, $9), paid_at = COALESCE(paid_at, now()), applied_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('started', 'paid')
      RETURNING ${COLUMNS}`,
    [id, tenantId, provider, paidEventRef, paidTier, paidTrial === true, providerCustomerRef || null, providerSubscriptionRef || null, occurredAt || null]
  );
  return r.rows[0] || null;
}

export async function markApplied(id, tenantId, deps = {}) {
  const r = await q(deps)(
    `UPDATE registration_checkouts
        SET status = 'applied', tenant_id = $2, applied_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'paid'
      RETURNING ${COLUMNS}`,
    [id, tenantId]
  );
  return r.rows[0] || null;
}
