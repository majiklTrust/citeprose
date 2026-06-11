// ═══════════════════════════════════════════════════════════════
// src/services/article-image.js — RSS article image extraction
// ═══════════════════════════════════════════════════════════════
// Pure, DB-free. Extracted from news-monitor.js (image-capture fix)
// so the shape handling is testable in isolation.
//
// Extracts the best available image URL from a parsed RSS item.
// Priority order:
//   1. enclosure          (RSS 2.0 — most reliable when typed)
//   2. media:content      (Media RSS) — direct, or inside media:group
//   3. media:thumbnail    (Media RSS) — direct, or inside media:group
//
// Root causes this version fixes:
//   * media fields arriving as ARRAYS (multi-size images) were
//     dropped — every shape is normalized through asArray().
//   * media:content/media:thumbnail nested in <media:group> were
//     never read — the group is now descended into (the feed
//     parser's customFields must copy "media:group" for the field
//     to exist on the item at all).
//   * candidates without a declared type are labeled
//     "image/unknown"; isImageUrl() (security.js) now trusts any
//     image/* prefix, so the label is honored downstream.
//
// Deliberately still rejected: an enclosure with NO type and NO
// file extension — enclosures also carry podcast audio, and a bare
// typeless URL is indistinguishable from one. NULL is the safe
// answer there.
//
// Every candidate passes isImageUrl(): the full SSRF gate (https
// only, no localhost/private ranges) plus the image heuristic.
// Returns the first valid candidate URL, or null.
// ═══════════════════════════════════════════════════════════════

import { isImageUrl } from "./security.js";

function asArray(v) {
  if (Array.isArray(v)) return v;
  return v === null || v === undefined ? [] : [v];
}

// Media RSS attribute bag lives under "$" (xml2js convention).
function mediaUrl(m) {
  return (m && typeof m === "object" && m.$ && typeof m.$.url === "string") ? m.$.url : null;
}

function mediaType(m) {
  if (!m || typeof m !== "object" || !m.$) return null;
  if (m.$.medium === "image") return "image/unknown";
  return typeof m.$.type === "string" ? m.$.type : null;
}

export function extractArticleImage(item) {
  if (!item || typeof item !== "object") return null;
  const candidates = [];

  // 1. RSS 2.0 enclosure — { url, type, length }
  const enc = item.enclosure;
  if (enc && typeof enc === "object" && typeof enc.url === "string") {
    candidates.push({ url: enc.url, type: typeof enc.type === "string" ? enc.type : null });
  }

  // 2 + 3. Media RSS — direct on the item, or nested in media:group.
  const group = (item["media:group"] && typeof item["media:group"] === "object")
    ? item["media:group"] : null;

  const contents = [
    ...asArray(item["media:content"]),
    ...asArray(group && group["media:content"])
  ];
  for (const m of contents) {
    const url = mediaUrl(m);
    if (url) candidates.push({ url, type: mediaType(m) });
  }

  const thumbs = [
    ...asArray(item["media:thumbnail"]),
    ...asArray(group && group["media:thumbnail"])
  ];
  for (const m of thumbs) {
    const url = mediaUrl(m);
    if (url) candidates.push({ url, type: "image/unknown" });
  }

  for (const c of candidates) {
    if (isImageUrl(c.url, c.type)) return c.url;
  }
  return null;
}
