// ═══════════════════════════════════════════════════════════════
// pricing-api.js: the public plan read for ***REMOVED***/pricing.html
// ═══════════════════════════════════════════════════════════════
// GET /api/pricing needs no session and resolves no tenant. It
// answers the tier list and the same display catalog GET /api/billing
// hands the billing page (name, description, amount, currency,
// interval per tier, matched to tiers by Stripe metadata.tier), and
// nothing that belongs to a workspace: no checkout link, no
// subscription, no id. The catalog is null when no catalog key is
// configured or Stripe does not answer; the page then keeps its
// static copy, as the billing page does. Cacheable by anyone for
// five minutes; the catalog itself is cached ten minutes upstream.
// ═══════════════════════════════════════════════════════════════
import express from "express";
import { TIERS } from "../config/entitlements.js";
import { getCatalogForDisplay } from "../payments/catalog.js";
import { platformLog } from "../services/platform-log.js";

const CACHE_SECONDS = 300;

export default function createPricingRoutes() {
  const router = express.Router();

  router.get("/", async (req, res) => {
    try {
      const catalog = await getCatalogForDisplay();
      res.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
      res.json({ tiers: [...TIERS], catalog: catalog || null });
    } catch (err) {
      platformLog("error", "pricing_read_failed", { error: err && err.message });
      res.status(500).json({ error: "An internal error occurred" });
    }
  });

  return router;
}
