// =================================================================
// Entitlements: Payments Platform Step 1 (2.3.1.1)
// =================================================================
// The mapping from money state to capability. Fail-closed
// throughout: no subscription row, unknown state, unknown tier,
// or any read failure all evaluate to denied. The platform admin
// bypass (PLATFORM_ADMIN_SUBS) applies to the HTTP gate only;
// tenant batch processing has no user and therefore no bypass.
//
// Suspension semantics (set in stone 2026-07-14): read-only
// dashboard, mutating verbs denied, OM and Ads locked, automated
// processing halted, billing surface exempt so the owner can
// always reach the pay-and-reactivate path.
// =================================================================

// Import discipline (house precedent, see analytics-sync banner):
// DB-touching modules arrive via lazy dynamic import inside the
// functions that need them, so this module loads with no database
// environment and the pure adjudication core is testable DB-free.
import { tierCapabilities, isKnownCapability } from "../config/entitlements.js";

async function db() {
  const { query } = await import("../db/pool.js");
  return query;
}

// States in which the tenant is a member in good standing.
// past_due keeps access: it is the processor's retry window, and
// punishing a card hiccup with an outage loses customers, not
// fraudsters. Suspension is the deliberate cutoff.
const GOOD_STANDING = ["trialing", "active", "past_due"];

