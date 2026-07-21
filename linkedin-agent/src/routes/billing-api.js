// =================================================================
// src/routes/billing-api.js - the owner billing surface (2.3.5)
// =================================================================
// Router-level middleware: requireAuth -> resolveTenant ->
// requirePermission("manage_billing") (owner-exclusive, ruling 5).
// Mounted at /api/billing, which the suspended write guard exempts
// by design: a suspended owner must always reach reactivation.
// Import discipline: DB modules arrive lazily.
// =================================================================

import express from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
// 2.4.7: these two bindings live in separate modules; there is no
// tenant/middleware.js. Import shape matches every other router.
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { TIERS } from "../config/entitlements.js";

export default function createBillingRoutes() {
  const router = express.Router();
  const { requireAuth } = createAuthMiddleware();
  const resolveTenant = createTenantResolver();

  router.use(requireAuth);
  router.use(resolveTenant);
  router.use(requirePermission("manage_billing"));

  // ── The subscription, honestly ───────────────────────────────
  router.get("/", async (req, res) => {
    try {
      const { getSubscription } = await import("../services/entitlements.js");
      const { tierCapabilities } = await import("../config/entitlements.js");
      const sub = await getSubscription(req.tenant.id);
      if (!sub) {
        return res.json({ state: "none", tiers: TIERS,
          checkout: getCheckoutLinks(req.tenant.id, req.user && req.user.email ? req.user.email : null) });
      }
      res.json({
        checkout: getCheckoutLinks(req.tenant.id, req.user && req.user.email ? req.user.email : null),
        state: sub.state, tier: sub.tier, comp: sub.comp === true,
        pendingTier: sub.pending_tier || null,
        periodStart: sub.period_start, periodEnd: sub.period_end,
        capabilities: tierCapabilities(sub.tier), tiers: TIERS
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to load the subscription" });
    }
  });

  // ── Tier change: next cycle, per ruling (4) ──────────────────
  router.post("/change-tier", async (req, res) => {
    try {
      const tier = req.body && req.body.tier;
      if (!TIERS.includes(tier)) return res.status(400).json({ error: "Choose a valid tier" });
      const { getSubscription } = await import("../services/entitlements.js");
      const sub = await getSubscription(req.tenant.id);
      if (!sub) return res.status(400).json({ error: "No subscription to change" });
      if (sub.comp) return res.status(400).json({ error: "Complimentary subscriptions are managed by the platform" });
      if (!["trialing", "active", "past_due"].includes(sub.state)) {
        return res.status(400).json({ error: "Tier changes need a live subscription" });
      }
      if (tier === sub.tier) return res.status(400).json({ error: "That is already the current tier" });
      const { query } = await import("../db/pool.js");
      await query(
        `UPDATE subscriptions SET pending_tier = $2, updated_at = now() WHERE tenant_id = $1`,
        [req.tenant.id, tier]);
      const { platformLog } = await import("../services/platform-log.js");
      platformLog("info", "billing_tier_change_requested", { tenantId: req.tenant.id, from: sub.tier, to: tier, by: req.user.sub });
      res.json({ ok: true, currentTier: sub.tier, pendingTier: tier,
                 effective: "next renewal" });
    } catch (err) {
      res.status(500).json({ error: "Tier change failed" });
    }
  });

  // ── Reactivation: honest until checkout exists ───────────────
  // ═════════════════════════════════════════════════════════════
// Stripe Payment Links (2.4.24). Dashboard-created, env-carried,
// zero SDK. The server appends client_reference_id (the tenant)
// so the adapter's tenant chain resolves it from the checkout
// event; the LINK's own metadata must carry tier (and trial
// where the grace period applies): the adapter reads only event
// metadata, never product metadata. Fail-closed: no env, no link.
// ═════════════════════════════════════════════════════════════
function getPaymentLinkForTier(tier) {
  const map = {
    individual: process.env.STRIPE_PAYMENT_LINK_INDIVIDUAL,
    business: process.env.STRIPE_PAYMENT_LINK_BUSINESS,
    business_plus: process.env.STRIPE_PAYMENT_LINK_BUSINESS_PLUS,
    business_premium: process.env.STRIPE_PAYMENT_LINK_BUSINESS_PREMIUM
  };
  const raw = map[tier];
  if (!raw || typeof raw !== "string" || !raw.startsWith("https://")) return null;
  return raw;
}

function getCheckoutLinks(tenantId, email) {
  if ((process.env.PAYMENTS_PROVIDER || "local").trim() !== "stripe") return null;
  const links = {};
  for (const tier of TIERS) {
    const base = getPaymentLinkForTier(tier);
    if (!base) continue;
    let url = base + (base.includes("?") ? "&" : "?")
      + "client_reference_id=" + encodeURIComponent(tenantId);
    if (email) url += "&prefilled_email=" + encodeURIComponent(email);
    links[tier] = url;
  }
  return Object.keys(links).length > 0 ? links : null;
}

router.post("/reactivate", async (req, res) => {
    try {
      const { getSubscription } = await import("../services/entitlements.js");
      const sub = await getSubscription(req.tenant.id);
      if (!sub || sub.state !== "suspended") {
        return res.status(400).json({ error: "Only a suspended subscription can reactivate" });
      }
      // 2.4.24: checkout is live via Payment Links. Reactivation is
      // a fresh checkout on the tenant's current tier; fail-closed
      // to the honest 409 when links are not configured.
      const checkoutUrl = getCheckoutLinks(req.tenant.id,
        req.user && req.user.email ? req.user.email : null);
      const url = checkoutUrl ? checkoutUrl[sub.tier] || null : null;
      if (url) return res.json({ ok: true, checkoutUrl: url });
      return res.status(409).json({
        error: "Checkout is not yet available. Reactivation opens when billing goes live.",
        code: "CHECKOUT_UNAVAILABLE"
      });
    } catch (err) {
      res.status(500).json({ error: "Reactivation failed" });
    }
  });

  return router;
}
