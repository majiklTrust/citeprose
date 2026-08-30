// ═══════════════════════════════════════════════════════════════
// src/services/feed-validator.js — RSS feed URL validation
// ═══════════════════════════════════════════════════════════════
//
// Validates that an RSS/Atom feed URL is reachable, returns
// parseable content, and contains usable articles. Used by:
//
//   • Feed discovery (POST /api/feeds/discover) — validate AI
//     suggestions before presenting to the user
//   • Tenant registration — validate catchall feeds on seeding
//   • Feed polling — validate before processing articles
//   • Manual feed add (future) — validate before INSERT
//
// Grading:
//   A — resolves, valid RSS, fresh items, fast response
//   B — resolves, valid RSS, items present but stale or slow
//   C — resolves, valid RSS, empty or very stale content
//   F — unreachable, not XML, unparseable, or timeout
//
// Zero Trust:
//   • SSRF guard via isSafeUrl — blocks private IPs, non-HTTPS
//   • Timeout via AbortController (configurable, default 15s)
//   • Content-Type validation (must be XML-compatible)
//   • Size cap on response body (2 MB) to prevent memory abuse
//   • No credential or token exposure in error messages
// ═══════════════════════════════════════════════════════════════

import Parser from "rss-parser";
import { isSafeUrl } from "./security.js";
import { getMaxAgeDays } from "../config/research.js";
import { getFeedValidationTimeoutMs } from "../config/feeds.js";
import { platformLog } from "./platform-log.js";

const parser = new Parser({ timeout: getFeedValidationTimeoutMs() });

// ── Configuration ────────────────────────────────────────────

const VALIDATION_TIMEOUT_MS = getFeedValidationTimeoutMs();
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

const XML_CONTENT_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
  "text/html" // some servers misconfigure Content-Type but serve valid RSS
]);

// ── Grade thresholds ─────────────────────────────────────────
// Grade A: fresh items + fast response
// Grade B: has items but stale or slow
// Grade C: parseable but empty or ancient content
// Grade F: unreachable or unparseable

const GRADE_A_MAX_RESPONSE_MS = 5000;
const GRADE_B_MAX_RESPONSE_MS = 15000;
const GRADE_STALE_DAYS = 90;

// ── Core validation ──────────────────────────────────────────

/**
 * Validate an RSS/Atom feed URL.
 *
 * @param {string} url — the feed URL to validate
 * @returns {Promise<Object>} — structured validation result:
 *   {
 *     valid: boolean,
 *     grade: 'A' | 'B' | 'C' | 'F',
 *     url: string,
 *     feedTitle: string | null,
 *     httpStatus: number | null,
 *     contentType: string | null,
 *     itemCount: number,
 *     latestItemDate: string | null,
 *     responseMs: number,
 *     error: string | null
 *   }
 */
