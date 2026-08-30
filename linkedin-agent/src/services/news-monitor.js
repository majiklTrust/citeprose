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
//      Exception (2.88.21): the full poll, pollAllFeedsChunked,
//      manages its own sequence of short withTenant transactions
//      and is called OUTSIDE any tenant scope.
//   2. Cron loop — iterates all active tenants and calls
//      pollAllFeedsChunked per tenant.
// ═══════════════════════════════════════════════════════════════

import Parser from "rss-parser";
import cron from "node-cron";
import { logActivity } from "./database.js";
import { platformLog } from "./platform-log.js";
import { sanitizeTitle, sanitizeSummary, sanitizeLink, detectPromptInjection } from "./sanitize-content.js";
import { extractArticleImage } from "./article-image.js";
import { resolvePollSchedule } from "../config/poll-schedule.js";
import { currentClient } from "../db/with-tenant.js";
import { withSavepoint, tryBookkeeping, getSavepointCap } from "../db/savepoint.js";
import { withTenant } from "../db/with-tenant.js";
import { listActiveTenants } from "../tenant/platform-db.js";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "LinkedInAIAgent/1.5 (RSS Reader)" },
  customFields: {
    item: [
      ["media:content", "media:content", { keepArray: false }],
      ["media:thumbnail", "media:thumbnail", { keepArray: false }],
      ["media:group", "media:group", { keepArray: false }]
    ]
  }
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

// ── String Coercion ──────────────────────────────────────────
// xml2js / rss-parser sometimes returns objects instead of strings
// for feed fields (e.g. { _: "text", $: { type: "html" } }).
// This helper safely extracts the text content without throwing
// "Cannot convert object to primitive value."

function coerceString(val) {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "object") {
    // xml2js text content convention: { _: "text", $: { attrs } }
    if (val._ !== undefined) return String(val._);
    // Atom link convention: { $: { href: "url" } }
    if (val.$ && val.$.href) return String(val.$.href);
    // Array — take first element
    if (Array.isArray(val) && val.length > 0) return coerceString(val[0]);
    // Last resort — JSON representation is more useful than "[object Object]"
    try { return JSON.stringify(val); } catch { return ""; }
  }
  return "";
}

// ── Feed Fetching ────────────────────────────────────────────

// Article image extraction lives in services/article-image.js
// (pure module; image-capture fix). It handles enclosure,
// media:content/media:thumbnail — including array shapes and
// media:group nesting — and runs every candidate through the
// SSRF + image checks in security.js.
// Must be called inside withTenant.
// feedRow: a row from feeds_v2 (id, url, name, tier, etc.)

