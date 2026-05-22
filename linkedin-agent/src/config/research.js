// ═══════════════════════════════════════════════════════════════
// src/config/research.js — Research pipeline configuration
// ═══════════════════════════════════════════════════════════════
// Centralized env-driven settings for the research pipeline.
// Imported by news-monitor.js, feeds-api.js, and (v2) the
// domain matching logic.
//
// Zero Trust: validates all values — positive integers for
// counts/days, bounded floats for thresholds. Invalid or
// malicious .env values fall back to safe defaults.
// ═══════════════════════════════════════════════════════════════

// ── Article age & limits ─────────────────────────────────────

const DEFAULT_MAX_AGE_DAYS = 20;
const DEFAULT_MAX_AGE_DAYS_PRUNE = 60;
const DEFAULT_MAX_RESEARCH_ARTICLES = 30;
const DEFAULT_DASHBOARD_FEED_LIMIT = 8;
const DEFAULT_API_COOLDOWN_MS = 10000;

/**
 * Research window — articles older than this are excluded
 * from content generation. Env: MAX_AGE_DAYS. Default: 20.
 */
export function getMaxAgeDays() {
  const val = parseInt(process.env.MAX_AGE_DAYS, 10);
  return val > 0 ? val : DEFAULT_MAX_AGE_DAYS;
}

/**
 * Pruning window — feed_articles links older than this are
 * deleted during polling. Env: MAX_AGE_DAYS_PRUNE. Default: 60.
 */
export function getMaxAgeDaysPrune() {
  const val = parseInt(process.env.MAX_AGE_DAYS_PRUNE, 10);
  return val > 0 ? val : DEFAULT_MAX_AGE_DAYS_PRUNE;
}

/**
 * Article limit — max articles returned for content generation.
 * Controls AI prompt size and token cost.
 * Env: MAX_RESEARCH_ARTICLES. Default: 30.
 */
export function getMaxResearchArticles() {
  const val = parseInt(process.env.MAX_RESEARCH_ARTICLES, 10);
  return val > 0 ? val : DEFAULT_MAX_RESEARCH_ARTICLES;
}

/**
 * Dashboard feed limit — max feeds shown in the Research
 * Monitor panel. Env: DASHBOARD_FEED_LIMIT. Default: 8.
 */
export function getDashboardFeedLimit() {
  const val = parseInt(process.env.DASHBOARD_FEED_LIMIT, 10);
  return val > 0 ? val : DEFAULT_DASHBOARD_FEED_LIMIT;
}

// ── Feeds Manager v2: Domain matching ────────────────────────
//
// FEEDS_MANAGER_VERSION controls which matching tiers are active:
//   1 = v1 only: feed_topics + catchall (today's behavior)
//   2 = v1 + domain matching: feed_topics + domain overlap + catchall
//
// Domain matching is dormant when version = 1. Tags can exist
// on feeds and topics but have no effect on article selection.
// Switching between versions is instant (restart only, no
// data migration).

const DEFAULT_FEEDS_MANAGER_VERSION = 1;
const DEFAULT_DOMAIN_MATCH_THRESHOLD = 0.4;

/**
 * Feeds Manager version. Controls which matching tiers are
 * active in getArticlesForTopic.
 * Env: FEEDS_MANAGER_VERSION. Default: 1.
 * Valid values: 1 or 2.
 */
export function getFeedsManagerVersion() {
  const val = parseInt(process.env.FEEDS_MANAGER_VERSION, 10);
  return (val === 1 || val === 2) ? val : DEFAULT_FEEDS_MANAGER_VERSION;
}

/**
 * Domain match threshold — minimum overlap score for a feed
 * to qualify as a domain match for a topic.
 *
 * Score = overlapping tags / min(feed tags, topic tags).
 *   0.0 = any single shared tag qualifies (loosest)
 *   0.4 = ~40% overlap required (recommended start)
 *   1.0 = every tag must match (strictest)
 *
 * Env: DOMAIN_MATCH_THRESHOLD. Default: 0.4.
 * Clamped to [0.0, 1.0].
 */
export function getDomainMatchThreshold() {
  const val = parseFloat(process.env.DOMAIN_MATCH_THRESHOLD);
  if (isNaN(val)) return DEFAULT_DOMAIN_MATCH_THRESHOLD;
  return Math.max(0.0, Math.min(1.0, val));
}

/**
 * Calculate domain overlap score between a feed and a topic.
 * Returns a value between 0.0 (no overlap) and 1.0 (full overlap).
 * Used by the v2 matching tier in getArticlesForTopic.
 *
 * @param {string[]} feedDomains — domain tags on the feed
 * @param {string[]} topicDomains — domain tags on the topic
 * @returns {number} overlap score
 */
export function domainMatchScore(feedDomains, topicDomains) {
  if (!Array.isArray(feedDomains) || !feedDomains.length) return 0;
  if (!Array.isArray(topicDomains) || !topicDomains.length) return 0;
  const feedSet = new Set(feedDomains.map(d => String(d).toLowerCase()));
  const topicSet = new Set(topicDomains.map(d => String(d).toLowerCase()));
  const overlap = [...topicSet].filter(d => feedSet.has(d)).length;
  return overlap / Math.min(feedSet.size, topicSet.size);
}

/**
 * API rate-limit cooldown — pause between consecutive Anthropic
 * calls to avoid hitting per-minute rate limits.
 * Env: API_COOLDOWN_MS. Default: 10000 (10s).
 *
 * The previous hardcoded value of 65000 (65s) was sized for free-
 * tier keys. BYOK paid keys have higher limits; 10s provides
 * sufficient spacing. Adjust via .env if rate limit errors appear.
 */
export function getCooldownMs() {
  const val = parseInt(process.env.API_COOLDOWN_MS, 10);
  return val > 0 ? val : DEFAULT_API_COOLDOWN_MS;
}
