-- ═══════════════════════════════════════════════════════════════
-- 02.1-feeds-normalize.sql — Normalized feed and article schema
-- ═══════════════════════════════════════════════════════════════
-- Target: ***REMOVED*** (schema: public)
-- Run as: agent (superuser)
-- Prerequisite: 01-platform.sql and 02-tenant-tables.sql applied.
--   The tenants, topics, and feed_tier enum must exist.
-- Idempotent: safe to re-run.
--
-- Creates four tables for the normalized feed/article system:
--
--   articles_v2    — global content, no RLS, one row per URL
--   feeds_v2       — tenant-scoped RSS source definitions
--   feed_topics    — many-to-many feed ↔ topic mapping
--   feed_articles  — tenant-scoped access boundary
--
-- Articles are stored once globally. Tenant access is enforced
-- through: tenant → feeds_v2 → feed_articles → articles_v2.
--
-- RLS policies are applied by 03-rls.sql.
-- Grants are applied by 04-roles.sql.
-- Seed data is applied separately after tenant provisioning.
-- ═══════════════════════════════════════════════════════════════

-- ── Step 1: feed_tier enum (idempotent) ──────────────────────
-- May already exist from 02-tenant-tables.sql. Safe to skip.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feed_tier') THEN
    CREATE TYPE feed_tier AS ENUM ('authoritative', 'primary', 'secondary');
  END IF;
END$$;

-- ── Step 2: articles_v2 — global, no tenant scoping ──────────
-- One row per unique URL across all tenants. Content is public
-- (RSS feeds are public by definition). No RLS — access is
-- controlled through feed_articles.
CREATE TABLE IF NOT EXISTS articles_v2 (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  link            TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  published_at    TIMESTAMPTZ,
  content_hash    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_articles_v2_link UNIQUE (link)
);

CREATE INDEX IF NOT EXISTS idx_articles_v2_published
  ON articles_v2 (published_at DESC);

COMMENT ON TABLE articles_v2 IS
  'Global article content — one row per URL. No RLS; access controlled via feed_articles.';

-- ── Step 3: feeds_v2 — tenant-scoped RSS source definitions ──
CREATE TABLE IF NOT EXISTS feeds_v2 (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  url             TEXT NOT NULL,
  name            TEXT NOT NULL,
  tier            feed_tier NOT NULL DEFAULT 'secondary',
  refresh_minutes INTEGER NOT NULL DEFAULT 120,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_polled_at  TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_feeds_v2_tenant_url UNIQUE (tenant_id, url)
);

CREATE INDEX IF NOT EXISTS idx_feeds_v2_tenant
  ON feeds_v2 (tenant_id);

CREATE INDEX IF NOT EXISTS idx_feeds_v2_poll_due
  ON feeds_v2 (tenant_id, enabled, last_polled_at)
  WHERE enabled = true;

COMMENT ON TABLE feeds_v2 IS
  'Tenant-scoped RSS feed definitions.';

-- ── Step 4: feed_topics — many-to-many feed ↔ topic ──────────
CREATE TABLE IF NOT EXISTS feed_topics (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  feed_id         BIGINT NOT NULL REFERENCES feeds_v2(id) ON DELETE CASCADE,
  topic_id        BIGINT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,

  CONSTRAINT uq_feed_topics_feed_topic UNIQUE (feed_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_feed_topics_topic
  ON feed_topics (topic_id);

CREATE INDEX IF NOT EXISTS idx_feed_topics_feed
  ON feed_topics (feed_id);

COMMENT ON TABLE feed_topics IS
  'Many-to-many mapping between feeds and topics.';

-- ── Step 5: feed_articles — tenant access boundary ───────────
CREATE TABLE IF NOT EXISTS feed_articles (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  feed_id         BIGINT NOT NULL REFERENCES feeds_v2(id) ON DELETE CASCADE,
  article_id      BIGINT NOT NULL REFERENCES articles_v2(id) ON DELETE CASCADE,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_feed_articles_feed_article UNIQUE (feed_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_feed_articles_article
  ON feed_articles (article_id);

CREATE INDEX IF NOT EXISTS idx_feed_articles_tenant
  ON feed_articles (tenant_id);

COMMENT ON TABLE feed_articles IS
  'Tenant-scoped article access. Links global articles to the feed that fetched them.';

-- ── Step 6: updated_at trigger on feeds_v2 ───────────────────
-- Reuses the set_updated_at() function created by 02-tenant-tables.sql.
DROP TRIGGER IF EXISTS feeds_v2_updated_at ON feeds_v2;
CREATE TRIGGER feeds_v2_updated_at
  BEFORE UPDATE ON feeds_v2
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
