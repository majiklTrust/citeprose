// ═══════════════════════════════════════════════════════════════
// purchase-settlement.js: a sale that begins before its workspace
// ═══════════════════════════════════════════════════════════════
// 4.25111.78. The subscription lifecycle (subscription-lifecycle.js)
// applies processor events to a tenant. The public pricing page
// sells to people who have no tenant yet, so a sale can arrive
// naming a purchase row (registration_checkouts, checkout-store.js)
// instead. This module is the seam between the two:
//
//   resolveEventSubject  what a processor message is about: a tenant
//                        (by id, or by the Stripe subscription it
//                        names), a purchase row that has no tenant
//                        yet, or nothing we know (ignored, logged).
//   applyToCheckout      checkout_completed for a purchase row: mark
//                        it paid with the tier actually charged and
//                        the Stripe customer and subscription refs.
//                        Any other message for a row without a tenant
//                        is ignored: the workspace does not exist yet.
//   settlePurchaseForRegistration
//                        the register page created the workspace.
//                        A paid row becomes the tenant's subscription
//                        now, in one transaction with its audit row;
//                        an unpaid row is bound to the tenant so the
//                        processor's later message takes the tenant
//                        path; no row means an ordinary registration.
//
// Both orders of arrival converge on the same tenant, subscription
// and payment_events rows. Nothing here trusts the browser: every
// fact comes from the signed processor message or from the row the
// door wrote. Import discipline as the lifecycle: DB modules arrive
// lazily so the pure transition stays importable anywhere.
// ═══════════════════════════════════════════════════════════════
import { TIERS } from "../config/entitlements.js";
import { transition } from "./subscription-lifecycle.js";

const BILLING_PAGE = "/app/billing";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function deps() {
  const { pool } = await import("../db/pool.js");
  const { platformLog } = await import("./platform-log.js");
  const store = await import("../tenant/checkout-store.js");
  return { pool, platformLog, store };
}

export async function resolveEventSubject(event) {
  const { pool, store } = await deps();
  if (event && typeof event.tenantId === "string" && UUID_SHAPE.test(event.tenantId)) {
    const t = await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [event.tenantId]);
    if (t.rows.length) return { kind: "tenant", tenantId: event.tenantId };
    const row = await store.findById(event.tenantId);
    if (row) return row.tenant_id ? { kind: "tenant", tenantId: row.tenant_id, checkout: row } : { kind: "checkout", row };
    return { ignored: true, reason: "unknown client reference" };
  }
  const ref = event && typeof event.providerSubscriptionRef === "string" ? event.providerSubscriptionRef : null;
  if (ref) {
    const s = await pool.query(`SELECT tenant_id FROM subscriptions WHERE provider_subscription_ref = $1 LIMIT 1`, [ref]);
    if (s.rows.length) return { kind: "tenant", tenantId: s.rows[0].tenant_id };
    const row = await store.findBySubscription(ref);
    if (row) return row.tenant_id ? { kind: "tenant", tenantId: row.tenant_id, checkout: row } : { kind: "checkout", row };
    return { ignored: true, reason: "unknown subscription reference" };
  }
  return { ignored: true, reason: "no tenant mapping" };
}

export async function applyToCheckout(row, event, providerName) {
  const { platformLog, store } = await deps();
  if (event.type !== "checkout_completed") {
    platformLog("info", "payment_event_before_workspace", { checkoutId: row.id, type: event.type });
    return { ignored: true, reason: "workspace not created yet" };
  }
  if (typeof event.tier !== "string" || !TIERS.includes(event.tier)) {
    platformLog("warn", "payment_event_refused", { checkoutId: row.id, type: event.type, reason: "unknown tier" });
    return { refused: "unknown tier" };
  }
  let paid;
  try {
    paid = await store.markPaid({
      id: row.id, provider: providerName, paidEventRef: event.providerEventRef, paidTier: event.tier,
      paidTrial: event.trial === true, providerCustomerRef: event.providerCustomerRef,
      providerSubscriptionRef: event.providerSubscriptionRef, occurredAt: event.occurredAt
    });
  } catch (err) {
    if (err && err.code === "23505") return { duplicate: true };
    throw err;
  }
  if (!paid) return { duplicate: true };
  platformLog("info", "checkout_paid_pending_workspace", {
    checkoutId: row.id, registrationId: row.registration_id, tier: event.tier, sub: row.auth_sub
  });
  return { ok: true, pending: true };
}

// Called by the register page's completion with the registration row
// and the tenant it just created. Never throws into registration; a
// failure is logged and the subscription can still arrive through the
// processor's message (the row keeps its tenant binding).
export async function settlePurchaseForRegistration(reg, tenantId) {
  const { platformLog, store } = await deps();
  let row = await store.findForRegistration(reg.id);
  if (!row && typeof reg.invited_by_sub === "string" && reg.invited_by_sub.startsWith("self:")) {
    row = await store.findOpenForLogin(reg.invited_by_sub.slice(5));
  }
  if (!row) return { landing: null };
  if (row.status === "started") {
    await store.bindTenant(row.id, tenantId);
    platformLog("info", "checkout_bound_to_tenant", { checkoutId: row.id, tenantId });
    return { landing: BILLING_PAGE, pending: true };
  }
  const out = await attachPaidCheckout(row, tenantId);
  return { landing: BILLING_PAGE, ...out };
}

async function attachPaidCheckout(row, tenantId) {
  const { pool, platformLog, store } = await deps();
  const at = row.occurred_at ? new Date(row.occurred_at) : new Date();
  const verdict = transition(null, { type: "checkout_completed", tier: row.paid_tier, trial: row.paid_trial === true }, at);
  if (verdict.invalid) {
    platformLog("error", "checkout_attach_refused", { checkoutId: row.id, tenantId, reason: verdict.invalid });
    return { applied: false, reason: verdict.invalid };
  }
  const n = verdict.next;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO subscriptions (tenant_id, tier, state, comp, pending_tier, period_start, period_end, provider,
                                  provider_customer_ref, provider_subscription_ref)
       VALUES ($1, $2, $3, false, NULL, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, n.tier, n.state, n.period_start, n.period_end, row.provider, row.provider_customer_ref, row.provider_subscription_ref]);
    if (ins.rowCount === 1) {
      await client.query(
        `INSERT INTO payment_events (tenant_id, provider, provider_event_ref, event_type, prev_state, next_state, tier, occurred_at)
         VALUES ($1, $2, $3, 'checkout_completed', 'none', $4, $5, $6)
         ON CONFLICT (provider_event_ref) DO NOTHING`,
        [tenantId, row.provider, row.paid_event_ref, n.state, n.tier, row.occurred_at]);
    }
    await store.markApplied(row.id, tenantId, { query: (sql, params) => client.query(sql, params) });
    await client.query("COMMIT");
    if (ins.rowCount === 1) {
      platformLog("info", "subscription_transition", { tenantId, from: "none", to: n.state, tier: n.tier, type: "checkout_completed", via: "registration" });
    } else {
      platformLog("warn", "checkout_attach_found_subscription", { checkoutId: row.id, tenantId });
    }
    return { applied: ins.rowCount === 1, state: n.state, tier: n.tier };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
    platformLog("error", "checkout_attach_failed", { checkoutId: row.id, tenantId, error: err && err.message });
    return { applied: false, reason: "failed" };
  } finally {
    client.release();
  }
}
