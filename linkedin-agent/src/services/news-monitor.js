// ═══════════════════════════════════════════════════════════════
// News Monitor Service — RSS feed ingestion & article storage
// ═══════════════════════════════════════════════════════════════
//
// Normalized schema (v2):
//   articles_v2    — global, one row per URL, no RLS
//   feeds_v2       — tenant-scoped feed definitions, RLS
//   feed_articles  — tenant-scoped access boundary, RLS
//   feed_topics    — many-to-many feed ↔ topic, RLS
//
// Articles are stored once globally. Tenant access is enforced
// through feed_articles. A tenant can only see articles that
// arrived through their own feeds.
//
// Two entry patterns:
//   1. API routes — wrapped in withTenant by the handler.
//   2. Cron loop — iterates all active tenants, wraps each
//      in its own withTenant block.
// ═══════════════════════════════════════════════════════════════

import Parser from "rss-parser";
import cron from "node-cron";
import { logActivity } from "./database.js";
import { platformLog } from "./platform-log.js";
import { sanitizeTitle, sanitizeSummary, sanitizeLink, detectPromptInjection } from "./sanitize-content.js";
import { currentClient } from "../db/with-tenant.js";
import { withTenant } from "../db/with-tenant.js";
import { listActiveTenants } from "../tenant/platform-db.js";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "LinkedInAIAgent/1.5 (RSS Reader)" }
});

let monitorJob = null;

// ── Configurable age windows ─────────────────────────────────
// Centralized in src/config/research.js to avoid duplication.
import {
  getMaxAgeDays, getMaxAgeDaysPrune, getMaxResearchArticles,
  getFeedsManagerVersion, getDomainMatchThreshold, domainMatchScore
} from "../config/research.js";

// Returns the current tenant's pg.Client from AsyncLocalStorage.
// Throws if called outside withTenant.
function client() {
  const c = currentClient();
  if (!c) {
    throw new Error("news-monitor operation requires tenant context (call inside withTenant)");
  }
  return c;
}

// ── Feed Fetching ────────────────────────────────────────────
// Must be called inside withTenant.
// feedRow: a row from feeds_v2 (id, url, name, tier, etc.)

