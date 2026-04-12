-- ═══════════════════════════════════════════════════════════════
-- 02-tenant-tables.sql — Tenant-scoped tables (pool isolation)
-- ═══════════════════════════════════════════════════════════════
-- Target: PostgreSQL 17
-- Prerequisite: 01-platform.sql must be applied first.
-- Idempotent: safe to re-run with `psql -f 02-tenant-tables.sql`
--
-- All tables in this file are TENANT-SCOPED. Every row has a
-- tenant_id column FK to tenants.id. Cross-tenant safety is
-- enforced THREE ways (defense in depth):
--
--   1. NOT NULL tenant_id on every table — application cannot
--      forget to set it on insert
--   2. COMPOSITE foreign keys (tenant_id, target_id) on every
--      cross-table reference within a tenant — prevents pointing
--      a row in tenant A at a parent in tenant B at the schema
--      level, regardless of RLS configuration
--   3. ROW LEVEL SECURITY policies in 03-rls.sql — enforces
--      visibility and write authorization at the database layer
--
-- ON DELETE CASCADE on every tenant_id FK means deleting a
-- tenant atomically removes all of their data — the silo
-- equivalent in pool isolation.
-- ═══════════════════════════════════════════════════════════════

-- ── Enum types ───────────────────────────────────────────────
-- PostgreSQL ENUMs are more efficient than CHECK constraints
-- (single byte vs. variable-length string compare) and self-
-- documenting via \dT in psql. New values can be added with
-- ALTER TYPE ... ADD VALUE in pg10+.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'post_status') THEN
    CREATE TYPE post_status AS ENUM (
      'draft',
      'pending_approval',
      'approved',
      'posted',
      'rejected',
      'failed'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feed_tier') THEN
    CREATE TYPE feed_tier AS ENUM (
      'primary',
      'secondary',
      'authoritative'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'log_level') THEN
    CREATE TYPE log_level AS ENUM (
      'debug',
      'info',
      'warn',
      'error'
    );
  END IF;
END$$;

-- ── topics ───────────────────────────────────────────────────
-- Replaces src/config/topics.js. The slug column is the natural
-- identifier from the source data (e.g. 'ai-practical-benefit').
-- The composite UNIQUE (tenant_id, id) is the FK target used by
-- posts.topic_id to enforce that a post cannot reference a topic
-- in a different tenant.
CREATE TABLE IF NOT EXISTS topics (
  id              BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID         NOT NULL,
  slug            VARCHAR(64)  NOT NULL,
  name            VARCHAR(256) NOT NULL,
  hashtags        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  system_context  TEXT         NOT NULL DEFAULT '',
  content_angles  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  search_templates JSONB       NOT NULL DEFAULT '[]'::jsonb,
  weight          INTEGER      NOT NULL DEFAULT 1
                    CHECK (weight > 0),
  max_age_days    INTEGER      NOT NULL DEFAULT 14
                    CHECK (max_age_days > 0),
  enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order      INTEGER      NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_topics_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT uq_topics_tenant_slug
    UNIQUE (tenant_id, slug),
  CONSTRAINT uq_topics_tenant_id
    UNIQUE (tenant_id, id)  -- FK target for posts.(tenant_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_topics_tenant_enabled
  ON topics(tenant_id) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_topics_hashtags_gin
  ON topics USING gin (hashtags);
CREATE INDEX IF NOT EXISTS idx_topics_content_angles_gin
  ON topics USING gin (content_angles);
CREATE INDEX IF NOT EXISTS idx_topics_search_templates_gin
  ON topics USING gin (search_templates);

DROP TRIGGER IF EXISTS trg_topics_updated_at ON topics;
CREATE TRIGGER trg_topics_updated_at
  BEFORE UPDATE ON topics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE topics IS
  'Per-tenant topic definitions. Replaces src/config/topics.js from pre-multitenant.';
COMMENT ON COLUMN topics.slug IS
  'Human-readable identifier (e.g., "ai-practical-benefit"). Unique within a tenant.';
COMMENT ON COLUMN topics.content_angles IS
  'JSONB array of content angle prompts the agent rotates through.';
COMMENT ON COLUMN topics.search_templates IS
  'JSONB array of web-search query templates. Shape is application-defined (strings or objects).';
COMMENT ON COLUMN topics.weight IS
  'Topic rotation weight. Permissive positive integer — application interprets the scale.';
COMMENT ON COLUMN topics.max_age_days IS
  'Research staleness window for this topic, in days. Articles older than this are excluded.';

-- ── feeds ────────────────────────────────────────────────────
-- Replaces src/config/feeds.js. URL is the natural identifier
-- but is unique only within a tenant — two tenants can subscribe
-- to the same RSS feed independently. topic_slugs is a JSONB
-- array of topic slugs (NOT topic IDs) so that the application
-- code can join via slug, which is the human-meaningful key.
CREATE TABLE IF NOT EXISTS feeds (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        UUID         NOT NULL,
  url              TEXT         NOT NULL,
  name             VARCHAR(256) NOT NULL,
  topic_slugs      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  tier             feed_tier    NOT NULL DEFAULT 'primary',
  refresh_minutes  INTEGER      NOT NULL DEFAULT 120
                     CHECK (refresh_minutes > 0),
  enabled          BOOLEAN      NOT NULL DEFAULT TRUE,
  last_polled_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_feeds_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT uq_feeds_tenant_url
    UNIQUE (tenant_id, url)
);

CREATE INDEX IF NOT EXISTS idx_feeds_tenant_enabled
  ON feeds(tenant_id) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_feeds_topic_slugs_gin
  ON feeds USING gin (topic_slugs);

DROP TRIGGER IF EXISTS trg_feeds_updated_at ON feeds;
CREATE TRIGGER trg_feeds_updated_at
  BEFORE UPDATE ON feeds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE feeds IS
  'Per-tenant RSS feed subscriptions. Replaces src/config/feeds.js.';

-- ── articles ─────────────────────────────────────────────────
-- News items fetched from feeds. The link is unique per tenant
-- (not globally) so two tenants subscribing to the same feed
-- each get their own ingestion of every article — preserves the
-- tenant boundary for source data. content_hash is used for
-- duplicate detection within a tenant.
CREATE TABLE IF NOT EXISTS articles (
  id            BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID         NOT NULL,
  feed_name     VARCHAR(256) NOT NULL,
  feed_tier     feed_tier    NOT NULL,
  topic_slugs   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  title         TEXT         NOT NULL,
  link          TEXT         NOT NULL,
  summary       TEXT,
  published_at  TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  content_hash  VARCHAR(64),
  CONSTRAINT fk_articles_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT uq_articles_tenant_link
    UNIQUE (tenant_id, link)
);

CREATE INDEX IF NOT EXISTS idx_articles_tenant_published
  ON articles(tenant_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_topic_slugs_gin
  ON articles USING gin (topic_slugs);

COMMENT ON TABLE articles IS
  'Articles fetched from RSS feeds. Per-tenant — same article from same feed produces two rows for two tenants.';

-- ── posts ────────────────────────────────────────────────────
-- The headline table — generated LinkedIn posts in their lifecycle.
-- topic_id uses a composite FK (tenant_id, topic_id) → topics so
-- a post can never reference a topic in a different tenant. ON
-- DELETE SET NULL on (topic_id) means deleting a topic preserves
-- historical posts but nulls their topic reference.
CREATE TABLE IF NOT EXISTS posts (
  id              BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       UUID         NOT NULL,
  topic_id        BIGINT,
  title           TEXT         NOT NULL,
  content         TEXT         NOT NULL,
  hashtags        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  status          post_status  NOT NULL DEFAULT 'draft',
  linkedin_id     TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  scheduled_for   TIMESTAMPTZ,
  posted_at       TIMESTAMPTZ,
  error_message   TEXT,
  news_context    JSONB,
  CONSTRAINT fk_posts_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_posts_topic
    FOREIGN KEY (tenant_id, topic_id) REFERENCES topics(tenant_id, id)
    ON DELETE SET NULL (topic_id)
);

CREATE INDEX IF NOT EXISTS idx_posts_tenant_status
  ON posts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_posts_tenant_posted_at
  ON posts(tenant_id, posted_at DESC) WHERE posted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_tenant_scheduled
  ON posts(tenant_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_topic
  ON posts(tenant_id, topic_id) WHERE topic_id IS NOT NULL;

COMMENT ON TABLE posts IS
  'Generated LinkedIn posts and their lifecycle (draft → pending → approved → posted).';
COMMENT ON COLUMN posts.topic_id IS
  'FK to topics(id) within the same tenant. NULL if the topic was deleted after this post was created.';

-- ── agent_state ──────────────────────────────────────────────
-- Per-tenant key/value scratch space the agent uses for things
-- like "last_topic_id", "paused", "mode". Composite primary key
-- (tenant_id, key) is the natural key — no surrogate id needed.
CREATE TABLE IF NOT EXISTS agent_state (
  tenant_id   UUID         NOT NULL,
  key         VARCHAR(64)  NOT NULL,
  value       TEXT         NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pk_agent_state PRIMARY KEY (tenant_id, key),
  CONSTRAINT fk_agent_state_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS trg_agent_state_updated_at ON agent_state;
CREATE TRIGGER trg_agent_state_updated_at
  BEFORE UPDATE ON agent_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE agent_state IS
  'Per-tenant key/value scratch space for agent runtime state (mode, last_topic_id, paused, etc.).';

-- ── activity_log ─────────────────────────────────────────────
-- Append-only audit trail per tenant. details is JSONB so the
-- application can attach structured context to each entry.
CREATE TABLE IF NOT EXISTS activity_log (
  id          BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   UUID         NOT NULL,
  timestamp   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  level       log_level    NOT NULL,
  action      VARCHAR(128) NOT NULL,
  details     JSONB,
  CONSTRAINT fk_activity_log_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activity_log_tenant_timestamp
  ON activity_log(tenant_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_tenant_action
  ON activity_log(tenant_id, action, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_tenant_level
  ON activity_log(tenant_id, level, timestamp DESC) WHERE level IN ('warn', 'error');

COMMENT ON TABLE activity_log IS
  'Append-only audit trail. The level/timestamp partial index optimizes the common "show recent errors" query.';

-- ── credentials ──────────────────────────────────────────────
-- Encrypted per-tenant secrets (LinkedIn token, BYOK Anthropic
-- API key, etc.). value_enc format is iv (12 bytes) || authTag
-- (16 bytes) || ciphertext. Encryption key is derived per-tenant
-- via HKDF — see scripts/migration/migrate-to-multitenant.mjs
-- for the derivation, and credential-store.js for the runtime.
CREATE TABLE IF NOT EXISTS credentials (
  tenant_id           UUID         NOT NULL,
  key                 VARCHAR(64)  NOT NULL,
  value_enc           BYTEA        NOT NULL,
  encryption_version  SMALLINT     NOT NULL DEFAULT 1
                        CHECK (encryption_version > 0),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pk_credentials PRIMARY KEY (tenant_id, key),
  CONSTRAINT fk_credentials_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS trg_credentials_updated_at ON credentials;
CREATE TRIGGER trg_credentials_updated_at
  BEFORE UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE credentials IS
  'Encrypted per-tenant secrets. Plaintext is never stored. encryption_version allows scheme rotation.';
COMMENT ON COLUMN credentials.value_enc IS
  'AES-256-GCM ciphertext: iv (12 bytes) || authTag (16 bytes) || ciphertext.';
