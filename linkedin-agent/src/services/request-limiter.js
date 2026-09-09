// ═══════════════════════════════════════════════════════════════
// request-limiter.js: a per-address ceiling for public doors
// ═══════════════════════════════════════════════════════════════
// 4.25111.78. The pricing read and the checkout door are reachable
// by anyone. Neither is expensive on its own, but the read can fan
// out to Stripe and the door mints registrations, so each carries a
// small fixed-window ceiling per client address: N requests per
// minute, answered 429 with Retry-After beyond it. In memory, per
// process, bounded (old windows are swept; the map is capped), and
// fail-open on anything unexpected: a limiter must never be the
// reason a page is down. req.ip honours trust proxy, so behind the
// CDN it is the visitor's address, not the edge's.
// ═══════════════════════════════════════════════════════════════

const WINDOW_MS = 60 * 1000;
const MAX_TRACKED = 10000;

export function createRequestLimiter({ limit = 120, windowMs = WINDOW_MS, name = "public" } = {}) {
  const hits = new Map();

  function sweep(now) {
    if (hits.size < MAX_TRACKED) return;
    for (const [key, entry] of hits) {
      if (now - entry.start >= windowMs) hits.delete(key);
      if (hits.size < MAX_TRACKED / 2) break;
    }
    if (hits.size >= MAX_TRACKED) hits.clear();
  }

  return function requestLimiter(req, res, next) {
    try {
      const key = String(req.ip || req.socket?.remoteAddress || "unknown");
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || now - entry.start >= windowMs) {
        entry = { start: now, count: 0 };
        hits.set(key, entry);
        sweep(now);
      }
      entry.count += 1;
      if (entry.count > limit) {
        const retry = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
        res.set("Retry-After", String(retry));
        res.set("Cache-Control", "no-store");
        return res.status(429).json({ error: "Too many requests", code: "RATE_LIMITED", scope: name });
      }
      return next();
    } catch {
      return next();
    }
  };
}
