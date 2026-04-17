// ═══════════════════════════════════════════════════════════════
// News Monitor Service — RSS feed ingestion & article storage
// ═══════════════════════════════════════════════════════════════
//
// Articles are stored per-tenant. The FEEDS config is shared
// across tenants in v1 (same URLs, same topic mappings) but
// each tenant gets its own article rows. This duplicates storage
// but keeps RLS simple and tenant isolation strict. A shared-
// articles model with a join table is a future optimization.
//
// Two entry patterns:
//   1. API routes (api.js) — wrapped in withTenant by the handler.
//      getArticlesForTopic, searchArticles, getArticleStats,
//      pollAllFeeds all assume tenant context is set.
//   2. Cron loop (startMonitor) — no request. The cron callback
//      iterates all active tenants and wraps each tenant's
//      pollAllFeeds in its own withTenant block.

import Parser from "rss-parser";
import cron from "node-cron";
import { logActivity } from "./database.js";
import { FEEDS } from "../config/feeds.js";
import { sanitizeTitle, sanitizeSummary, sanitizeLink, detectPromptInjection } from "./sanitize-content.js";
import { currentClient } from "../db/with-tenant.js";
import { withTenant } from "../db/with-tenant.js";
import { listActiveTenants } from "../tenant/platform-db.js";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "LinkedInAIAgent/1.5 (RSS Reader)" }
});

let monitorJob = null;

// Returns the current tenant's pg.Client from AsyncLocalStorage.
// Throws if called outside withTenant — same pattern as database.js.
function client() {
  const c = currentClient();
  if (!c) {
    throw new Error("news-monitor operation requires tenant context (call inside withTenant)");
  }
  return c;
}

// ── Feed Fetching ────────────────────────────────────────────
// Must be called inside withTenant.

async function fetchFeed(feedConfig) {
  try {
    const feed = await parser.parseURL(feedConfig.url);
    let newCount = 0;
    const c = client();

    for (const item of feed.items || []) {
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
          feed: feedConfig.name,
          link,
          titlePatterns: titleInjection.patterns,
          summaryPatterns: summaryInjection.patterns
        });
        continue;
      }

      const published = item.isoDate || item.pubDate || null;
      const hash = simpleHash(link + cleanTitle);

      // INSERT ... ON CONFLICT DO NOTHING replaces SQLite's
      // INSERT OR IGNORE. The unique constraint is (tenant_id, link)
      // so re-fetching the same article under the same tenant is a
      // no-op. tenant_id is set from current_tenant_id() for RLS.
      const result = await c.query(
        `INSERT INTO articles
           (tenant_id, feed_name, feed_tier, topic_slugs, title, link, summary, published_at, content_hash)
         VALUES (current_tenant_id(), $1, $2::feed_tier, $3::jsonb, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, link) DO NOTHING
         RETURNING id`,
        [
          feedConfig.name,
          feedConfig.tier,
          JSON.stringify(feedConfig.topicIds),
          cleanTitle,
          link,
          cleanSummary,
          published,
          hash
        ]
      );

      if (result.rowCount > 0) newCount++;
    }

    if (newCount > 0) {
      await logActivity("info", "feed_fetched", {
        feed: feedConfig.name,
        newArticles: newCount,
        totalItems: feed.items?.length || 0
      });
    }

    return newCount;
  } catch (err) {
    await logActivity("warn", "feed_fetch_failed", {
      feed: feedConfig.name,
      error: err.message
    });
    return 0;
  }
}

// ── Polling Cycle ────────────────────────────────────────────
// Must be called inside withTenant.

export async function pollAllFeeds() {
  await logActivity("info", "feed_poll_started", { feedCount: FEEDS.length });

  let totalNew = 0;
  for (const feedConfig of FEEDS) {
    const count = await fetchFeed(feedConfig);
    totalNew += count;
    await new Promise(r => setTimeout(r, 1500));
  }

  // Prune articles older than 60 days. tenant_id filter is enforced
  // by RLS automatically — the WHERE on published_at is all we add.
  const c = client();
  const pruned = await c.query(
    `DELETE FROM articles WHERE published_at < now() - interval '60 days'`
  );

  await logActivity("info", "feed_poll_complete", {
    newArticles: totalNew,
    pruned: pruned.rowCount
  });

  return totalNew;
}

// ── Query Articles ───────────────────────────────────────────
// Must be called inside withTenant.

export async function getArticlesForTopic(topicId, maxAgeDays = 14, limit = 30) {
  const c = client();
  // JSONB containment: topic_slugs @> '"<slug>"' matches when the
  // array contains the slug string. Much cleaner than SQLite's
  // LIKE '%"<slug>"%' pattern and uses the GIN index.
  const r = await c.query(
    `SELECT id, tenant_id, feed_name, feed_tier, topic_slugs AS topic_ids,
            title, link, summary, published_at, fetched_at, content_hash
     FROM articles
     WHERE topic_slugs @> $1::jsonb
       AND published_at >= now() - ($2 || ' days')::interval
     ORDER BY published_at DESC
     LIMIT $3`,
    [JSON.stringify(topicId), String(maxAgeDays), limit]
  );
  return r.rows;
}

export async function searchArticles(keywords, topicId = null, maxAgeDays = 30, limit = 20) {
  const c = client();
  const conditions = [];
  const params = [];
  let i = 1;

  for (const kw of keywords) {
    conditions.push(`(title ILIKE $${i} OR summary ILIKE $${i})`);
    params.push(`%${kw}%`);
    i++;
  }

  if (topicId) {
    conditions.push(`topic_slugs @> $${i}::jsonb`);
    params.push(JSON.stringify(topicId));
    i++;
  }

  conditions.push(`published_at >= now() - ($${i} || ' days')::interval`);
  params.push(String(maxAgeDays));
  i++;
  params.push(limit);

  const sql = `
    SELECT id, tenant_id, feed_name, feed_tier, topic_slugs AS topic_ids,
           title, link, summary, published_at, fetched_at, content_hash
    FROM articles
    WHERE ${conditions.join(" AND ")}
    ORDER BY published_at DESC
    LIMIT $${i}
  `;

  const r = await c.query(sql, params);
  return r.rows;
}

export async function getArticleStats() {
  const c = client();

  const total = await c.query("SELECT COUNT(*)::int AS count FROM articles");
  const byFeed = await c.query(
    `SELECT feed_name, feed_tier, COUNT(*)::int AS count
     FROM articles
     GROUP BY feed_name, feed_tier
     ORDER BY count DESC`
  );
  const recent = await c.query(
    `SELECT COUNT(*)::int AS count FROM articles
     WHERE published_at >= now() - interval '7 days'`
  );

  return {
    totalArticles: total.rows[0].count,
    last7Days: recent.rows[0].count,
    byFeed: byFeed.rows
  };
}

// ── Monitor Lifecycle ────────────────────────────────────────
//
// Schema is managed externally by the DDL files in data/pgsql/.
// initTables() is no longer needed. setDatabase() is gone — the
// pool and tenant context are resolved via imports from src/db/.

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