export async function validateFeed(url) {
  const result = {
    valid: false,
    grade: "F",
    url,
    feedTitle: null,
    httpStatus: null,
    contentType: null,
    itemCount: 0,
    latestItemDate: null,
    responseMs: 0,
    error: null
  };

  // ── Step 1: SSRF guard ───────────────────────────────────
  if (!url || typeof url !== "string") {
    result.error = "URL is empty or not a string";
    return result;
  }

  if (!isSafeUrl(url)) {
    result.error = "URL blocked by SSRF protection (must be HTTPS, public host)";
    return result;
  }

  // ── Step 2: HTTP fetch ───────────────────────────────────
  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "LinkedInAIAgent/1.5 (Feed Validator)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml"
      },
      signal: controller.signal
    });
  } catch (fetchErr) {
    result.responseMs = Date.now() - startMs;
    if (fetchErr.name === "AbortError") {
      result.error = `Timeout after ${VALIDATION_TIMEOUT_MS}ms`;
    } else {
      // Surface the underlying network cause when present. undici puts
      // the specific reason on err.cause (e.g. UND_ERR_CONNECT_TIMEOUT),
      // while err.message stays the generic "fetch failed".
      const cause = fetchErr.cause;
      result.error = cause?.code
        ? `Fetch failed: ${cause.code} (${String(cause.message || "").substring(0, 300)})`
        : `Fetch failed: ${fetchErr.message.substring(0, 300)}`;
      if (cause) {
        result.cause = {
          code: cause.code || null,
          message: String(cause.message || "").substring(0, 300)
        };
      }
    }
    // One log after the branch, carrying the feed identity and the
    // specific error already built, not the generic wrapper.
    platformLog("error", "feed_validator_failure", {
      url,
      error: result.error,
      ...(result.cause && { cause: result.cause })
    });
    return result;
  } finally {
    clearTimeout(timeout);
  }

  result.responseMs = Date.now() - startMs;
  result.httpStatus = response.status;

  if (!response.ok) {
    result.error = `HTTP ${response.status} ${response.statusText}`;
    return result;
  }

  // ── Step 3: Content-Type check ───────────────────────────
  const rawContentType = (response.headers.get("content-type") || "")
    .split(";")[0].trim().toLowerCase();
  result.contentType = rawContentType;

  if (rawContentType && !XML_CONTENT_TYPES.has(rawContentType)) {
    result.error = `Unexpected Content-Type: ${rawContentType} (expected RSS/XML)`;
    return result;
  }

  // ── Step 4: Read body with size cap ──────────────────────
  let xml;
  try {
    const chunks = [];
    let totalBytes = 0;
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        reader.cancel();
        result.error = `Response exceeds ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)} MB size limit`;
        return result;
      }
      chunks.push(value);
    }

    xml = Buffer.concat(chunks).toString("utf-8");
  } catch (readErr) {
    result.error = `Failed to read response body: ${readErr.message.substring(0, 200)}`;
    return result;
  }

  if (!xml || xml.trim().length === 0) {
    result.error = "Empty response body";
    return result;
  }

  // ── Step 5: Parse as RSS/Atom ────────────────────────────
  let feed;
  try {
    feed = await parser.parseString(xml);
  } catch (parseErr) {
    result.error = `RSS parse failed: ${parseErr.message.substring(0, 200)}`;
    return result;
  }

  result.feedTitle = feed.title || null;
  const items = feed.items || [];
  result.itemCount = items.length;

  // ── Step 6: Assess freshness ─────────────────────────────
  if (items.length > 0) {
    const dates = items
      .map(i => i.isoDate || i.pubDate || null)
      .filter(Boolean)
      .map(d => new Date(d))
      .filter(d => !isNaN(d.getTime()))
      .sort((a, b) => b - a);

    if (dates.length > 0) {
      result.latestItemDate = dates[0].toISOString();
    }
  }

  // ── Step 7: Content quality assessment ───────────────────
  // Check that items have meaningful summaries — not just titles
  // or truncated paywall teasers.
  if (items.length > 0) {
    const summaries = items
      .map(i => (i.contentSnippet || i.content || i.summary || "").trim())
      .filter(s => s.length > 0);

    result.summaryCount = summaries.length;
    result.avgSummaryLength = summaries.length > 0
      ? Math.round(summaries.reduce((sum, s) => sum + s.length, 0) / summaries.length)
      : 0;

    // Paywall/truncation detection — check for common patterns
    const paywallPatterns = [
      /subscribe to (read|continue|access)/i,
      /sign in to (read|continue|view)/i,
      /log ?in (to|required)/i,
      /premium (content|article|subscriber)/i,
      /for (full|complete) (article|story|access)/i,
      /members? only/i,
      /create (a )?free account/i,
      /unlock (this|full) (article|story)/i
    ];

    const paywallHits = summaries.filter(s =>
      paywallPatterns.some(p => p.test(s))
    ).length;

    result.paywallIndicators = paywallHits;

    // Truncation detection — if most summaries are very short
    // or all end with "..." it suggests truncated content
    const truncated = summaries.filter(s =>
      s.length < 80 || s.endsWith("...") || s.endsWith("…")
    ).length;
    result.truncatedCount = truncated;

    // Quality flags
    const qualityIssues = [];
    if (summaries.length === 0) {
      qualityIssues.push("no_summaries");
    } else if (result.avgSummaryLength < 50) {
      qualityIssues.push("very_short_summaries");
    }
    if (paywallHits > 0) {
      qualityIssues.push("paywall_detected");
    }
    if (truncated > summaries.length * 0.7) {
      qualityIssues.push("mostly_truncated");
    }
    result.qualityIssues = qualityIssues;
  } else {
    result.summaryCount = 0;
    result.avgSummaryLength = 0;
    result.paywallIndicators = 0;
    result.truncatedCount = 0;
    result.qualityIssues = ["empty_feed"];
  }

  // ── Step 8: Extract domain suggestions from feed metadata ─
  // Pull categories from the channel and items to auto-suggest
  // domain tags for the feed.
  const categorySet = new Set();
  if (feed.categories) {
    (Array.isArray(feed.categories) ? feed.categories : [feed.categories])
      .forEach(c => {
        const tag = (typeof c === "string" ? c : c?._ || "").toLowerCase().trim();
        if (tag && tag.length >= 2 && tag.length <= 50) categorySet.add(tag);
      });
  }
  for (const item of items.slice(0, 10)) {
    (item.categories || []).forEach(c => {
      const tag = (typeof c === "string" ? c : c?._ || "").toLowerCase().trim();
      if (tag && tag.length >= 2 && tag.length <= 50) categorySet.add(tag);
    });
  }
  result.suggestedDomains = [...categorySet].slice(0, 10);

  // ── Step 9: Assign grade ─────────────────────────────────
  // Paywall or severe quality issues cap the grade
  if (result.paywallIndicators > 0) {
    result.valid = false;
    result.grade = "F";
    result.error = `Paywall detected: ${result.paywallIndicators} items contain subscription/login language`;
    return result;
  }

  result.valid = true;
  result.grade = computeGrade(result);

  return result;
}

