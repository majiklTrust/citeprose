// ═══════════════════════════════════════════════════════════════
// src/config/research.js — Research pipeline configuration
// ═══════════════════════════════════════════════════════════════
// Centralized env-driven settings for article age windows.
// Imported by news-monitor.js and feeds-api.js to avoid
// duplicating defaults or validation logic.
//
// Zero Trust: validates values are positive integers.
// Negative or zero values would produce incorrect queries
// (articles from the future, or prune everything).
// ═══════════════════════════════════════════════════════════════

const DEFAULT_MAX_AGE_DAYS = 20;
const DEFAULT_MAX_AGE_DAYS_PRUNE = 60;
const DEFAULT_MAX_RESEARCH_ARTICLES = 30;

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