async function fetchFeed(feedRow) {
  let httpStatus = null;
  // Failure containment (increment 1). Every statement below runs
  // inside a savepoint on the caller's transaction, so a failure
  // here rolls back THIS feed only. Before this, one bad row
  // aborted the whole tenant sweep: PostgreSQL rejected every
  // later statement with 25P02, the COMMIT degraded to ROLLBACK,
  // and the sibling feeds' articles were discarded while their
  // failure counters could not be written either.
  //
  // The savepoint wraps the try body rather than sitting inside
  // it, so the existing catch below runs with the transaction
  // already restored to a usable state. That is what makes the
  // bookkeeping in the catch able to succeed at all.
  const txClient = client();
  try {
    return await withSavepoint(txClient, `feed:${feedRow.id}`, async () => {
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

      // Fix malformed XML: replace bare & with &amp; while preserving
      // valid entities (&amp; &lt; &gt; &quot; &apos; &#123; &#xAB;).
      // Common in feeds that embed unescaped URLs like ?a=1&b=2.
      var sanitizedXml = xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/gi, '&amp;');

      const feed = await parser.parseString(sanitizedXml);
      let newArticles = 0;
      let linked = 0;
      const c = client();

      // Capture channel-level metadata from RSS XML
      const channelDescription = coerceString(feed.description).substring(0, 1000).trim();
      const channelCategories = Array.isArray(feed.categories)
        ? feed.categories.map(c => coerceString(c).trim()).filter(Boolean)
        : [];

      // Collect item-level categories across all articles in this poll
      const itemCategorySet = new Set(channelCategories);

      for (const item of feed.items || []) {
        // Aggregate item categories for feed-level classification
        if (Array.isArray(item.categories)) {
          for (const cat of item.categories) {
            const trimmed = coerceString(cat).trim();
            if (trimmed && itemCategorySet.size < 50) {
              itemCategorySet.add(trimmed);
            }
          }
        }

        const link = sanitizeLink(coerceString(item.link) || coerceString(item.guid));
        if (!link) continue;

        const rawSummary = coerceString(item.contentSnippet) || coerceString(item.content) || coerceString(item.summary) || "";
        const cleanSummary = sanitizeSummary(rawSummary);
        const cleanTitle = sanitizeTitle(coerceString(item.title) || "Untitled");

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

        const published = coerceString(item.isoDate) || coerceString(item.pubDate) || null;
        const hash = simpleHash(link + cleanTitle);
        const imageUrl = extractArticleImage(item);

        // Step 1: Insert into global articles_v2.
        // No tenant_id, no RLS. ON CONFLICT updates image_url
        // if the article exists but had no image previously.
        const articleResult = await c.query(
          `INSERT INTO articles_v2 (title, link, summary, published_at, content_hash, image_url)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (link) DO UPDATE
             SET image_url = COALESCE(articles_v2.image_url, EXCLUDED.image_url)
           RETURNING id, (xmax = 0) AS is_new`,
          [cleanTitle, link, cleanSummary, published, hash, imageUrl]
        );

        const articleId = articleResult.rows[0].id;
        if (articleResult.rows[0].is_new) newArticles++;

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

      // Update feed poll status, validation tracking, + metadata
      const categories = [...itemCategorySet];
      await c.query(
        `UPDATE feeds_v2
         SET last_polled_at = now(),
             last_error = NULL,
             consecutive_failures = 0,
             last_validation_grade = $2,
             last_validated_at = now(),
             feed_description = COALESCE(NULLIF($3, ''), feed_description),
             feed_categories = CASE
               WHEN $4::jsonb != '[]'::jsonb THEN $4::jsonb
               ELSE feed_categories
             END
         WHERE id = $1`,
        [feedRow.id, newArticles > 0 ? "A" : "B", channelDescription, JSON.stringify(categories)]
      );

      await logActivity("info", "feed_fetched", {
        feed: feedRow.name,
        status: httpStatus,
        newArticles,
        linked,
        totalItems: feed.items?.length || 0
      });

      return { newArticles, linked };
    });
  } catch (err) {
    // Build the failure detail once so the console and activity logs
    // stay identical. Include the underlying cause only when err.cause
    // carries it; HTTP-level errors (no err.cause) keep status instead.
    const err_failure = {
      status: httpStatus,
      error: err.message.substring(0, 300),
      feed: feedRow.id,
      feedName: feedRow.name,
      url: feedRow.url,
      ...(err.cause && {
        code: err.cause.code || null,
        message: String(err.cause.message || "").substring(0, 300)
      })
    };
    // Console first: this path must produce a record even if every
    // database write below is refused.
    platformLog("warn", "feed_fetch_failed", err_failure);

    // Failure bookkeeping. Each write takes its OWN savepoint,
    // because a bookkeeping statement that fails (a CHECK
    // violation on the grade, a permissions error) must not abort
    // the transaction and take the sibling feeds down with it.
    // That would recreate the exact defect this increment removes,
    // from the error path.
    //
    // These two writes were previously wrapped in a catch with an
    // empty body, justified by the transaction being aborted. With
    // the savepoint above, the transaction is NO LONGER aborted
    // when control reaches here, so these writes are expected to
    // SUCCEED and a failure is real news. tryBookkeeping reports
    // every failure with its SQLSTATE instead of discarding it.
    const failureRecorded = await tryBookkeeping(
      txClient,
      `feed-failure:${feedRow.id}`,
      () => txClient.query(
        `UPDATE feeds_v2
         SET last_error = $1,
             consecutive_failures = consecutive_failures + 1,
             last_validation_grade = 'F',
             last_validated_at = now()
         WHERE id = $2`,
        [err.message.substring(0, 500), feedRow.id]
      )
    );

    const activityRecorded = await tryBookkeeping(
      txClient,
      `feed-activity:${feedRow.id}`,
      () => logActivity("warn", "feed_fetch_failed", err_failure)
    );

    // A feed that failed AND could not record that it failed is
    // invisible to every health surface in the product: its grade
    // stays stale, consecutive_failures never climbs, and nothing
    // ever disables it. Surface that rather than returning a
    // clean-looking zero.
    if (!failureRecorded || !activityRecorded) {
      platformLog("error", "feed_failure_bookkeeping_incomplete", {
        feed: feedRow.id, feedName: feedRow.name,
        gradeRecorded: failureRecorded, activityRecorded,
        consequence: "feed health data is stale for this feed"
      });
    }

    return { newArticles: 0, linked: 0 };
  }
}

