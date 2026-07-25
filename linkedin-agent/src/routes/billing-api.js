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
import { getCheckoutLinksForTenant } from "../payments/checkout-links.js";
import { getCatalogForDisplay } from "../payments/catalog.js";
import { getPaymentsProviderName } from "../payments/provider.js";
import { getFreshCheckoutAllowed, getTierChangeEnabled, getReactivationTier } from "../services/billing-policy.js";

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
      const userEmail = req.user && req.user.email ? req.user.email : null;
      const catalog = await getCatalogForDisplay();
      if (!sub) {
        return res.json({ state: "none", tiers: TIERS, catalog,
          checkout: getCheckoutLinksForTenant(req.tenant.id, userEmail, TIERS) });
      }
      // 2.4.25: subscribe links appear ONLY where a fresh checkout is
      // legitimate (no subscription, or a cancelled one). An active,
      // trialing, past_due, or suspended tenant must never see a path
      // to a second concurrent Stripe subscription: the app would
      // refuse the duplicate checkout event, but Stripe would still
      // be billing it. Suspended reactivation has its own route.
      res.json({
        catalog,
        checkout: getFreshCheckoutAllowed(sub.state)
          ? getCheckoutLinksForTenant(req.tenant.id, userEmail, TIERS)
          : null,
        tierChangeEnabled: getTierChangeEnabled(getPaymentsProviderName(), sub.comp === true),
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
      // 2.4.25: under the live Stripe provider, pending_tier would flip
      // the app's tier while Stripe keeps invoicing the original price:
      // entitlement and revenue diverge. Refused until the customer
      // portal (or checkout-based upgrade) exists.
      if (!getTierChangeEnabled(getPaymentsProviderName(), false)) {
        return res.status(409).json({
          error: "Tier changes for live subscriptions are handled through support until self-serve upgrades ship.",
          code: "TIER_CHANGE_UNAVAILABLE"
        });
      }
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
      const reactivationTier = getReactivationTier(sub);
      const links = reactivationTier
        ? getCheckoutLinksForTenant(req.tenant.id,
            req.user && req.user.email ? req.user.email : null, [reactivationTier])
        : null;
      const url = links ? links[reactivationTier] || null : null;
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
