// =================================================================
// Subscription lifecycle (2.3.3): the state machine.
//
//   trialing --payment_succeeded--> active
//   trialing --payment_failed-----> past_due
//   active ---payment_succeeded---> active (period advances,
//                                   pending_tier applied: ruling 4)
//   active ---payment_failed------> past_due
//   past_due -payment_succeeded---> active
//   past_due -dunning_exhausted---> suspended
//   any ------subscription_cancelled-> cancelled
//   (none|cancelled) -checkout_completed-> trialing|active
//
// transition() is PURE and testable DB-free. Comp subscriptions
// refuse every provider event: comp is processor-free by design
// and only the platform-admin revoke path changes it. Import
// discipline: DB modules arrive lazily.
// =================================================================

import { TIERS, getTrialDays, getCycleDays, trialEligible } from "../config/entitlements.js";

function days(n) { return n * 24 * 60 * 60 * 1000; }

async function db() {
  const { query } = await import("../db/pool.js");
  return query;
}

// Pure adjudication: (sub row | null, normalized event, now Date)
// -> { next } | { invalid }
export function transition(sub, event, now = new Date()) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return { invalid: "malformed event" };
  }
  if (sub && sub.comp === true) {
    return { invalid: "comp subscriptions ignore provider events" };
  }
  const state = sub ? sub.state : "none";

  if (event.type === "checkout_completed") {
    if (sub && !["cancelled"].includes(state)) return { invalid: `checkout with subscription ${state}` };
    if (typeof event.tier !== "string" || !TIERS.includes(event.tier)) return { invalid: "unknown tier" };
    const trial = event.trial === true && trialEligible(event.tier);
    const end = new Date(now.getTime() + days(trial ? getTrialDays() : getCycleDays()));
    return { next: { state: trial ? "trialing" : "active", tier: event.tier, pending_tier: null,
                     period_start: now, period_end: end } };
  }

  if (!sub) return { invalid: "event for tenant with no subscription" };

  switch (event.type) {
    case "payment_succeeded": {
      if (!["trialing", "active", "past_due"].includes(state)) return { invalid: `payment in ${state}` };
      const tier = sub.pending_tier && TIERS.includes(sub.pending_tier) ? sub.pending_tier : sub.tier;
      const base = sub.period_end && new Date(sub.period_end) > now ? new Date(sub.period_end) : now;
      return { next: { state: "active", tier, pending_tier: null,
                       period_start: base, period_end: new Date(base.getTime() + days(getCycleDays())) } };
    }
    case "payment_failed": {
      if (!["trialing", "active"].includes(state)) return { invalid: `payment failure in ${state}` };
      return { next: { state: "past_due", tier: sub.tier, pending_tier: sub.pending_tier,
                       period_start: sub.period_start, period_end: sub.period_end } };
    }
    case "dunning_exhausted": {
      if (state !== "past_due") return { invalid: `dunning exhaustion in ${state}` };
      return { next: { state: "suspended", tier: sub.tier, pending_tier: null,
                       period_start: sub.period_start, period_end: sub.period_end } };
    }
    case "subscription_cancelled": {
      if (state === "cancelled") return { invalid: "already cancelled" };
      return { next: { state: "cancelled", tier: sub.tier, pending_tier: null,
                       period_start: sub.period_start, period_end: sub.period_end } };
    }
    default:
      return { invalid: `unknown event type ${event.type}` };
  }
}

