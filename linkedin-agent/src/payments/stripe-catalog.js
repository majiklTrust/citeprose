// =================================================================
// Stripe product catalog (2.4.41). The app's first OUTBOUND Stripe
// surface: read-only Products and Prices, matched to tiers by
// metadata.tier, for display on the billing page. Dependency-free
// (native fetch), timeout-bounded, TTL-cached, and fail-closed:
// any absence or failure yields null and the page falls back to
// its static copy. Recommended credential: a RESTRICTED key
// (rk_live_...) scoped to Products and Prices read only.
// =================================================================

const STRIPE_API = "https://api.stripe.com/v1";
const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4000;

let cache = { at: 0, data: null };

export function _resetCatalogCache() { cache = { at: 0, data: null }; }

export function getStripeCatalogKey(env = process.env) {
  const k = env.STRIPE_CATALOG_KEY || env.STRIPE_SECRET_KEY;
  if (!k || typeof k !== "string") return null;
  if (!k.startsWith("rk_") && !k.startsWith("sk_")) return null;
  return k;
}

// Pure: Stripe list payloads in, per-tier display map out.
export function buildCatalog(productsPayload, pricesPayload) {
  const products = (productsPayload && Array.isArray(productsPayload.data)) ? productsPayload.data : [];
  const prices = (pricesPayload && Array.isArray(pricesPayload.data)) ? pricesPayload.data : [];
  const priceById = new Map();
  for (const pr of prices) {
    if (pr && typeof pr.id === "string") priceById.set(pr.id, pr);
  }
  // Null-prototype accumulator: a hostile metadata.tier such as
  // __proto__ must become an ordinary key, never the prototype.
  const out = Object.create(null);
  for (const p of products) {
    if (!p || p.active !== true) continue;
    const tier = p.metadata && typeof p.metadata.tier === "string" ? p.metadata.tier : null;
    if (!tier) continue;
    const price = typeof p.default_price === "string" ? priceById.get(p.default_price) : null;
    const entry = { name: null, description: null, amount: null, currency: null, interval: null };
    if (typeof p.name === "string" && p.name.trim()) entry.name = p.name.trim();
    if (typeof p.description === "string" && p.description.trim()) entry.description = p.description.trim();
    if (price && Number.isInteger(price.unit_amount) && price.unit_amount >= 0) {
      entry.amount = price.unit_amount;
      if (typeof price.currency === "string") entry.currency = price.currency.toUpperCase();
      if (price.recurring && typeof price.recurring.interval === "string") entry.interval = price.recurring.interval;
    }
    out[tier] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function stripeGet(path, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(STRIPE_API + path, {
      headers: { Authorization: "Bearer " + key },
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchStripeCatalog(env = process.env) {
  const key = getStripeCatalogKey(env);
  if (!key) return null;
  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) return cache.data;
  try {
    const [products, prices] = await Promise.all([
      stripeGet("/products?active=true&limit=100", key),
      stripeGet("/prices?active=true&limit=100", key)
    ]);
    const catalog = buildCatalog(products, prices);
    if (catalog) cache = { at: now, data: catalog };
    return catalog;
  } catch {
    // Fail closed to static display; never let a catalog hiccup
    // break the billing page. The absence itself is the signal.
    return null;
  }
}
