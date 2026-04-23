-- ═══════════════════════════════════════════════════════════════
-- 05-patch-0.45.1.4.sql — bring 0.45.1.3 schema up to 0.45.1.4
-- ═══════════════════════════════════════════════════════════════
-- Apply this AFTER you have already run the original 01-platform.sql
-- and 02-tenant-tables.sql (the 0.45.1.3 versions, with VARCHAR+CHECK
-- columns and no pgcrypto). It does not touch RLS, roles, or any
-- data — only schema changes.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Enable pgcrypto ───────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 2. Create the three platform enum types ──────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tenant_status') THEN
    CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'deleted');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'auth_provider') THEN
    CREATE TYPE auth_provider AS ENUM ('auth0', 'workos', 'mock');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_role') THEN
    CREATE TYPE member_role AS ENUM ('owner');
  END IF;
END$$;

-- ── 3. Convert tenants.status to tenant_status enum ──────────
-- Drop the CHECK constraint first (it's auto-named), then change
-- the column type with a USING cast that goes through text.
DO $$
DECLARE
  cons_name TEXT;
BEGIN
  SELECT conname INTO cons_name
  FROM pg_constraint
  WHERE conrelid = 'tenants'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%status%';
  IF cons_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tenants DROP CONSTRAINT %I', cons_name);
  END IF;
END$$;

ALTER TABLE tenants
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE tenant_status USING status::text::tenant_status,
  ALTER COLUMN status SET DEFAULT 'active'::tenant_status;

-- ── 4. Convert memberships.auth_provider to auth_provider enum ──
DO $$
DECLARE
  cons_name TEXT;
BEGIN
  SELECT conname INTO cons_name
  FROM pg_constraint
  WHERE conrelid = 'memberships'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%auth_provider%';
  IF cons_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT %I', cons_name);
  END IF;
END$$;

ALTER TABLE memberships
  ALTER COLUMN auth_provider TYPE auth_provider
    USING auth_provider::text::auth_provider;

-- ── 5. Convert memberships.role to member_role enum ──────────
DO $$
DECLARE
  cons_name TEXT;
BEGIN
  SELECT conname INTO cons_name
  FROM pg_constraint
  WHERE conrelid = 'memberships'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%role%'
    AND pg_get_constraintdef(oid) NOT LIKE '%auth_provider%';
  IF cons_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT %I', cons_name);
  END IF;
END$$;

ALTER TABLE memberships
  ALTER COLUMN role DROP DEFAULT,
  ALTER COLUMN role TYPE member_role USING role::text::member_role,
  ALTER COLUMN role SET DEFAULT 'owner'::member_role;

-- ── 6. Add three new columns to topics ───────────────────────
ALTER TABLE topics
  ADD COLUMN IF NOT EXISTS search_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 1
    CHECK (weight > 0),
  ADD COLUMN IF NOT EXISTS max_age_days INTEGER NOT NULL DEFAULT 14
    CHECK (max_age_days > 0);

-- ── 7. GIN index on search_templates ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_topics_search_templates_gin
  ON topics USING gin (search_templates);

-- ── 8. Comments on the new columns ───────────────────────────
COMMENT ON COLUMN topics.search_templates IS
  'JSONB array of web-search query templates. Shape is application-defined (strings or objects).';
COMMENT ON COLUMN topics.weight IS
  'Topic rotation weight. Permissive positive integer — application interprets the scale.';
COMMENT ON COLUMN topics.max_age_days IS
  'Research staleness window for this topic, in days. Articles older than this are excluded.';

-- ── 9. Bump schema_version ───────────────────────────────────
INSERT INTO schema_version (version, notes)
VALUES (2, '0.45.1.4 patch: pgcrypto, platform enums, topics columns')
ON CONFLICT (version) DO NOTHING;
