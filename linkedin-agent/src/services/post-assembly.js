// ═══════════════════════════════════════════════════════════════
// src/services/post-assembly.js: what a generated post stores
// ═══════════════════════════════════════════════════════════════
// 4.25111.96. ONE derivation of the record a generated post keeps in
// posts.news_context, and of the primary source it is attributed
// to, for every path that persists a generation: the automated
// cycle (automation/generation-loop.js), Preview and Save Preview
// (routes/api.js) and Compose (routes/compose-api.js).
//
// Why one module. Until .94 each path built the record by hand.
// The three manual paths stored the quality scores, the overall
// score and the pass flag, the primary source and the article
// images; the automated cycle stored the scores only, and the
// scores of the FIRST attempt even when the retry had won. The
// dashboard's post modal rebuilds its Quality Assessment panel from
// the stored fields, so every post the scheduler wrote opened with
// "Overall: /10" and no source link (defect D1, 2026-09-13). A
// shared derivation cannot drift.
//
// What stays with the callers, on purpose: whether a post with no
// attributable source may be queued. Preview and Compose refuse it
// (fail closed, as before); the automated cycle queues it and warns
// (owner's ruling: the cycle keeps its behavior). This module only
// says what the source is and what the record looks like.
//
// Pure: no database, no log, no network, no environment. Inputs are
// treated as untrusted shapes (a research feed or a Model Provider
// answer can be poisoned): every field is type-checked, the image
// list is always an array capped at MAX_STORED_ARTICLE_IMAGES, and
// a primary source is whatever source-provenance.js resolves, which
// canonicalizes urls and refuses anything that is not http(s).
//
//   resolvePrimarySource(generated)
//       selectPrimarySource over generated.researchSummary.sourceList,
//       preferring the lead article image's link so the cited link
//       agrees with the image (Preview's rule since 2.5.x). Returns
//       { url, name, domain } or null.
//   buildStoredContext({ generated, quality, primarySource })
//       the record, one shape for every path:
//       { cycleId, angle, sourcesUsed, researchSummary, qualityScores,
//         qualityOverall, qualityPass, factualFlags, primarySource,
//         articleImages }
//       quality may be null (a caller that skipped the check): the
//       quality fields are then undefined and JSON drops them, which
//       is what the modal reads as "no panel", never invented zeros.
// ═══════════════════════════════════════════════════════════════

import { selectPrimarySource } from "./source-provenance.js";

// Snapshot size for the article images a post keeps (the queue card
// and modal offer them as the post's picture). Same cap the manual
// paths applied since 2.5.53.
export const MAX_STORED_ARTICLE_IMAGES = 20;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// The article images as an array, capped. Anything that is not an
// array (a string, an object with a length, null) is no images.
export function storedArticleImages(generated) {
  const g = asObject(generated);
  const list = g && Array.isArray(g.articleImages) ? g.articleImages : [];
  return list.slice(0, MAX_STORED_ARTICLE_IMAGES);
}

// The lead image's article link, when there is one. Used only as a
// tie-break preference; the resolver still validates it.
export function preferredSourceUrl(generated) {
  const lead = asObject(storedArticleImages(generated)[0]);
  return lead && typeof lead.link === "string" && lead.link.length > 0 ? lead.link : null;
}

export function resolvePrimarySource(generated) {
  const g = asObject(generated);
  const summary = g ? asObject(g.researchSummary) : null;
  const sources = summary && Array.isArray(summary.sourceList) ? summary.sourceList : [];
  return selectPrimarySource(sources, { preferUrl: preferredSourceUrl(g) });
}

// Only the three fields the page renders survive, whatever object a
// caller hands over (the resolver's or the boundary sanitizer's).
function storedPrimarySource(primarySource) {
  const p = asObject(primarySource);
  if (!p || typeof p.url !== "string" || p.url.length === 0) return null;
  return { url: p.url, name: typeof p.name === "string" ? p.name : "", domain: typeof p.domain === "string" ? p.domain : "" };
}

export function buildStoredContext({ generated, quality, primarySource } = {}) {
  const g = asObject(generated) || {};
  const q = asObject(quality);
  return {
    cycleId: typeof g.cycleId === "string" && g.cycleId.length > 0 ? g.cycleId : null,
    angle: typeof g.angle === "string" ? g.angle : "",
    sourcesUsed: Array.isArray(g.sourcesUsed) ? g.sourcesUsed : [],
    researchSummary: asObject(g.researchSummary),
    qualityScores: q ? q.scores : undefined,
    qualityOverall: q ? q.overall : undefined,
    qualityPass: q ? q.pass : undefined,
    factualFlags: q ? q.factual_flags : undefined,
    primarySource: storedPrimarySource(primarySource),
    articleImages: storedArticleImages(g)
  };
}
