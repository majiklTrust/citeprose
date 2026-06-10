// ═══════════════════════════════════════════════════════════════
// src/services/source-provenance.js — primary source attribution
// ═══════════════════════════════════════════════════════════════
// Pure, DB-free helpers that pick and clean the single PRIMARY
// SOURCE link attributed to a generated post. Used by the
// generate-preview route to persist news_context.primarySource and
// by the dashboard to render the credible "via {domain}" link in
// the approval queue card and the post detail modal.
//
// URL safety is delegated to sanitizeLink() in sanitize-content.js
// (scheme blocklist, length cap, control-char stripping) — this
// module never re-implements a scheme blocklist. On top of that it
// strips tracking parameters and the #fragment so the cited link
// stays stable, short, and free of breakout characters.
//
// Fail-closed: selectPrimarySource returns null when no source has
// a usable http(s) url. The caller treats null as a blocked result
// and never queues a sourceless post.
// ═══════════════════════════════════════════════════════════════

import { sanitizeLink } from "./sanitize-content.js";

// Trust-tier ranking (mirrors the feed_tier enum). Higher wins.
const TIER_RANK = { authoritative: 3, primary: 2, secondary: 1 };

// Query parameters that carry no addressing value — pure tracking.
// Anything beginning with "utm_" is also dropped (handled below).
const TRACKING_PARAMS = new Set([
  "gclid", "fbclid", "dclid", "msclkid", "yclid", "twclid",
  "mc_cid", "mc_eid", "igshid", "mkt_tok", "vero_id", "vero_conv",
  "_hsenc", "_hsmi", "ref", "ref_src", "ref_url", "cmpid", "ito"
]);

const MAX_URL_LENGTH = 2048;

// ── deriveDomain ─────────────────────────────────────────────
// Returns the true, normalized host (lowercased, no leading
// "www.", no trailing "."), or null. Uses the WHATWG URL parser,
// so userinfo (e.g. "trusted.com@evil.com") can never spoof the
// reported host.
export function deriveDomain(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let host = (u.hostname || "").toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  host = host.replace(/^www\./, "");
  return host.length > 0 ? host : null;
}

// ── canonicalizeSourceUrl ────────────────────────────────────
// Validates via sanitizeLink (http/https only, <= 2048, no
// dangerous scheme, control chars stripped), then removes tracking
// params and the #fragment and percent-encodes any residual
// breakout characters. Returns a clean url, or null.
export function canonicalizeSourceUrl(url) {
  const safe = sanitizeLink(url); // reuse: scheme/length/control-char safety
  if (!safe) return null;
  let u;
  try { u = new URL(safe); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith("utm_") || TRACKING_PARAMS.has(k)) {
      u.searchParams.delete(key);
    }
  }
  u.hash = "";

  let out = u.toString();
  // The URL serializer leaves a few characters literal in the path
  // (notably the apostrophe). Percent-encode the residual breakout
  // set so the value is always safe inside an href / attribute.
  out = out.replace(/'/g, "%27").replace(/`/g, "%60");
  if (out.length > MAX_URL_LENGTH) return null;
  return out;
}

// ── sanitizePrimarySource ────────────────────────────────────
// Revalidates a primarySource object at a trust boundary (e.g. the
// save-preview route, where the value arrives in req.body). Never
// trust the caller: the url must canonicalize cleanly, the domain is
// RE-DERIVED from that url (a caller-supplied domain is ignored, so
// a client cannot label an attacker link "via reuters.com"), the
// name is coerced to a trimmed string capped at MAX_NAME_LENGTH, and
// only { url, name, domain } survive. Returns null on anything else
// (fail-closed).
const MAX_NAME_LENGTH = 120;

export function sanitizePrimarySource(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const url = canonicalizeSourceUrl(input.url);
  if (!url) return null;
  const domain = deriveDomain(url);
  if (!domain) return null;
  let name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0) name = domain;
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH);
  return { url, name, domain };
}

// ── selectPrimarySource ──────────────────────────────────────
// sources: [{ name, url, tier }, ...] (research sourceList shape).
// opts.preferUrl: when set, a same-tier source whose canonical url
//   matches breaks ties (so the cited link agrees with the chosen
//   image's article).
// Returns { url, name, domain } or null (fail-closed).
export function selectPrimarySource(sources, opts = {}) {
  if (!Array.isArray(sources) || sources.length === 0) return null;

  const preferCanon = opts && opts.preferUrl ? canonicalizeSourceUrl(opts.preferUrl) : null;

  const candidates = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i] || {};
    const canon = canonicalizeSourceUrl(s.url);
    if (!canon) continue;
    candidates.push({ name: s.name, canon, rank: TIER_RANK[s.tier] || 0, index: i });
  }
  if (candidates.length === 0) return null;

  const maxRank = candidates.reduce((m, c) => Math.max(m, c.rank), 0);
  const top = candidates.filter(c => c.rank === maxRank);

  let chosen = null;
  if (preferCanon) chosen = top.find(c => c.canon === preferCanon) || null;
  if (!chosen) chosen = top.reduce((a, b) => (b.index < a.index ? b : a));

  const domain = deriveDomain(chosen.canon);
  return {
    url: chosen.canon,
    name: (chosen.name && String(chosen.name)) || domain || "source",
    domain: domain || ""
  };
}
