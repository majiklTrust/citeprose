-- ═══════════════════════════════════════════════════════════════
-- Tenant-level SQLite schema additions
-- ═══════════════════════════════════════════════════════════════
-- Applied to a tenant's own SQLite file (e.g., tenant_001.sqlite)
-- AFTER the existing pre-multitenant tables (posts, agent_state,
-- activity_log, articles) have been copied in.
--
-- This script adds the new multi-tenant-only tables:
--   - topics       (replaces src/config/topics.js)
--   - feeds        (replaces src/config/feeds.js)
--   - credentials  (encrypted per-tenant secrets: LinkedIn token,
--                   Anthropic API key, etc.)
--
-- Idempotent: safe to apply against an already-migrated tenant DB.
-- ═══════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Topics ───────────────────────────────────────────────────
-- Replaces the static src/config/topics.js export. Each row is
-- one topic the tenant's agent can post about. content_angles
-- is stored as JSON to keep the schema simple — the agent reads
-- it as an array of strings and picks one per cycle.
CREATE TABLE IF NOT EXISTS topics (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  hashtags_json       TEXT NOT NULL DEFAULT '[]',
  system_context      TEXT NOT NULL,
  content_angles_json TEXT NOT NULL DEFAULT '[]',
  enabled             INTEGER NOT NULL DEFAULT 1
                        CHECK (enabled IN (0, 1)),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topics_enabled ON topics(enabled);
CREATE INDEX IF NOT EXISTS idx_topics_sort ON topics(sort_order);

-- ── Feeds ────────────────────────────────────────────────────
-- Replaces the static src/config/feeds.js export. URL is the
-- natural primary key — the existing data shape uses it as the
-- unique identifier. topic_ids_json links a feed to one or more
-- topics; the agent uses it to route articles into topic queues.
CREATE TABLE IF NOT EXISTS feeds (
  url              TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  topic_ids_json   TEXT NOT NULL DEFAULT '[]',
  tier             TEXT NOT NULL DEFAULT 'primary'
                     CHECK (tier IN ('primary', 'secondary', 'authoritative')),
  refresh_minutes  INTEGER NOT NULL DEFAULT 120,
  enabled          INTEGER NOT NULL DEFAULT 1
                     CHECK (enabled IN (0, 1)),
  last_polled_at   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feeds_enabled ON feeds(enabled);

-- ── Credentials ──────────────────────────────────────────────
-- Encrypted per-tenant secrets. Each value is stored as a BLOB
-- in the format: iv (12 bytes) || authTag (16 bytes) || ciphertext
-- The encryption key is derived from the platform ENCRYPTION_SECRET
-- via HKDF-SHA256, with the tenant's id as the salt and a versioned
-- info string. encryption_version lets us rotate the derivation
-- scheme later without breaking existing rows.
--
-- Key naming convention (just convention, not enforced):
--   linkedin_access_token
--   linkedin_refresh_token
--   linkedin_person_urn      (not encrypted-sensitive but stored here for cohesion)
--   anthropic_api_key
CREATE TABLE IF NOT EXISTS credentials (
  key                 TEXT PRIMARY KEY,
  value_enc           BLOB NOT NULL,
  encryption_version  INTEGER NOT NULL DEFAULT 1,
  updated_at          TEXT NOT NULL
);

-- ── Tenant schema version marker ─────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO tenant_schema_version (version, applied_at)
VALUES (1, datetime('now'));
