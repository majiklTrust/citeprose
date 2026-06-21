// ═══════════════════════════════════════════════════════════════
// src/services/database.js — async Postgres wrapper
// ═══════════════════════════════════════════════════════════════
// Per-tenant database operations. Every function must be called
// inside a withTenant() block so that:
//   1. app.current_tenant_id is SET LOCAL for RLS policies
//   2. a dedicated pg.Client is checked out for the transaction
// Outside withTenant, calls throw a tenant-context error.
//
// This module preserves the public API shape of the pre-conversion
// SQLite wrapper: the 13 exported function names are unchanged,
// arguments are unchanged, return shapes are unchanged. Internals
// are rewritten to use pg + RLS. Callers convert to async/await
// but are otherwise untouched.
//
// Schema management is NOT done here. The DDL lives in
// linkedin-agent/data/pgsql/ and is applied externally via psql.
// initDatabase() is kept as a throwing legacy stub so any caller
// that still invokes it (e.g., old startup code) fails loudly.
// ═══════════════════════════════════════════════════════════════

import { currentClient, currentTenantId } from "../db/with-tenant.js";

// ── Internal helpers ─────────────────────────────────────────

// Every data-access function calls this first. Returns the
// RLS-scoped pg.Client from the current withTenant block.
// Throws a tenant-context error if called outside one.
function client() {
  const c = currentClient();
  if (!c) {
    throw new Error("database operation requires tenant context (call inside withTenant)");
  }
  return c;
}

// Validates scheduledFor and returns a value the pg driver can
// serialize into a TIMESTAMPTZ column. Accepts:
//   - null / undefined       → returned as null
//   - Date object            → returned as-is (pg driver handles it)
//   - string ending in Z     → returned as-is (UTC marker)
//   - string ending in +hh:mm or +hhmm → returned as-is (explicit offset)
// Rejects anything else, including naive datetime strings that
// Postgres would silently parse in server-local timezone.
function validateScheduledFor(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "string") {
    throw new TypeError("scheduledFor must be a Date, timezone-aware string, or null");
  }
  const tzAware = /Z$|[+-]\d{2}:?\d{2}$/.test(value);
  if (!tzAware) {
    throw new TypeError(
      "scheduledFor string must be timezone-aware (ISO 8601 with Z or offset)"
    );
  }
  return value;
}

// Resolves a topic slug to its BIGINT id within the current tenant.
// Throws a slug-identifying error if not found so callers (and tests)
// can distinguish "unknown topic" from generic DB errors.
async function resolveTopicIdBySlug(c, slug) {
  const r = await c.query(
    "SELECT id FROM topics WHERE slug = $1",
    [slug]
  );
  if (r.rows.length === 0) {
    throw new Error(`topic not found for slug: ${slug}`);
  }
  return r.rows[0].id;
}

