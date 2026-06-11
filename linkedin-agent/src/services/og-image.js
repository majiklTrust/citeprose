// ═══════════════════════════════════════════════════════════════
// src/services/og-image.js — og:image extraction for backfill
// ═══════════════════════════════════════════════════════════════
// Pure (no DB). Articles aged off their feeds can never be
// re-presented to the ingestion upsert, so the only retro path
// for image_url is reading the article page's own declaration:
// <meta property="og:image"> with twitter:image as fallback.
//
// The candidate is resolved absolute against the article link and
// validated through isImageUrl with the "image/unknown"
// declared-image trust — the page explicitly declared it an
// image, the same trust level as media:content medium="image" in
// feeds. The full SSRF gate (https only, no localhost/private
// ranges) applies unchanged, so a hostile page cannot point the
// backfill at internal targets.
// ═══════════════════════════════════════════════════════════════

import { isImageUrl } from "./security.js";

// Cap how much HTML the regexes walk — og tags live in <head>,
// and untrusted pages can be arbitrarily large.
const SCAN_LIMIT = 250000;

const OG_PATTERNS = [
  // og:image, either attribute order
  /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
  /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i
];
const TWITTER_PATTERNS = [
  // twitter:image via name= or property=, either order
  /<meta\b[^>]*(?:name|property)\s*=\s*["']twitter:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
  /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:name|property)\s*=\s*["']twitter:image["']/i
];

// Returns the raw candidate URL string from the HTML, or null.
// og:image wins over twitter:image when both are present.
export function extractOgImage(html) {
  if (typeof html !== "string" || html.length === 0) return null;
  const head = html.slice(0, SCAN_LIMIT);
  for (const re of OG_PATTERNS) {
    const m = re.exec(head);
    if (m && m[1]) return m[1];
  }
  for (const re of TWITTER_PATTERNS) {
    const m = re.exec(head);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Extract + resolve absolute against the article link + validate.
// Returns a safe absolute image URL, or null.
export function pickOgImage(html, articleLink) {
  const raw = extractOgImage(html);
  if (!raw) return null;
  let absolute;
  try {
    absolute = new URL(raw, articleLink).toString();
  } catch {
    return null;
  }
  // Declared-image trust: the page named this its image.
  // isImageUrl still enforces the full SSRF gate first.
  return isImageUrl(absolute, "image/unknown") ? absolute : null;
}
