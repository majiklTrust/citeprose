-- ═══════════════════════════════════════════════════════════════
-- 03-rls.sql — Row-Level Security policies for tenant isolation
-- ═══════════════════════════════════════════════════════════════
-- Target: PostgreSQL 17
-- Prerequisite: 01-platform.sql, 02-tenant-tables.sql, and
--   02.1-feeds-normalize.sql applied (v2 tables must exist).
-- Idempotent: safe to re-run with `psql -f 03-rls.sql`
--
-- This file enables Row-Level Security (RLS) on every tenant-
-- scoped table. With these policies in place, ALL queries are
-- automatically filtered by the current session's tenant — even
-- if the application code forgets a WHERE clause, no data leaks
-- across tenants.
--
-- HOW IT WORKS
-- ────────────
-- 1. The application sets the current tenant at the start of
--    every request, inside a transaction:
--
--      BEGIN;
--      SET LOCAL app.current_tenant_id = '<tenant-uuid>';
--      -- ... queries run here are auto-filtered ...
--      COMMIT;
--
-- 2. SET LOCAL scopes the setting to the transaction. When the
--    transaction commits or rolls back, the setting is cleared.
--    This prevents tenant context leaking between pooled
--    connections.
--
-- 3. Every query against a tenant table is implicitly filtered
--    as if it had `WHERE tenant_id = current_tenant_id()`. INSERT
--    and UPDATE statements are checked the same way — you cannot
--    write a row whose tenant_id does not match the session.
--
-- 4. FORCE ROW LEVEL SECURITY makes RLS apply even to the table
--    owner, closing the "table owner bypasses RLS" hole.
--
-- BYPASSING RLS FOR ADMIN / MIGRATION WORK
-- ─────────────────────────────────────────
-- The migration runner and admin scripts need cross-tenant
-- visibility. Two ways:
--
--   (a) Connect as a role with BYPASSRLS attribute:
--         CREATE ROLE migrator LOGIN BYPASSRLS PASSWORD '...';
--
--   (b) From a privileged session, disable RLS for the
--       transaction:
--         BEGIN;
--         SET LOCAL row_security = off;
--         -- ... admin queries ...
--         COMMIT;
--
-- The application's day-to-day login role MUST NOT have
-- BYPASSRLS. See 04-roles.sql for the recommended grants.
--
-- DEFENSE IN DEPTH
-- ────────────────
-- RLS is the database-layer enforcement. The composite foreign
-- keys in 02-tenant-tables.sql are the schema-layer enforcement.
-- Application code should still pass tenant context explicitly
-- and use parameterized queries. Three layers, all of which
-- have to fail simultaneously for a cross-tenant leak to occur.
-- ═══════════════════════════════════════════════════════════════

-- ── Helper: current_tenant_id() ──────────────────────────────
-- Reads the per-session app.current_tenant_id setting and
-- returns it as a UUID. Returns NULL if the setting is unset
-- or empty — RLS policies will then match no rows, which is
-- the safe failure mode (deny-by-default).
--
-- STABLE allows the planner to call this once per query rather
-- than once per row. PARALLEL SAFE permits its use in parallel
-- query plans.
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION current_tenant_id() IS
  'Returns the current session tenant UUID from app.current_tenant_id setting, or NULL if unset.';

-- ── Macro: enable + force + policy on a tenant table ─────────
-- PostgreSQL has no metaprogramming for this so we apply the
-- same three statements per table. The policy name is the same
-- on every table ('tenant_isolation') for consistency.

-- topics
ALTER TABLE topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE topics FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topics;
CREATE POLICY tenant_isolation ON topics
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- feeds_v2 (tenant-scoped RSS source definitions)
ALTER TABLE feeds_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE feeds_v2 FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON feeds_v2;
CREATE POLICY tenant_isolation ON feeds_v2
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- feed_topics (many-to-many feed ↔ topic)
ALTER TABLE feed_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_topics FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON feed_topics;
CREATE POLICY tenant_isolation ON feed_topics
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- feed_articles (tenant access boundary to global articles)
ALTER TABLE feed_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_articles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON feed_articles;
CREATE POLICY tenant_isolation ON feed_articles
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- articles_v2: NO RLS
-- Global content table — one row per URL across all tenants.
-- Access is controlled through feed_articles (RLS-protected).
-- No tenant_id column exists on this table.

-- posts
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON posts;
CREATE POLICY tenant_isolation ON posts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- agent_state
ALTER TABLE agent_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_state;
CREATE POLICY tenant_isolation ON agent_state
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- activity_log
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON activity_log;
CREATE POLICY tenant_isolation ON activity_log
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- credentials
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON credentials;
CREATE POLICY tenant_isolation ON credentials
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ── Platform tables: NOT subject to RLS ──────────────────────
-- tenants, memberships, schema_version, invites live ABOVE the
-- tenant boundary. The application needs to read them BEFORE a
-- tenant context is established (to look up which tenant a
-- logged-in user belongs to). Access control on these tables is
-- enforced via GRANTs in 04-roles.sql, not RLS.
