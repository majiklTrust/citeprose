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
// reason a page is down.
//
// 4.25111.81: the address is derived here, not taken from req.ip.
// The application sets trust proxy to true, which makes req.ip the
// LEFTMOST X-Forwarded-For entry, and that entry is written by the
// client, so a caller who changed the header on every request got a
// fresh bucket every time and the ceiling meant nothing. Proxies
// append one entry each, so the trustworthy entry is counted from
// the RIGHT: with TRUSTED_PROXY_HOPS proxies in front of Node (1 by
// default), the entry that many places from the right is the address
// the outermost proxy saw. Fewer entries than hops, or 0 hops (Node
// answering directly, as in a development environment), falls back to
// the TCP peer. Set TRUSTED_PROXY_HOPS to the real number of proxies:
// too low throttles every visitor together behind the proxy, too
// high trusts a client-written entry.
// ═══════════════════════════════════════════════════════════════

const WINDOW_MS = 60 * 1000;
const MAX_TRACKED = 10000;
const DEFAULT_HOPS = 1;

export function trustedProxyHops(env = process.env) {
  const n = Number(env.TRUSTED_PROXY_HOPS);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : DEFAULT_HOPS;
}

export function clientAddress(req, env = process.env) {
  const peer = (req && req.socket && req.socket.remoteAddress) || "unknown";
  const hops = trustedProxyHops(env);
  if (hops === 0) return peer;
  const raw = req && req.headers ? req.headers["x-forwarded-for"] : null;
  const list = typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (list.length < hops) return peer;
  return list[list.length - hops];
}

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
      const key = String(clientAddress(req));
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