// ── Polling Cycle ────────────────────────────────────────────
// 2.88.21: the poll runs as a SEQUENCE of short classic withTenant
// transactions instead of one transaction around the whole sweep.
// withTenant resets savepoint accounting at every BEGIN
// (with-tenant.js resetSavepointScope), so each chunk starts with
// the full per-transaction savepoint allowance and every feed
// keeps its own savepoint. Under the old single-transaction shape
// a tenant with more feeds than the cap (DB_SAVEPOINT_CAP_PER_TXN,
// default 48) polled the tail of the sweep without isolation and
// savepoint_cap_reached fired (observed live: feed:121 at 48/48).
//
// Committed chunks stay committed if a later chunk fails. That is
// the same keep-the-completed-work stance the per-feed savepoints
// already take inside a transaction, now extended across chunks.
//
// NOT converted to withTenantWorkflow: the lease facade is
// query-only by contract (tenant-workflow.js) and the savepoint
// counter keys on the client object, so under the workflow the
// allowance would never renew and per-feed ROLLBACK TO handling
// would break. Classic short transactions give the renewal with
// no change to the shared db layer.

// Worst case one FAILING feed consumes three savepoint slots: the
// feed savepoint plus the two tryBookkeeping savepoints in
// fetchFeed's catch. The chunk size is derived from the live cap
// with that worst case in mind, so a chunk cannot exhaust its
// transaction's allowance even if every feed in it fails.
function feedChunkSize() {
  return Math.max(1, Math.floor(getSavepointCap() / 3));
}

