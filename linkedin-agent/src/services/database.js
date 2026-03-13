// ═══════════════════════════════════════════════════════════════
// Database Service — SQLite persistence for post history & state
// ═══════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../../data/agent.db");

let db;

export function initDatabase() {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id      TEXT NOT NULL,
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      hashtags      TEXT,           -- JSON array
      status        TEXT NOT NULL DEFAULT 'draft',
        -- draft | pending_approval | approved | posted | rejected | failed
      linkedin_id   TEXT,           -- LinkedIn post URN after posting
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      scheduled_for DATETIME,
      posted_at     DATETIME,
      error_message TEXT,
      news_context  TEXT            -- source context used for generation
    );

    CREATE TABLE IF NOT EXISTS agent_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP,
      level      TEXT NOT NULL,
      action     TEXT NOT NULL,
      details    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
    CREATE INDEX IF NOT EXISTS idx_posts_posted_at ON posts(posted_at);
    CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_for);
  `);

  // Initialize default agent state
  const upsert = db.prepare(`
    INSERT OR IGNORE INTO agent_state (key, value) VALUES (?, ?)
  `);
  upsert.run("mode", process.env.AGENT_MODE || "manual");
  upsert.run("last_topic_id", "");
  upsert.run("paused", "false");

  return db;
}

// ── Post CRUD ────────────────────────────────────────────────

export function createPost({ topicId, title, content, hashtags, newsContext, scheduledFor }) {
  const stmt = db.prepare(`
    INSERT INTO posts (topic_id, title, content, hashtags, news_context, scheduled_for, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft')
  `);
  const result = stmt.run(topicId, title, content, JSON.stringify(hashtags), newsContext, scheduledFor);
  return result.lastInsertRowid;
}

export function getPost(id) {
  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
  if (row && row.hashtags) row.hashtags = JSON.parse(row.hashtags);
  return row;
}

export function updatePostStatus(id, status, extra = {}) {
  const sets = ["status = ?"];
  const params = [status];

  if (extra.linkedinId) {
    sets.push("linkedin_id = ?");
    params.push(extra.linkedinId);
  }
  if (extra.postedAt) {
    sets.push("posted_at = ?");
    params.push(extra.postedAt);
  }
  if (extra.errorMessage) {
    sets.push("error_message = ?");
    params.push(extra.errorMessage);
  }

  params.push(id);
  db.prepare(`UPDATE posts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function getPostsByStatus(status) {
  const rows = db.prepare("SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC").all(status);
  return rows.map(r => ({ ...r, hashtags: r.hashtags ? JSON.parse(r.hashtags) : [] }));
}

export function getRecentPosts(days = 10) {
  const rows = db.prepare(`
    SELECT * FROM posts
    WHERE posted_at >= datetime('now', ?)
      AND status = 'posted'
    ORDER BY posted_at DESC
  `).all(`-${days} days`);
  return rows.map(r => ({ ...r, hashtags: r.hashtags ? JSON.parse(r.hashtags) : [] }));
}

export function getAllPosts(limit = 50) {
  const rows = db.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map(r => ({ ...r, hashtags: r.hashtags ? JSON.parse(r.hashtags) : [] }));
}

export function getLastPostedTopic() {
  const row = db.prepare(`
    SELECT topic_id FROM posts WHERE status = 'posted' ORDER BY posted_at DESC LIMIT 1
  `).get();
  return row?.topic_id || null;
}

// ── Agent State ──────────────────────────────────────────────

export function getAgentState(key) {
  const row = db.prepare("SELECT value FROM agent_state WHERE key = ?").get(key);
  return row?.value;
}

export function setAgentState(key, value) {
  db.prepare("INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)").run(key, String(value));
}

// ── Activity Log ─────────────────────────────────────────────

export function logActivity(level, action, details = null) {
  db.prepare("INSERT INTO activity_log (level, action, details) VALUES (?, ?, ?)").run(
    level, action, typeof details === "string" ? details : JSON.stringify(details)
  );
}

export function getActivityLog(limit = 100) {
  return db.prepare("SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ?").all(limit);
}

// ── Stats ────────────────────────────────────────────────────

export function getPostStats() {
  const total = db.prepare("SELECT COUNT(*) as count FROM posts WHERE status = 'posted'").get();
  const byTopic = db.prepare(`
    SELECT topic_id, COUNT(*) as count FROM posts WHERE status = 'posted' GROUP BY topic_id
  `).all();
  const last10Days = getRecentPosts(10);
  const pending = db.prepare("SELECT COUNT(*) as count FROM posts WHERE status = 'pending_approval'").get();

  return {
    totalPosted: total.count,
    byTopic,
    postsLast10Days: last10Days.length,
    pendingApproval: pending.count,
    recentPosts: last10Days
  };
}