async function fetchFeed(feedRow) {
  let httpStatus = null;
  try {
    // Fetch RSS manually to capture HTTP status code.
    // parser.parseURL() hides the status — we need it for logging.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(feedRow.url, {
        headers: {
          "User-Agent": "LinkedInAIAgent/1.5 (RSS Reader)",
          "Accept": "application/rss+xml, application/xml, text/xml"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    httpStatus = response.status;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();
    const feed = await parser.parseString(xml);
    let newArticles = 0;
    let linked = 0;
    const c = client();

    // Capture channel-level metadata from RSS XML
    const channelDescription = (feed.description || "").substring(0, 1000).trim();
    const channelCategories = Array.isArray(feed.categories)
      ? feed.categories.map(c => String(c).trim()).filter(Boolean)
      : [];

    // Collect item-level categories across all articles in this poll
    const itemCategorySet = new Set(channelCategories);

    for (const item of feed.items || []) {
      // Aggregate item categories for feed-level classification
      if (Array.isArray(item.categories)) {
        for (const cat of item.categories) {
          const trimmed = String(cat).trim();
          if (trimmed && itemCategorySet.size < 50) {
            itemCategorySet.add(trimmed);
          }
        }
      }

      const link = sanitizeLink(item.link || item.guid);
      if (!link) continue;

      const rawSummary = item.contentSnippet || item.content || item.summary || "";
      const cleanSummary = sanitizeSummary(rawSummary);
      const cleanTitle = sanitizeTitle(item.title || "Untitled");

      // Prompt-injection screening — reject poisoned content at ingest
      const titleInjection = detectPromptInjection(cleanTitle);
      const summaryInjection = detectPromptInjection(cleanSummary);

      if (titleInjection.detected || summaryInjection.detected) {
        await logActivity("warn", "prompt_injection_detected", {
          feed: feedRow.name,
          link,
          titlePatterns: titleInjection.patterns,
          summaryPatterns: summaryInjection.patterns
        });
        platformLog("warn", "prompt_injection_detected", {
          feed: feedRow.name, link,
          titlePatterns: titleInjection.patterns,
          summaryPatterns: summaryInjection.patterns
        });
        continue;
      }

      const published = item.isoDate || item.pubDate || null;
      const hash = simpleHash(link + cleanTitle);

      // Step 1: Insert into global articles_v2.
      // No tenant_id, no RLS. ON CONFLICT returns nothing if
      // the article already exists (another feed already fetched it).
      const articleResult = await c.query(
        `INSERT INTO articles_v2 (title, link, summary, published_at, content_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (link) DO NOTHING
         RETURNING id`,
        [cleanTitle, link, cleanSummary, published, hash]
      );

      let articleId;
      if (articleResult.rowCount > 0) {
        articleId = articleResult.rows[0].id;
        newArticles++;
      } else {
        // Article already exists — look up its id
        const existing = await c.query(
          `SELECT id FROM articles_v2 WHERE link = $1`,
          [link]
        );
        if (existing.rows.length === 0) continue;
        articleId = existing.rows[0].id;
      }

      // Step 2: Link article to this tenant's feed.
      // ON CONFLICT means this feed already fetched this article.
      const linkResult = await c.query(
        `INSERT INTO feed_articles (tenant_id, feed_id, article_id)
         VALUES (current_tenant_id(), $1, $2)
         ON CONFLICT (feed_id, article_id) DO NOTHING`,
        [feedRow.id, articleId]
      );

      if (linkResult.rowCount > 0) linked++;
    }

    // Update feed poll status + metadata from RSS channel
    const categories = [...itemCategorySet];
    await c.query(
      `UPDATE feeds_v2
       SET last_polled_at = now(),
           last_error = NULL,
           feed_description = COALESCE(NULLIF($2, ''), feed_description),
           feed_categories = CASE
             WHEN $3::jsonb != '[]'::jsonb THEN $3::jsonb
             ELSE feed_categories
           END
       WHERE id = $1`,
      [feedRow.id, channelDescription, JSON.stringify(categories)]
    );

    await logActivity("info", "feed_fetched", {
      feed: feedRow.name,
      status: httpStatus,
      newArticles,
      linked,
      totalItems: feed.items?.length || 0
    });
    platformLog("info", "feed_fetched", {
      feed: feedRow.name, status: httpStatus,
      newArticles, linked, totalItems: feed.items?.length || 0
    });

    return { newArticles, linked };
  } catch (err) {
    // Record error on the feed row
    const c = client();
    try {
      await c.query(
        `UPDATE feeds_v2 SET last_error = $1 WHERE id = $2`,
        [err.message.substring(0, 500), feedRow.id]
      );
    } catch { /* best-effort */ }

    await logActivity("warn", "feed_fetch_failed", {
      feed: feedRow.name,
      status: httpStatus,
      error: err.message.substring(0, 300)
    });
    platformLog("warn", "feed_fetch_failed", {
      feed: feedRow.name, status: httpStatus,
      error: err.message.substring(0, 300)
    });
    return { newArticles: 0, linked: 0 };
  }
}

// ── Polling Cycle ────────────────────────────────────────────
// Must be called inside withTenant.

export async function pollAllFeeds() {
  const c = client();

  // Read feeds from the database instead of the hardcoded array
  const feedsResult = await c.query(
    `SELECT id, url, name, tier::text, refresh_minutes, last_polled_at
     FROM feeds_v2
     WHERE enabled = true
     ORDER BY last_polled_at ASC NULLS FIRST`
  );

  const feeds = feedsResult.rows;

  await logActivity("info", "feed_poll_started", { feedCount: feeds.length });
  platformLog("info", "feed_poll_started", { feedCount: feeds.length });

  let totalNew = 0;
  let totalLinked = 0;

  for (const feedRow of feeds) {
    // Skip feeds that aren't due for polling yet
    if (feedRow.last_polled_at) {
      const minutesSincePoll = (Date.now() - new Date(feedRow.last_polled_at).getTime()) / 60000;
      if (minutesSincePoll < feedRow.refresh_minutes) continue;
    }

    const result = await fetchFeed(feedRow);
    totalNew += result.newArticles;
    totalLinked += result.linked;
    await new Promise(r => setTimeout(r, 1500));
  }

  // Prune old feed_articles links for this tenant.
  // Articles are global — we only remove the tenant's reference.
  // Orphaned articles_v2 rows can be cleaned by a maintenance job.
  const pruneWindow = getMaxAgeDaysPrune();
  const pruned = await c.query(
    `DELETE FROM feed_articles
     WHERE tenant_id = current_tenant_id()
       AND article_id IN (
         SELECT a.id FROM articles_v2 a
         WHERE a.published_at < now() - ($1 || ' days')::interval
       )`,
    [String(pruneWindow)]
  );

  await logActivity("info", "feed_poll_complete", {
    newArticles: totalNew,
    linked: totalLinked,
    prunedLinks: pruned.rowCount
  });
  platformLog("info", "feed_poll_complete", {
    newArticles: totalNew, linked: totalLinked, prunedLinks: pruned.rowCount
  });

  return totalNew;
}

// ── Query Articles ───────────────────────────────────────────
// Must be called inside withTenant.

export async function getArticlesForTopic(topicSlug, maxAgeDays = null, limit = null) {
  const ageDays = maxAgeDays || getMaxAgeDays();
  const articleLimit = limit || getMaxResearchArticles();
  const version = getFeedsManagerVersion();

  if (version === 2) {
    return _getArticlesForTopicV2(topicSlug, ageDays, articleLimit);
  }
  return _getArticlesForTopicV1(topicSlug, ageDays, articleLimit);
}

// ── v1: feed_topics + catchall (today's behavior) ────────────

async function _getArticlesForTopicV1(topicSlug, ageDays, articleLimit) {
  const c = client();
  const r = await c.query(
    `SELECT DISTINCT a.id, a.title, a.link, a.summary, a.published_at,
            f.name AS feed_name, f.tier::text AS feed_tier
     FROM articles_v2 a
     JOIN feed_articles fa ON fa.article_id = a.id
     JOIN feeds_v2 f ON f.id = fa.feed_id
     LEFT JOIN feed_topics ft ON ft.feed_id = f.id
     LEFT JOIN topics t ON t.id = ft.topic_id AND t.slug = $1
     WHERE (t.id IS NOT NULL OR f.is_catchall = true)
       AND a.published_at >= now() - ($2 || ' days')::interval
     ORDER BY CASE WHEN t.id IS NOT NULL THEN 0 ELSE 1 END,
              a.published_at DESC
     LIMIT $3`,
    [topicSlug, String(ageDays), articleLimit]
  );
  return r.rows;
}

// ── v2: feed_topics + domain matching + catchall ─────────────
// Returns articles from three tiers, sorted by priority:
//   Priority 0: explicit feed_topics mapping (topic-specific)
//   Priority 1: domain tag overlap score > threshold
//   Priority 2: catchall baseline
//
// Application-side filtering: the query returns all candidate
// articles (topic-specific + domain-tagged + catchall). JavaScript
// scores domain matches and sorts. This avoids complex SQL and
// keeps the scoring logic in one place (research.js).

async function _getArticlesForTopicV2(topicSlug, ageDays, articleLimit) {
  const c = client();
  const threshold = getDomainMatchThreshold();

  // Look up topic domains
  const topicResult = await c.query(
    `SELECT domains FROM topics WHERE slug = $1`,
    [topicSlug]
  );
  const topicDomains = topicResult.rows[0]?.domains || [];

  // Expanded query: includes domain-tagged feeds alongside
  // topic-specific and catchall. No LIMIT — sorting in JS.
  const r = await c.query(
    `SELECT DISTINCT a.id, a.title, a.link, a.summary, a.published_at,
            f.name AS feed_name, f.tier::text AS feed_tier,
            f.is_catchall, f.domains AS feed_domains,
            (t.id IS NOT NULL) AS is_topic_specific
     FROM articles_v2 a
     JOIN feed_articles fa ON fa.article_id = a.id
     JOIN feeds_v2 f ON f.id = fa.feed_id
     LEFT JOIN feed_topics ft ON ft.feed_id = f.id
     LEFT JOIN topics t ON t.id = ft.topic_id AND t.slug = $1
     WHERE (t.id IS NOT NULL OR f.is_catchall = true
            OR (f.domains IS NOT NULL AND f.domains != '[]'::jsonb))
       AND a.published_at >= now() - ($2 || ' days')::interval
     ORDER BY a.published_at DESC`,
    [topicSlug, String(ageDays)]
  );

  // Score and assign priority tiers
  const scored = [];
  for (const a of r.rows) {
    let priority;

    if (a.is_topic_specific) {
      // Tier 0: explicit feed_topics mapping
      priority = 0;
    } else {
      // Check domain overlap
      const feedDomains = a.feed_domains || [];
      const score = domainMatchScore(feedDomains, topicDomains);

      if (score > threshold) {
        // Tier 1: domain tag match above threshold
        priority = 1;
      } else if (a.is_catchall) {
        // Tier 2: catchall baseline
        priority = 2;
      } else {
        // No match — exclude
        continue;
      }
    }

    scored.push({
      id: a.id, title: a.title, link: a.link, summary: a.summary,
      published_at: a.published_at, feed_name: a.feed_name,
      feed_tier: a.feed_tier, _priority: priority
    });
  }

  // Sort: priority ascending, then newest first within each tier
  scored.sort((a, b) =>
    a._priority - b._priority ||
    new Date(b.published_at) - new Date(a.published_at)
  );

  return scored.slice(0, articleLimit);
}

export async function searchArticles(keywords, topicSlug = null, maxAgeDays = null, limit = 20) {
  const ageDays = maxAgeDays || getMaxAgeDays();
  const c = client();
  const conditions = [];
  const params = [];
  let i = 1;

  for (const kw of keywords) {
    conditions.push(`(a.title ILIKE $${i} OR a.summary ILIKE $${i})`);
    params.push(`%${kw}%`);
    i++;
  }

  if (topicSlug) {
    conditions.push(`t.slug = $${i}`);
    params.push(topicSlug);
    i++;
  }

  conditions.push(`a.published_at >= now() - ($${i} || ' days')::interval`);
  params.push(String(ageDays));
  i++;
  params.push(limit);

  const topicJoin = topicSlug
    ? `JOIN feed_topics ft ON ft.feed_id = f.id
       JOIN topics t ON t.id = ft.topic_id`
    : "";

  const sql = `
    SELECT DISTINCT a.id, a.title, a.link, a.summary, a.published_at,
           f.name AS feed_name, f.tier::text AS feed_tier
    FROM articles_v2 a
    JOIN feed_articles fa ON fa.article_id = a.id
    JOIN feeds_v2 f ON f.id = fa.feed_id
    ${topicJoin}
    WHERE ${conditions.join(" AND ")}
    ORDER BY a.published_at DESC
    LIMIT $${i}
  `;

  const r = await c.query(sql, params);
  return r.rows;
}

export async function getArticleStats() {
  const c = client();
  const ageDays = getMaxAgeDays();

  const total = await c.query(
    `SELECT COUNT(DISTINCT fa.article_id)::int AS count
     FROM feed_articles fa`
  );
  const byFeed = await c.query(
    `SELECT f.name AS feed_name, f.tier::text AS feed_tier,
            COUNT(DISTINCT fa.article_id)::int AS count
     FROM feed_articles fa
     JOIN feeds_v2 f ON f.id = fa.feed_id
     JOIN articles_v2 a ON a.id = fa.article_id
     WHERE a.published_at >= now() - ($1 || ' days')::interval
     GROUP BY f.name, f.tier
     ORDER BY CASE f.tier::text
                WHEN 'authoritative' THEN 1
                WHEN 'primary' THEN 2
                WHEN 'secondary' THEN 3
                ELSE 4
              END, f.name`,
    [String(ageDays)]
  );
  const recent = await c.query(
    `SELECT COUNT(DISTINCT fa.article_id)::int AS count
     FROM feed_articles fa
     JOIN articles_v2 a ON a.id = fa.article_id
     WHERE a.published_at >= now() - ($1 || ' days')::interval`,
    [String(ageDays)]
  );

  return {
    totalArticles: total.rows[0].count,
    recentArticles: recent.rows[0].count,
    maxAgeDays: ageDays,
    byFeed: byFeed.rows
  };
}

// ── Monitor Lifecycle ────────────────────────────────────────

async function runPollForAllTenants() {
  let tenants;
  try {
    tenants = await listActiveTenants();
  } catch (err) {
    console.error("[news-monitor] failed to list tenants:", err.message);
    return;
  }

  for (const tenant of tenants) {
    try {
      await withTenant(tenant.id, async () => {
        await pollAllFeeds();
      });
    } catch (err) {
      console.error(`[news-monitor] tenant ${tenant.slug} poll failed:`, err.message);
    }
  }
}

export function startMonitor() {
  // Initial poll at startup — async, don't block boot
  runPollForAllTenants().catch(err => {
    console.error("[news-monitor] initial poll failed:", err.message);
  });

  // Hourly poll for all tenants
  monitorJob = cron.schedule("0 * * * *", () => {
    runPollForAllTenants().catch(err => {
      console.error("[news-monitor] scheduled poll failed:", err.message);
    });
  });

  console.log("📡 News monitor started — polling feeds hourly across all active tenants");
}

export function stopMonitor() {
  if (monitorJob) {
    monitorJob.stop();
    console.log("📡 News monitor stopped");
  }
}

// ── Utilities ────────────────────────────────────────────────

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}