// Full poll for one tenant. Manages its own transactions, so it
// must be called OUTSIDE any withTenant scope (the cron loop and
// the /api/research/poll route both call it bare). Returns the
// count of new articles, exactly as pollAllFeeds did.
export async function pollAllFeedsChunked(tenantId) {
  // Transaction A: read the sweep's feed list and announce it.
  const feeds = await withTenant(tenantId, async () => {
    const c = client();
    // Read feeds from the database instead of the hardcoded array
    const feedsResult = await c.query(
      `SELECT id, url, name, tier::text, refresh_minutes, last_polled_at
       FROM feeds_v2
       WHERE enabled = true
       ORDER BY last_polled_at ASC NULLS FIRST`
    );
    const feed_poll_started = { 
      feedCount: feedsResult.rows.length
    }
    await logActivity("debug", "feed_poll_started", feed_poll_started);
    platformLog("debug", "feed_poll_started", feed_poll_started);
    return feedsResult.rows;
  });

  let totalNew = 0;
  let totalLinked = 0;
  // Visibility (1.6.80): the per-feed refresh_minutes cooldown is
  // the binding rate limiter, so a poll pass that fetches nothing
  // is normal — these counters make that explicit on the console
  // instead of looking like a silent failure.
  let fetched = 0;
  let cooldownSkipped = 0;
  const minRefreshMinutes = feeds.length > 0
    ? Math.min(...feeds.map(f => f.refresh_minutes)) : null;

  // One short transaction per chunk. The cooldown check stays
  // inside the loop rather than becoming a pre-filter, so a feed
  // that comes due while the sweep is running is still picked up,
  // exactly as before.
  const chunkSize = feedChunkSize();
  for (let i = 0; i < feeds.length; i += chunkSize) {
    const chunk = feeds.slice(i, i + chunkSize);
    await withTenant(tenantId, async () => {
      for (const feedRow of chunk) {
        // Skip feeds that aren't due for polling yet
        if (feedRow.last_polled_at) {
          const minutesSincePoll = (Date.now() - new Date(feedRow.last_polled_at).getTime()) / 60000;
          if (minutesSincePoll < feedRow.refresh_minutes) {
            cooldownSkipped++;
            continue;
          }
        }

        const result = await fetchFeed(feedRow);
        fetched++;
        totalNew += result.newArticles;
        totalLinked += result.linked;
        await new Promise(r => setTimeout(r, 1500));
      }
    });
  }

  // Transaction B: prune old links and write the sweep summary.
  return withTenant(tenantId, async () => {
    const c = client();
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

    const feed_poll_complete = {
      newArticles: totalNew,
      linked: totalLinked,
      prunedLinks: pruned.rowCount,
      fetched, cooldownSkipped, minRefreshMinutes
    };
    await logActivity("debug", "feed_poll_complete", feed_poll_complete);
    platformLog("debug", "feed_poll_complete", feed_poll_complete);

    return totalNew;
  });
}

// ── Polling One Feed ─────────────────────────────────────────
// Must be called inside withTenant.
// feedId: UUID from feeds_v2.id — identifies the specific feed
// to test. Skips the refresh_minutes cooldown so it always
// polls regardless of when the feed was last checked. Returns
// diagnostic payload (feed name, URL, success/error, counts).

export async function pollSingleFeed(feedId) {
  const c = client();

  const feedResult = await c.query(
    `SELECT id, url, name, tier::text, refresh_minutes, last_polled_at, last_error
     FROM feeds_v2
     WHERE id = $1 AND enabled = true`,
    [feedId]
  );

  if (feedResult.rows.length === 0) {
    return { success: false, error: "Feed not found or disabled", feedId };
  }

  const feedRow = feedResult.rows[0];

  platformLog("info", "single_feed_poll_started", {
    feedId: feedRow.id, feedName: feedRow.name, url: feedRow.url
  });

    const result = await fetchFeed(feedRow);

  // Re-read the feed row to capture the updated last_error and
  // last_polled_at written by fetchFeed — this surfaces HTTP
  // failures and parse errors back to the caller without
  // changing fetchFeed's contract.
  const updated = await c.query(
    `SELECT last_polled_at, last_error FROM feeds_v2 WHERE id = $1`,
    [feedId]
  );
  const updatedRow = updated.rows[0] || {};

  return {
    success: !updatedRow.last_error,
    feed: {
      id: feedRow.id,
      name: feedRow.name,
      url: feedRow.url,
      tier: feedRow.tier
    },
    newArticles: result.newArticles,
    linked: result.linked,
    lastPolledAt: updatedRow.last_polled_at,
    lastError: updatedRow.last_error || null
  };
}

// ── Query Articles ───────────────────────────────────────────
// Must be called inside withTenant.

export async function getArticlesForTopic(topicSlug, maxAgeDays = null, limit = null) {
  const ageDays = maxAgeDays || getMaxAgeDays();
  const articleLimit = limit || getMaxResearchArticles();
  const version = await getFeedsManagerVersion();

  if (version === 2) {
    return _getArticlesForTopicV2(topicSlug, ageDays, articleLimit);
  }
  return _getArticlesForTopicV1(topicSlug, ageDays, articleLimit);
}

// ── v1: feed_topics + catchall (today's behavior) ────────────
// Smart sort: topic-specific articles fill first, catchall second.