// Applies a normalized event: replay-safe, race-guarded, audited.
export async function applyEvent(event, providerName) {
  // AUDIT F7 (2.4.2): the read, the transition, and BOTH writes
  // are one transaction with the subscription row locked. Before
  // this, an audit-insert failure AFTER the state update meant the
  // provider retried an event whose ref was never recorded, and a
  // renewal could apply twice. Now the whole unit lands or none of
  // it does, and a duplicate-ref violation rolls back to the same
  // answer a replay gets.
  const { pool } = await import("../db/pool.js");
  const { platformLog } = await import("./platform-log.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (event.providerEventRef) {
      const { rows } = await client.query(
        `SELECT 1 FROM payment_events WHERE provider_event_ref = $1`, [event.providerEventRef]);
      if (rows.length > 0) { await client.query("ROLLBACK"); return { duplicate: true }; }
    }

    // Row lock: concurrent events for one tenant serialize here.
    const { rows: subRows } = await client.query(
      `SELECT tenant_id, tier, state, comp, pending_tier, period_start, period_end
         FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`,
      [event.tenantId]);
    const sub = subRows[0] || null;

    const verdict = transition(sub, event);
    if (verdict.invalid) {
      await client.query(
        `INSERT INTO payment_events (tenant_id, provider, provider_event_ref, event_type, prev_state, next_state, detail, occurred_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
        [event.tenantId, providerName, event.providerEventRef, event.type,
         sub ? sub.state : "none", `refused: ${verdict.invalid}`, event.occurredAt]);
      await client.query("COMMIT");
      platformLog("warn", "payment_event_refused", { tenantId: event.tenantId, type: event.type, reason: verdict.invalid });
      return { refused: verdict.invalid };
    }

    const n = verdict.next;
    let changed;
    if (!sub) {
      const { rowCount } = await client.query(
        `INSERT INTO subscriptions (tenant_id, tier, state, comp, pending_tier, period_start, period_end, provider)
         VALUES ($1, $2, $3, false, NULL, $4, $5, $6)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [event.tenantId, n.tier, n.state, n.period_start, n.period_end, providerName]);
      changed = rowCount === 1;
    } else {
      const { rowCount } = await client.query(
        `UPDATE subscriptions
            SET tier = $2, state = $3, pending_tier = $4, period_start = $5, period_end = $6,
                provider = COALESCE($7, provider), updated_at = now()
          WHERE tenant_id = $1 AND state = $8`,
        [event.tenantId, n.tier, n.state, n.pending_tier, n.period_start, n.period_end, providerName, sub.state]);
      changed = rowCount === 1;
    }
    if (!changed) {
      await client.query("ROLLBACK");
      platformLog("warn", "payment_event_raced", { tenantId: event.tenantId, type: event.type });
      return { raced: true };
    }
    await client.query(
      `INSERT INTO payment_events (tenant_id, provider, provider_event_ref, event_type, prev_state, next_state, tier, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [event.tenantId, providerName, event.providerEventRef, event.type,
       sub ? sub.state : "none", n.state, n.tier, event.occurredAt]);
    await client.query("COMMIT");
    platformLog("info", "subscription_transition", {
      tenantId: event.tenantId, from: sub ? sub.state : "none", to: n.state, tier: n.tier, type: event.type
    });
    return { ok: true, state: n.state, tier: n.tier };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
    // A unique violation on the ref means a concurrent duplicate
    // won the race: same outcome as a replay.
    if (err && err.code === "23505") return { duplicate: true };
    throw err;
  } finally {
    client.release();
  }
}

// Clock sweep for the local line: paid periods that lapsed past
// the renewal lag with no provider event become past_due. Comp
// rows (period_end NULL) and terminal states are untouched.
export async function sweepLapsedPeriods() {
  const query = await db();
  const lagHours = Number(process.env.PAYMENTS_RENEWAL_LAG_HOURS);
  const lag = Number.isFinite(lagHours) && lagHours >= 0 ? lagHours : 24;
  // AUDIT F6 (2.4.2): one UPDATE per source state so the audit
  // trail records the true prev_state; a lapsed trial is not a
  // lapsed active subscription, and the history must say which.
  let total = 0;
  for (const fromState of ["trialing", "active"]) {
    const { rows } = await query(
      `UPDATE subscriptions
          SET state = 'past_due', updated_at = now()
        WHERE comp = false
          AND state = $2
          AND period_end IS NOT NULL
          AND period_end < now() - ($1 || ' hours')::interval
        RETURNING tenant_id, tier`,
      [String(lag), fromState]);
    if (rows.length > 0) {
      const { platformLog } = await import("./platform-log.js");
      for (const r of rows) {
        await query(
          `INSERT INTO payment_events (tenant_id, provider, event_type, prev_state, next_state, tier, detail)
           VALUES ($1, 'platform', 'period_lapsed', $3, 'past_due', $2, 'renewal lag exceeded')`,
          [r.tenant_id, r.tier, fromState]);
        platformLog("warn", "subscription_period_lapsed", { tenantId: r.tenant_id, from: fromState });
      }
      total += rows.length;
    }
  }
  return total;
}