export async function getSubscription(tenantId) {
  const query = await db();
  const { rows } = await query(
    `SELECT tenant_id, tier, state, comp, pending_tier, period_start, period_end,
            provider, created_at, updated_at
       FROM subscriptions WHERE tenant_id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

// Pure adjudication: (subscription row | null, capability | null)
// -> { allowed, readOnly, state, reason }.
// capability null asks only about general dashboard standing.
export function evaluateAccess(sub, capability) {
  if (!sub) return { allowed: false, readOnly: false, state: "none", reason: "no subscription" };
  if (!GOOD_STANDING.includes(sub.state)) {
    return {
      allowed: false,
      readOnly: sub.state === "suspended",
      state: sub.state,
      reason: `subscription ${sub.state}`
    };
  }
  if (capability === null || capability === undefined) {
    return { allowed: true, readOnly: false, state: sub.state, reason: "in good standing" };
  }
  if (!isKnownCapability(capability)) {
    return { allowed: false, readOnly: false, state: sub.state, reason: "unknown capability" };
  }
  const allowed = tierCapabilities(sub.tier).includes(capability);
  return { allowed, readOnly: false, state: sub.state, reason: allowed ? "entitled" : "tier does not include capability" };
}

// Batch loops call this per tenant. No user, no bypass: a halted
// tenant is halted for automation regardless of who is watching.
export async function isTenantProcessingAllowed(tenantId) {
  try {
    const sub = await getSubscription(tenantId);
    return evaluateAccess(sub, null).allowed;
  } catch {
    return false;
  }
}

// HTTP gate factory. Mount AFTER resolveTenant. Platform admins
// pass per ruling (6); everyone else needs an entitled, good
// standing subscription for the named capability.
export function requireEntitlement(capability) {
  return async function entitlementGate(req, res, next) {
    try {
      if (req.user) {
        const { isPlatformAdmin } = await import("../tenant/platform-db.js");
        if (isPlatformAdmin(req.user.sub)) return next();
      }
      if (!req.tenant || !req.tenant.id) {
        return res.status(403).json({ error: "Access denied", code: "NO_TENANT" });
      }
      const sub = await getSubscription(req.tenant.id);
      const verdict = evaluateAccess(sub, capability);
      if (!verdict.allowed) {
        return res.status(402).json({
          error: "This feature requires a subscription that includes it.",
          code: "ENTITLEMENT_REQUIRED",
          state: verdict.state
        });
      }
      next();
    } catch (err) {
      // The failure handler must never depend on another module
      // loading: log best-effort, deny unconditionally.
      try {
        const { platformLog } = await import("./database.js");
        platformLog("error", "entitlement_gate_error", { error: err.message });
      } catch { console.error("[entitlements] gate error:", err.message); }
      return res.status(403).json({ error: "Access denied", code: "ENTITLEMENT_CHECK_FAILED" });
    }
  };
}

// Complimentary entitlement: the deliberate, auditable grant that
// sets tier and state with zero processor involvement. Platform
// admin surface only.
export async function grantComp(tenantId, tier) {
  const query = await db();
  const { rows } = await query(
    `INSERT INTO subscriptions (tenant_id, tier, state, comp, period_start, period_end)
     VALUES ($1, $2, 'active', true, now(), NULL)
     ON CONFLICT (tenant_id) DO UPDATE
       SET tier = $2, state = 'active', comp = true, pending_tier = NULL, updated_at = now()
     RETURNING tenant_id, tier, state, comp`,
    [tenantId, tier]
  );
  return rows[0];
}

export async function revokeComp(tenantId) {
  const query = await db();
  const { rowCount } = await query(
    `UPDATE subscriptions SET state = 'suspended', comp = false, updated_at = now()
      WHERE tenant_id = $1 AND comp = true`,
    [tenantId]
  );
  return rowCount === 1;
}

export async function listSubscriptions() {
  const query = await db();
  const { rows } = await query(
    `SELECT s.tenant_id, t.slug, t.name, s.tier, s.state, s.comp, s.pending_tier,
            s.period_start, s.period_end, s.provider
       FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
      ORDER BY t.slug`
  );
  return rows;
}

// Status-payload summary for the front end: state, the read-only
// signal, and the entitled capability list. Platform admins see a
// synthetic all-capability pass so their surfaces never wall.
export async function subscriptionStatus(tenantId, userSub) {
  const { isPlatformAdmin } = await import("../tenant/platform-db.js");
  if (userSub && isPlatformAdmin(userSub)) {
    return { state: "platform_admin", readOnly: false,
      capabilities: ["organization_manager", "ads_manager", "image_studio"] };
  }
  const sub = await getSubscription(tenantId);
  const general = evaluateAccess(sub, null);
  if (!general.allowed) {
    return { state: general.state, readOnly: general.readOnly === true, capabilities: [] };
  }
  return { state: sub.state, readOnly: false, capabilities: tierCapabilities(sub.tier) };
}

// Suspension semantics, ruling (3): read-only dashboard. Mounted
// per tenant router AFTER resolveTenant. GET/HEAD/OPTIONS pass;
// every mutating verb is denied while the tenant is outside good
// standing, EXCEPT the billing surface (/api/billing/*), which
// stays alive so the owner can always reach reactivation, never
// a lock with the key inside. Platform admins bypass per (6).
const READ_METHODS = ["GET", "HEAD", "OPTIONS"];

export function suspendedWriteGuard() {
  return async function suspendedGate(req, res, next) {
    try {
      if (READ_METHODS.includes(req.method)) return next();
      if (req.baseUrl === "/api/billing" || (req.baseUrl && req.baseUrl.startsWith("/api/billing/"))) return next();
      // Bypass lookup only when a user exists to bypass: keeps the
      // structural checks import-free.
      if (req.user) {
        const { isPlatformAdmin } = await import("../tenant/platform-db.js");
        if (isPlatformAdmin(req.user.sub)) return next();
      }
      if (!req.tenant || !req.tenant.id) {
        return res.status(403).json({ error: "Access denied", code: "NO_TENANT" });
      }
      const sub = await getSubscription(req.tenant.id);
      const verdict = evaluateAccess(sub, null);
      if (!verdict.allowed) {
        return res.status(402).json({
          error: "This workspace is read-only until its subscription is active.",
          code: "SUBSCRIPTION_READ_ONLY",
          state: verdict.state
        });
      }
      next();
    } catch (err) {
      try {
        const { platformLog } = await import("./database.js");
        platformLog("error", "suspended_guard_error", { error: err.message });
      } catch { console.error("[entitlements] suspended guard error:", err.message); }
      return res.status(403).json({ error: "Access denied", code: "SUBSCRIPTION_CHECK_FAILED" });
    }
  };
}