/**
 * Compute a grade from a valid feed's metrics.
 */
function computeGrade(result) {
  if (!result.valid) return "F";

  const { itemCount, latestItemDate, responseMs, qualityIssues } = result;

  // No items at all → C (parseable but useless)
  if (itemCount === 0) return "C";

  // Quality issues cap the grade
  const hasQualityIssues = qualityIssues && qualityIssues.length > 0;
  const hasSevereIssues = qualityIssues &&
    (qualityIssues.includes("no_summaries") || qualityIssues.includes("mostly_truncated"));

  // Check freshness
  const maxAgeDays = getMaxAgeDays();
  const staleDays = GRADE_STALE_DAYS;
  const now = Date.now();

  if (latestItemDate) {
    const latestMs = new Date(latestItemDate).getTime();
    const ageDays = (now - latestMs) / (1000 * 60 * 60 * 24);

    // Fresh content + fast response + no quality issues → A
    if (ageDays <= maxAgeDays && responseMs <= GRADE_A_MAX_RESPONSE_MS && !hasQualityIssues) return "A";

    // Fresh but has quality issues or slow → B
    if (ageDays <= maxAgeDays && !hasSevereIssues) return "B";

    // Fresh but severe quality issues → C
    if (ageDays <= maxAgeDays) return "C";

    // Stale but not ancient → B (if clean) or C (if quality issues)
    if (ageDays <= staleDays) return hasSevereIssues ? "C" : "B";

    // Ancient content → C
    return "C";
  }

  // Items exist but no parseable dates
  if (hasSevereIssues) return "C";
  if (responseMs <= GRADE_B_MAX_RESPONSE_MS) return "B";

  return "C";
}

/**
 * Validate multiple feeds in parallel with concurrency limit.
 * Returns an array of validation results in the same order.
 *
 * @param {string[]} urls — feed URLs to validate
 * @param {number} concurrency — max parallel validations (default 4)
 * @returns {Promise<Object[]>}
 */
export async function validateFeeds(urls, concurrency = 4) {
  const results = new Array(urls.length);
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const idx = cursor++;
      results[idx] = await validateFeed(urls[idx]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, urls.length) },
    () => worker()
  );
  await Promise.all(workers);

  return results;
}

/**
 * Format a validation result as a friendly console log message.
 *
 * @param {Object} result — from validateFeed
 * @returns {string}
 */
export function formatValidationMessage(result) {
  if (result.valid) {
    return `[${result.grade}] ${result.feedTitle || result.url} — ${result.itemCount} items, ` +
      `latest: ${result.latestItemDate ? result.latestItemDate.split("T")[0] : "unknown"}, ` +
      `${result.responseMs}ms`;
  }
  return `[F] ${result.url} — ${result.error}`;
}