// ── Legacy schema init — intentionally throws ────────────────
// In the SQLite era this function created tables and seeded
// default agent_state on every app startup. Under Postgres,
// schema is applied once via the DDL files in data/pgsql/ by
// an operator running psql. Default agent_state is seeded by
// the migration script (scripts/migration/sqlite-to-postgres.mjs)
// or by an explicit admin workflow.
//
// Any caller that still invokes initDatabase() is running legacy
// startup logic that needs to be removed. Throwing loudly is the
// safe default — silent no-op would let the bug live in prod.
export function initDatabase() {
  throw new Error(
    "initDatabase() is legacy — Postgres schema is managed externally " +
    "via data/pgsql/ DDL files. Remove this call from the app startup path."
  );

  // UNREACHABLE CODE
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

export async function createPost({ topicId, title, content, hashtags, newsContext, scheduledFor, imageUrl, genre }) {
  const c = client();
  const scheduled = validateScheduledFor(scheduledFor);
  const topicIntId = await resolveTopicIdBySlug(c, topicId);

  // news_context is JSONB nullable; pass JS object or null directly.
  // If caller passed a string, keep current behavior and wrap it
  // under a "raw" key so JSONB storage is consistent.
  let nc = null;
  if (newsContext != null) {
    nc = typeof newsContext === "string" ? { raw: newsContext } : newsContext;
  }

  const r = await c.query(
    `INSERT INTO posts (tenant_id, topic_id, title, content, hashtags, news_context, scheduled_for, image_url, status, genre)
     VALUES (current_tenant_id(), $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, 'draft', $8)
     RETURNING id`,
    [topicIntId, title, content, JSON.stringify(hashtags || []), nc == null ? null : JSON.stringify(nc), scheduled, imageUrl || null, genre || 'default']
  );
  return r.rows[0].id;
}

// Returns a post row with hashtags parsed as a JS array.
// pg driver returns JSONB columns as already-parsed JS values,
// so hashtags comes back as an array natively — we normalize
// null to [] to match pre-conversion behavior.
export async function getPost(id) {
  const c = client();
  const r = await c.query(
    `SELECT p.id, p.tenant_id, t.slug AS topic_id, p.title, p.content,
            p.hashtags, p.status, p.linkedin_id, p.created_at,
            p.scheduled_for, p.posted_at, p.error_message, p.news_context,
            p.image_url
     FROM posts p
     LEFT JOIN topics t ON t.id = p.topic_id
     WHERE p.id = $1`,
    [id]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  if (!Array.isArray(row.hashtags)) row.hashtags = row.hashtags || [];
  return row;
}

// Updates editable fields on a post. Only title/content/hashtags are
// supported — these are the user-facing fields a manual editor would
// change. Strict guard: rejects any update against a post whose status
// is not pending_approval. Editing a posted/approved/rejected/blocked
// post would diverge the database from external state (LinkedIn).
//
// Returns the updated row, or throws if the post doesn't exist or is
// in a non-editable state. The caller (route handler) maps thrown
// errors to appropriate HTTP responses.
export async function updatePost(id, fields) {
  const c = client();

  // Status check + lock the row for the duration of the transaction.
  // SELECT FOR UPDATE prevents a concurrent approve/reject from
  // changing status between our check and our UPDATE.
  const guard = await c.query(
    `SELECT id, status FROM posts WHERE id = $1 FOR UPDATE`,
    [id]
  );
  if (guard.rows.length === 0) {
    const err = new Error(`Post ${id} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  if (guard.rows[0].status !== "pending_approval") {
    const err = new Error(
      `Post ${id} is not editable (status: ${guard.rows[0].status}). Only pending_approval posts can be edited.`
    );
    err.code = "NOT_EDITABLE";
    throw err;
  }

  // Only the three caller-supplied fields are written. Unsupplied
  // fields are left as-is (no NULL-out by accident).
  const sets = [];
  const params = [];
  let i = 1;

  if (typeof fields.title === "string") {
    sets.push(`title = $${i++}`);
    params.push(fields.title);
  }
  if (typeof fields.content === "string") {
    sets.push(`content = $${i++}`);
    params.push(fields.content);
  }
  if (Array.isArray(fields.hashtags)) {
    sets.push(`hashtags = $${i++}::jsonb`);
    params.push(JSON.stringify(fields.hashtags));
  }
  if (fields.image_url !== undefined) {
    // null clears the image (text-only post), string sets it
    sets.push(`image_url = $${i++}`);
    params.push(fields.image_url || null);
  }

  if (sets.length === 0) {
    const err = new Error("No editable fields supplied");
    err.code = "NO_FIELDS";
    throw err;
  }

  params.push(id);
  const r = await c.query(
    `UPDATE posts SET ${sets.join(", ")} WHERE id = $${i}
     RETURNING id, title, content, hashtags, status, image_url`,
    params
  );

  const row = r.rows[0];
  if (!Array.isArray(row.hashtags)) row.hashtags = row.hashtags || [];
  return row;
}

export async function deletePost(id) {
  // Hard-delete a DRAFT only. Forced RLS scopes the DELETE to the
  // current tenant (call this inside withTenant), and the status
  // guard prevents discarding a pending/scheduled/published post
  // through this path. Returns true only if a row was removed.
  const c = client();
  const result = await c.query(
    `DELETE FROM posts WHERE id = $1 AND status = 'draft' RETURNING id`,
    [id]
  );
  return result.rowCount > 0;
}

export async function updatePostStatus(id, status, extra = {}) {
  const c = client();
  const sets = ["status = $1::post_status"];
  const params = [status];
  let i = 2;

  if (extra.linkedinId) {
    sets.push(`linkedin_id = $${i++}`);
    params.push(extra.linkedinId);
  }
  if (extra.postedAt) {
    sets.push(`posted_at = $${i++}`);
    params.push(extra.postedAt);
  }
  if (extra.errorMessage) {
    sets.push(`error_message = $${i++}`);
    params.push(extra.errorMessage);
  }

  params.push(id);
  await c.query(
    `UPDATE posts SET ${sets.join(", ")} WHERE id = $${i}`,
    params
  );
}

// Returns all posts with the given status, most recent first.
// Each row's hashtags is guaranteed to be an array.
export async function getPostsByStatus(status) {
  const c = client();
  const r = await c.query(
    `SELECT p.id, p.tenant_id, t.slug AS topic_id, p.title, p.content,
            p.hashtags, p.status, p.linkedin_id, p.created_at,
            p.scheduled_for, p.posted_at, p.error_message, p.news_context,
            p.image_url
     FROM posts p
     LEFT JOIN topics t ON t.id = p.topic_id
     WHERE p.status = $1::post_status
     ORDER BY p.created_at DESC`,
    [status]
  );
  return r.rows.map(normalizeHashtags);
}

export async function getRecentPosts(days = 10) {
  const c = client();
  const r = await c.query(
    `SELECT p.id, p.tenant_id, t.slug AS topic_id, p.title, p.content,
            p.hashtags, p.status, p.linkedin_id, p.created_at,
            p.scheduled_for, p.posted_at, p.error_message, p.news_context,
            p.image_url
     FROM posts p
     LEFT JOIN topics t ON t.id = p.topic_id
     WHERE p.posted_at >= now() - ($1 || ' days')::interval
       AND p.status = 'posted'::post_status
     ORDER BY p.posted_at DESC`,
    [String(days)]
  );
  return r.rows.map(normalizeHashtags);
}

export async function getAllPosts(limit = 50) {
  const c = client();
  const r = await c.query(
    `SELECT p.id, p.tenant_id, t.slug AS topic_id, p.title, p.content,
            p.hashtags, p.status, p.linkedin_id, p.created_at,
            p.scheduled_for, p.posted_at, p.error_message, p.news_context,
            p.image_url
     FROM posts p
     LEFT JOIN topics t ON t.id = p.topic_id
     ORDER BY p.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows.map(normalizeHashtags);
}

// Returns the slug of the most recently posted topic, or null
// if no posts with status='posted' exist for this tenant. JOIN
// to topics preserves the pre-conversion caller contract (slug
// string, not integer id).
export async function getLastPostedTopic() {
  const c = client();
  const r = await c.query(
    `SELECT t.slug
     FROM posts p
     JOIN topics t ON t.id = p.topic_id
     WHERE p.status = 'posted'::post_status
     ORDER BY p.posted_at DESC
     LIMIT 1`
  );
  return r.rows.length === 0 ? null : r.rows[0].slug;
}

function normalizeHashtags(row) {
  if (!Array.isArray(row.hashtags)) row.hashtags = row.hashtags || [];
  return row;
}

// ── Agent State ──────────────────────────────────────────────

export async function getAgentState(key) {
  const c = client();
  const r = await c.query(
    "SELECT value FROM agent_state WHERE key = $1",
    [key]
  );
  return r.rows.length === 0 ? undefined : r.rows[0].value;
}

// Upsert semantics — overwrites existing value for the same key.
// Coerces any input to string before storage (matches pre-conversion
// behavior: the SQLite version did String(value) in the same position).
export async function setAgentState(key, value) {
  const c = client();
  await c.query(
    `INSERT INTO agent_state (tenant_id, key, value)
     VALUES (current_tenant_id(), $1, $2)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value)]
  );
}

// ── Activity Log ─────────────────────────────────────────────

// details can be a string, object, or null. Strings get wrapped
// as { raw: string } for JSONB storage consistency; objects pass
// through; null stays null. Matches the pre-conversion behavior
// of accepting either shape.
export async function logActivity(level, action, details = null, userSub = null) {
  const c = client();
  let jsonb = null;
  if (details != null) {
    jsonb = typeof details === "string"
      ? JSON.stringify({ raw: details })
      : JSON.stringify(details);
  }
  await c.query(
    `INSERT INTO activity_log (tenant_id, level, action, details, user_sub)
     VALUES (current_tenant_id(), $1::log_level, $2, $3::jsonb, $4)`,
    [level, action, jsonb, userSub]
  );
}

export async function getActivityLog(limit = 100) {
  const c = client();
  const r = await c.query(
    `SELECT id, tenant_id, timestamp, level, action, details
     FROM activity_log
     ORDER BY timestamp DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
}

// ── Stats ────────────────────────────────────────────────────

export async function getPostStats() {
  const c = client();

  const total = await c.query(
    "SELECT COUNT(*)::int AS count FROM posts WHERE status = 'posted'::post_status"
  );
  const byTopic = await c.query(
    `SELECT t.slug AS topic_id, COUNT(*)::int AS count
     FROM posts p
     JOIN topics t ON t.id = p.topic_id
     WHERE p.status = 'posted'::post_status
     GROUP BY t.slug`
  );
  const pending = await c.query(
    "SELECT COUNT(*)::int AS count FROM posts WHERE status = 'pending_approval'::post_status"
  );
  const last10Days = await getRecentPosts(10);

  return {
    totalPosted: total.rows[0].count,
    byTopic: byTopic.rows,
    postsLast10Days: last10Days.length,
    pendingApproval: pending.rows[0].count,
    recentPosts: last10Days
  };
}
