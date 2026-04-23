-- ═══════════════════════════════════════════════════════════════
-- 08-feeds-normalize.sql — Normalized feed and article schema
-- ═══════════════════════════════════════════════════════════════
-- Target: linkedin_dev (testing database)
-- Run as: agent (superuser)
-- Prerequisite: Base schema (01-04 DDL) applied. The tenants,
--   topics, current_tenant_id(), feed_tier enum, and
--   ***REMOVED*** role must exist.
--
-- This DDL replaces the hardcoded feeds.js and denormalized
-- articles table with a normalized four-table design:
--
--   articles       — global content, no RLS, one row per URL
--   feeds          — tenant-scoped RSS sources, RLS
--   feed_topics    — many-to-many feed ↔ topic, RLS
--   feed_articles  — tenant-scoped access boundary, RLS
--
-- Articles are stored once globally. Tenant access is enforced
-- through the relationship: tenant → feeds → feed_articles → articles.
-- A tenant can only see articles that arrived through their feeds.
-- ═══════════════════════════════════════════════════════════════

-- ── Step 1: feed_tier enum (idempotent) ──────────────────────
-- May already exist from the original conversion. Safe to skip.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feed_tier') THEN
    CREATE TYPE feed_tier AS ENUM ('authoritative', 'primary', 'secondary');
  END IF;
END$$;

-- ── Step 2: articles — global, no tenant scoping ─────────────
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

-- ── Step 3: feeds — tenant-scoped RSS source definitions ─────
-- Replaces the hardcoded FEEDS array in src/config/feeds.js.
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
  'Tenant-scoped RSS feed definitions. RLS-protected.';

-- ── Step 4: feed_topics — many-to-many feed ↔ topic ──────────
-- Which topics a feed serves. Replaces the topicIds[] array.
-- When content is generated for a topic, the system finds
-- articles through: topic → feed_topics → feeds → feed_articles → articles.
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
  'Many-to-many mapping between feeds and topics. RLS-protected via tenant_id.';

-- ── Step 5: feed_articles — tenant access boundary ───────────
-- Links a global article to the tenant-scoped feed that fetched it.
-- This is the RLS boundary: a tenant can only see articles that
-- arrived through their own feeds.
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
  'Tenant-scoped article access. Links global articles to the feed that fetched them. RLS-protected.';

-- ── Step 6: RLS policies ─────────────────────────────────────
-- articles_v2: NO RLS — global content, accessed only via JOINs
-- feeds_v2, feed_topics, feed_articles: standard tenant isolation

ALTER TABLE feeds_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE feeds_v2 FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON feeds_v2;
CREATE POLICY tenant_isolation ON feeds_v2
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE feed_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_topics FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON feed_topics;
CREATE POLICY tenant_isolation ON feed_topics
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE feed_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_articles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON feed_articles;
CREATE POLICY tenant_isolation ON feed_articles
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ── Step 7: Grants ───────────────────────────────────────────
-- articles_v2: app needs SELECT + INSERT (fetch new articles).
--   No UPDATE/DELETE — articles are append-only global content.
-- feeds_v2: full DML for tenant management.
-- feed_topics: full DML for topic mapping.
-- feed_articles: INSERT + SELECT (fetch writes, research reads).

GRANT SELECT, INSERT ON articles_v2 TO ***REMOVED***;
GRANT SELECT, INSERT, UPDATE, DELETE ON feeds_v2 TO ***REMOVED***;
GRANT SELECT, INSERT, DELETE ON feed_topics TO ***REMOVED***;
GRANT SELECT, INSERT ON feed_articles TO ***REMOVED***;

-- Sequences for IDENTITY columns
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ***REMOVED***;

-- ── Step 8: updated_at trigger on feeds_v2 ───────────────────
-- Reuses the existing set_updated_at() trigger function.
DROP TRIGGER IF EXISTS feeds_v2_updated_at ON feeds_v2;
CREATE TRIGGER feeds_v2_updated_at
  BEFORE UPDATE ON feeds_v2
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- Seed data — current feeds.js → feeds_v2 + feed_topics
-- ═══════════════════════════════════════════════════════════════
-- Uses the known tenant UUID. Topic IDs are resolved by slug.
-- This seed block is wrapped in a function that sets tenant
-- context so RLS WITH CHECK passes on INSERT.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_tenant UUID := '53f2e104-4192-439b-abdc-70954bfa9583';
  v_feed_id BIGINT;
  v_topic_id BIGINT;
BEGIN
  -- Set tenant context for RLS
  PERFORM set_config('app.current_tenant_id', v_tenant::text, true);

  -- ── Cybersecurity Incidents & Threat Intel ───────────────

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://krebsonsecurity.com/feed/', 'Krebs on Security', 'primary', 120)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://www.bleepingcomputer.com/feed/', 'BleepingComputer', 'primary', 60)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://therecord.media/feed', 'The Record by Recorded Future', 'primary', 120)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://www.darkreading.com/rss.xml', 'Dark Reading', 'primary', 120)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://feeds.feedburner.com/TheHackersNews', 'The Hacker News', 'secondary', 90)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://www.cisa.gov/news.xml', 'CISA Alerts', 'authoritative', 180)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://securelist.com/feed/', 'Securelist (Kaspersky)', 'primary', 240)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  -- ── Cybersecurity Technology & Advances ──────────────────

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://www.schneier.com/feed/atom/', 'Schneier on Security', 'primary', 240)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-guardrails' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://blog.google/technology/safety-security/rss/', 'Google Security Blog', 'primary', 360)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://api.msrc.microsoft.com/update-guide/rss', 'Microsoft Security Response Center', 'authoritative', 360)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  -- ── AI Practical Benefits & Guardrails ──────────────────

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://blog.google/technology/ai/rss/', 'Google AI Blog', 'primary', 360)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-practical-benefit' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://openai.com/blog/rss.xml', 'OpenAI Blog', 'primary', 360)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-practical-benefit' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-guardrails' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://www.technologyreview.com/feed/', 'MIT Technology Review', 'primary', 240)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-practical-benefit' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-guardrails' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://techcrunch.com/category/artificial-intelligence/feed/', 'TechCrunch AI', 'secondary', 120)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-practical-benefit' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://simonwillison.net/atom/everything/', 'Simon Willison', 'primary', 240)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-practical-benefit' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-guardrails' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

END$$;

-- ═══════════════════════════════════════════════════════════════
-- Verification queries — run after applying
-- ═══════════════════════════════════════════════════════════════
-- SELECT count(*) AS feeds FROM feeds_v2;
-- SELECT count(*) AS mappings FROM feed_topics;
-- SELECT f.name, f.tier, array_agg(t.slug) AS topics
--   FROM feeds_v2 f
--   JOIN feed_topics ft ON ft.feed_id = f.id
--   JOIN topics t ON t.id = ft.topic_id
--   GROUP BY f.name, f.tier
--   ORDER BY f.name;
