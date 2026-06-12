// ═══════════════════════════════════════════════════════════════
// src/services/post-image-hydrate.js — read-time image hydration
// ═══════════════════════════════════════════════════════════════
// Pure (no DB). articleImages stored in a post's news_context is a
// snapshot frozen at generation time. Posts generated before image
// capture or backfill repaired articles_v2 carry an empty snapshot
// forever, even though the images now exist one join away — so the
// modal picker stays empty. These helpers let the posts routes
// derive the picker list at READ time from current article data:
//
//   collectSourceLinks(ctx)  -> the post's source article URLs
//                               (https only, deduped, capped 50)
//   mergeArticleImages(a, b) -> stored snapshot entries first,
//                               derived rows fill the rest, deduped
//                               by imageUrl/link, capped 20
//
// Entry shape (matches the generation-time snapshot):
//   { imageUrl, title, feedName, link }
// ═══════════════════════════════════════════════════════════════

const LINK_CAP = 50;
const IMAGE_CAP = 20;

function isHttps(u) {
  return typeof u === "string" && /^https:\/\//.test(u);
}

export function collectSourceLinks(ctx) {
  if (!ctx || typeof ctx !== "object") return [];
  const out = [];
  const seen = new Set();
  const add = (u) => {
    if (isHttps(u) && !seen.has(u) && out.length < LINK_CAP) {
      seen.add(u);
      out.push(u);
    }
  };
  if (Array.isArray(ctx.sourcesUsed)) {
    for (const s of ctx.sourcesUsed) add(s);
  }
  const list = ctx.researchSummary && Array.isArray(ctx.researchSummary.sourceList)
    ? ctx.researchSummary.sourceList : [];
  for (const s of list) {
    if (s && typeof s === "object") add(s.url);
  }
  return out;
}

export function mergeArticleImages(stored, derived) {
  const out = [];
  const seenImage = new Set();
  const seenLink = new Set();
  const add = (e) => {
    if (!e || typeof e !== "object" || !isHttps(e.imageUrl)) return;
    if (seenImage.has(e.imageUrl)) return;
    if (typeof e.link === "string" && seenLink.has(e.link)) return;
    if (out.length >= IMAGE_CAP) return;
    seenImage.add(e.imageUrl);
    if (typeof e.link === "string") seenLink.add(e.link);
    out.push({
      imageUrl: e.imageUrl,
      title: typeof e.title === "string" ? e.title : null,
      feedName: typeof e.feedName === "string" ? e.feedName : null,
      link: typeof e.link === "string" ? e.link : null
    });
  };
  for (const e of Array.isArray(stored) ? stored : []) add(e);
  for (const e of Array.isArray(derived) ? derived : []) add(e);
  return out;
}