async function _getArticlesForTopicV1(topicSlug, ageDays, articleLimit) {
  const c = client();
  const r = await c.query(
    `SELECT DISTINCT a.id, a.title, a.link, a.summary, a.published_at,
            a.image_url, f.name AS feed_name, f.tier::text AS feed_tier
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
// Three-tier priority:
//   0: explicit feed_topics mapping (topic-specific)
//   1: domain tag overlap score > threshold
//   2: catchall baseline
//
// Application-side filtering: query returns all candidates,
// JavaScript scores domain matches and sorts.

async function _getArticlesForTopicV2(topicSlug, ageDays, articleLimit) {
  const c = client();
  const threshold = getDomainMatchThreshold();

  const topicResult = await c.query(
    `SELECT domains FROM topics WHERE slug = $1`,
    [topicSlug]
  );
  const rawDomains = topicResult.rows[0]?.domains || [];
  // Defensive: pg driver may return JSONB as string or array
  const topicDomains = Array.isArray(rawDomains)
    ? rawDomains
    : (() => { try { const p = JSON.parse(rawDomains); return Array.isArray(p) ? p : []; } catch { return []; } })();

  const r = await c.query(
    `SELECT DISTINCT a.id, a.title, a.link, a.summary, a.published_at,
            a.image_url, f.name AS feed_name, f.tier::text AS feed_tier,
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

  platformLog("info", "v2_match_candidates", {
    topicSlug, topicDomains, threshold,
    totalCandidates: r.rows.length,
    feedBreakdown: Object.entries(
      r.rows.reduce((acc, a) => { acc[a.feed_name] = (acc[a.feed_name] || 0) + 1; return acc; }, {})
    ).map(([name, count]) => `${name}:${count}`).join(", ")
  });

  const scored = [];
  for (const a of r.rows) {
    let priority;

    if (a.is_topic_specific) {
      priority = 0;
    } else {
      const score = domainMatchScore(a.feed_domains || [], topicDomains);
      if (score > threshold) {
        priority = 1;
      } else if (a.is_catchall) {
        priority = 2;
      } else {
        continue;
      }
    }

    scored.push({
      id: a.id, title: a.title, link: a.link, summary: a.summary,
      published_at: a.published_at, feed_name: a.feed_name,
      feed_tier: a.feed_tier, _priority: priority
    });
  }

  // Log priority distribution
  const dist = { p0: 0, p1: 0, p2: 0 };
  scored.forEach(s => { dist[`p${s._priority}`]++; });
  platformLog("info", "v2_match_result", {
    topicSlug, scored: scored.length, limit: articleLimit, ...dist
  });

  scored.sort((a, b) =>
    (a._priority || 0) - (b._priority || 0) ||
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
           a.image_url, f.name AS feed_name, f.tier::text AS feed_tier
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

export async function getArticleStats(topicSlug = null, deps = {}) {
  const c = deps.client ? deps.client() : client();
  const ageDays = getMaxAgeDays();
  // 2.5.54: optional topic filter, the SAME feed_topics join the
  // article queries already use, applied to ALL THREE counts so the
  // aggregate and the per-feed rows agree with each other. Always
  // parameterized; a null slug is the unfiltered card of today.
  // 2.5.86: the filter matches what GENERATION actually reads for a
  // topic: feeds mapped to it PLUS the tenant's catchall feeds, the
  // same LEFT JOIN + (t.id IS NOT NULL OR f.is_catchall) predicate
  // the article-selection queries above use. Applied to ALL THREE
  // counts (the 2.5.54 rule) so aggregate and rows agree.
  const topicJoin = topicSlug
    ? `LEFT JOIN feed_topics ft ON ft.feed_id = f.id
       LEFT JOIN topics t ON t.id = ft.topic_id AND t.slug = $2`
    : "";
  const topicPredicate = topicSlug
    ? `AND (t.id IS NOT NULL OR f.is_catchall = true)`
    : "";
  const totalTopicJoin = topicSlug
    ? `JOIN feeds_v2 f ON f.id = fa.feed_id
       LEFT JOIN feed_topics ft ON ft.feed_id = f.id
       LEFT JOIN topics t ON t.id = ft.topic_id AND t.slug = $1`
    : "";
  const totalPredicate = topicSlug
    ? `WHERE (t.id IS NOT NULL OR f.is_catchall = true)`
    : "";

  const total = await c.query(
    `SELECT COUNT(DISTINCT fa.article_id)::int AS count
     FROM feed_articles fa
     ${totalTopicJoin}
     ${totalPredicate}`,
    topicSlug ? [topicSlug] : []
  );
  const byFeed = await c.query(
    `SELECT f.name AS feed_name, f.tier::text AS feed_tier,
            f.is_catchall,
            COUNT(DISTINCT fa.article_id)::int AS count
     FROM feed_articles fa
     JOIN feeds_v2 f ON f.id = fa.feed_id
     JOIN articles_v2 a ON a.id = fa.article_id
     ${topicJoin}
     WHERE a.published_at >= now() - ($1 || ' days')::interval
     ${topicPredicate}
     GROUP BY f.name, f.tier, f.is_catchall
     ORDER BY CASE f.tier::text
                WHEN 'authoritative' THEN 1
                WHEN 'primary' THEN 2
                WHEN 'secondary' THEN 3
                ELSE 4
              END, f.name`,
    topicSlug ? [String(ageDays), topicSlug] : [String(ageDays)]
  );
  const recent = await c.query(
    `SELECT COUNT(DISTINCT fa.article_id)::int AS count
     FROM feed_articles fa
     JOIN feeds_v2 f ON f.id = fa.feed_id
     JOIN articles_v2 a ON a.id = fa.article_id
     ${topicJoin}
     WHERE a.published_at >= now() - ($1 || ' days')::interval
     ${topicPredicate}`,
    topicSlug ? [String(ageDays), topicSlug] : [String(ageDays)]
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
    platformLog("info", "running_feed_poll_all_tenants", { tenants: tenants.length });
  } catch (err) {
    console.error("[news-monitor] failed to list tenants:", err.message);
    return;
  }

  // Payments (2.3.1.1): lazy import per the module-loads-DB-free
  // discipline; automated processing halts outside good standing.
  const { isTenantProcessingAllowed } = await import("./entitlements.js");
  for (const tenant of tenants) {
    // Payments (2.3.1.1): automated processing halts for tenants
    // outside good standing. Fail-closed: a read failure skips.
    if (!(await isTenantProcessingAllowed(tenant.id))) {
      console.log(`[news_monitor] tenant ${tenant.slug || tenant.id} skipped: subscription not in good standing`);
      continue;
    }
    try {
      // 2.88.21: the poll manages its own short per-chunk
      // transactions, so it is called bare rather than inside
      // one long withTenant envelope.
      await pollAllFeedsChunked(tenant.id);
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

  // Recurring poll for all tenants. Schedule is FEED_POLL_CRON
  // (validated; numeric 5-field syntax) with hourly as the safe
  // default — an invalid value logs loudly and polling continues
  // hourly rather than silently stopping.
  const sched = resolvePollSchedule(process.env.FEED_POLL_CRON);
  if (!sched.valid) {
    console.error(`[news-monitor] FEED_POLL_CRON "${sched.rejected}" is not a supported cron expression — using default "${sched.expression}" (hourly)`);
    platformLog("error", "feed_poll_cron_invalid", { rejected: sched.rejected, using: sched.expression });
  }
  monitorJob = cron.schedule(sched.expression, () => {
    runPollForAllTenants().catch(err => {
      console.error("[news-monitor] scheduled poll failed:", err.message);
    });
  });

  console.log(`📡 News monitor started — polling feeds on "${sched.expression}" (${sched.source}); per-feed refresh_minutes cooldowns gate each fetch (see feed_poll_complete for fetched/cooldownSkipped/minRefreshMinutes)`);
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
