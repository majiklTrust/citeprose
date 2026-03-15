// ═══════════════════════════════════════════════════════════════
// News Monitor Service — RSS feed ingestion & article storage
// ═══════════════════════════════════════════════════════════════

import Parser from "rss-parser";
import cron from "node-cron";
import { logActivity } from "./database.js";
import { FEEDS } from "../config/feeds.js";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "LinkedInAIAgent/1.5 (RSS Reader)" }
});

let db;
let monitorJob = null;

export function setDatabase(database) {
  db = database;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_name     TEXT NOT NULL,
      feed_tier     TEXT NOT NULL,
      topic_ids     TEXT NOT NULL,
      title         TEXT NOT NULL,
      link          TEXT UNIQUE NOT NULL,
      summary       TEXT,
      published_at  DATETIME,
      fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      content_hash  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
    CREATE INDEX IF NOT EXISTS idx_articles_topic ON articles(topic_ids);
    CREATE INDEX IF NOT EXISTS idx_articles_link ON articles(link);
  `);
}

// ── Feed Fetching ────────────────────────────────────────────

async function fetchFeed(feedConfig) {
  try {
    const feed = await parser.parseURL(feedConfig.url);
    let newCount = 0;

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO articles
        (feed_name, feed_tier, topic_ids, title, link, summary, published_at, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of feed.items || []) {
      const link = item.link || item.guid;
      if (!link) continue;

      const rawSummary = item.contentSnippet || item.content || item.summary || "";
      const cleanSummary = rawSummary
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1000);

      const published = item.isoDate || item.pubDate || null;
      const hash = simpleHash(link + (item.title || ""));

      const result = insertStmt.run(
        feedConfig.name,
        feedConfig.tier,
        JSON.stringify(feedConfig.topicIds),
        (item.title || "Untitled").slice(0, 500),
        link,
        cleanSummary,
        published,
        hash
      );

      if (result.changes > 0) newCount++;
    }

    if (newCount > 0) {
      logActivity("info", "feed_fetched", {
        feed: feedConfig.name,
        newArticles: newCount,
        totalItems: feed.items?.length || 0
      });
    }

    return newCount;
  } catch (err) {
    logActivity("warn", "feed_fetch_failed", {
      feed: feedConfig.name,
      error: err.message
    });
    return 0;
  }
}

// ── Polling Cycle ────────────────────────────────────────────

export async function pollAllFeeds() {
  logActivity("info", "feed_poll_started", { feedCount: FEEDS.length });

  let totalNew = 0;
  for (const feedConfig of FEEDS) {
    const count = await fetchFeed(feedConfig);
    totalNew += count;
    await new Promise(r => setTimeout(r, 1500));
  }

  const pruned = db.prepare(`
    DELETE FROM articles WHERE published_at < datetime('now', '-60 days')
  `).run();

  logActivity("info", "feed_poll_complete", {
    newArticles: totalNew,
    pruned: pruned.changes
  });

  return totalNew;
}

// ── Query Articles ───────────────────────────────────────────

export function getArticlesForTopic(topicId, maxAgeDays = 14, limit = 30) {
  const rows = db.prepare(`
    SELECT * FROM articles
    WHERE topic_ids LIKE ?
      AND published_at >= datetime('now', ?)
    ORDER BY published_at DESC
    LIMIT ?
  `).all(`%"${topicId}"%`, `-${maxAgeDays} days`, limit);

  return rows.map(r => ({
    ...r,
    topic_ids: JSON.parse(r.topic_ids)
  }));
}

export function searchArticles(keywords, topicId = null, maxAgeDays = 30, limit = 20) {
  const conditions = [];
  const params = [];

  for (const kw of keywords) {
    conditions.push("(title LIKE ? OR summary LIKE ?)");
    params.push(`%${kw}%`, `%${kw}%`);
  }

  if (topicId) {
    conditions.push("topic_ids LIKE ?");
    params.push(`%"${topicId}"%`);
  }

  conditions.push("published_at >= datetime('now', ?)");
  params.push(`-${maxAgeDays} days`);
  params.push(limit);

  const sql = `
    SELECT * FROM articles
    WHERE ${conditions.join(" AND ")}
    ORDER BY published_at DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...params).map(r => ({
    ...r,
    topic_ids: JSON.parse(r.topic_ids)
  }));
}

export function getArticleStats() {
  const total = db.prepare("SELECT COUNT(*) as count FROM articles").get();
  const byFeed = db.prepare(`
    SELECT feed_name, feed_tier, COUNT(*) as count
    FROM articles GROUP BY feed_name ORDER BY count DESC
  `).all();
  const recent = db.prepare(`
    SELECT COUNT(*) as count FROM articles
    WHERE published_at >= datetime('now', '-7 days')
  `).get();

  return { totalArticles: total.count, last7Days: recent.count, byFeed };
}

// ── Monitor Lifecycle ────────────────────────────────────────

export function startMonitor() {
  initTables();

  pollAllFeeds().catch(err => {
    logActivity("error", "initial_feed_poll_failed", err.message);
  });

  monitorJob = cron.schedule("0 * * * *", () => {
    pollAllFeeds().catch(err => {
      logActivity("error", "scheduled_feed_poll_failed", err.message);
    });
  });

  console.log("📡 News monitor started — polling feeds every hour");
  logActivity("info", "news_monitor_started", { feedCount: FEEDS.length });
}

export function stopMonitor() {
  if (monitorJob) {
    monitorJob.stop();
    logActivity("info", "news_monitor_stopped", null);
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
