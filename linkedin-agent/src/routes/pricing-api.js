// ═══════════════════════════════════════════════════════════════
// pricing-api.js: the public plan read for alpha-site/pricing.html
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
//
// 4.25111.78, because the page is public: the catalog module caches
// only a successful fetch, so while Stripe is slow or the key is
// wrong every anonymous request would reach for Stripe and wait out
// its timeout. A failed fetch is remembered here for one minute
// (negative cache), and the route carries a per-address ceiling
// (request-limiter.js), so a busy page or a hostile one cannot turn
// a Stripe outage into a stream of outbound calls.
// ═══════════════════════════════════════════════════════════════
import express from "express";
import { TIERS } from "../config/entitlements.js";
import { getCatalogForDisplay } from "../payments/catalog.js";
import { platformLog } from "../services/platform-log.js";
import { createRequestLimiter } from "../services/request-limiter.js";

const CACHE_SECONDS = 300;
const FAILURE_MEMORY_MS = 60 * 1000;
const PER_ADDRESS_PER_MINUTE = 120;

let failedAt = 0;

async function catalogOrNull() {
  if (failedAt && Date.now() - failedAt < FAILURE_MEMORY_MS) return null;
  const catalog = await getCatalogForDisplay();
  if (!catalog) failedAt = Date.now();
  return catalog || null;
}

export function _resetPricingMemo() { failedAt = 0; }

export default function createPricingRoutes() {
  const router = express.Router();
  router.use(createRequestLimiter({ limit: PER_ADDRESS_PER_MINUTE, name: "pricing" }));

  router.get("/", async (req, res) => {
    try {
      const catalog = await catalogOrNull();
      res.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
      res.json({ tiers: [...TIERS], catalog });
    } catch (err) {
      failedAt = Date.now();
      platformLog("error", "pricing_read_failed", { error: err && err.message });
      res.set("Cache-Control", "no-store");
      res.status(500).json({ error: "An internal error occurred" });
    }
  });

  return router;
}
