-- ═══════════════════════════════════════════════════════════════
-- 04-roles.sql — Application and admin role grants
-- ═══════════════════════════════════════════════════════════════
-- Target: PostgreSQL 17
-- Prerequisite: 01, 02, 03 applied.
-- Idempotent: safe to re-run.
--
-- Creates two GROUP roles (NOLOGIN — they're not for logging in
-- directly) representing two privilege tiers:
--
--   linkedin_agent_app    — used by the running application.
--                            NO BYPASSRLS. RLS policies apply.
--                            Read-only on platform tables.
--                            Read/write on tenant tables, but
--                            constrained by RLS to one tenant
--                            at a time.
--
--   linkedin_agent_admin  — used by migrations and admin scripts.
--                            BYPASSRLS. Can read/write across
--                            tenants without setting tenant
--                            context. Use sparingly and only
--                            for admin work.
--
-- AFTER RUNNING THIS FILE, you must create one or more LOGIN
-- roles and grant them membership in the appropriate group:
--
--   CREATE ROLE app_runtime LOGIN PASSWORD '...';
--   GRANT linkedin_agent_app TO app_runtime;
--
--   CREATE ROLE migrator LOGIN PASSWORD '...';
--   GRANT linkedin_agent_admin TO migrator;
--
-- The application connects as app_runtime; migrations connect as
-- migrator. Neither group role has a password and neither can
-- log in directly — they exist purely to bundle grants.
-- ═══════════════════════════════════════════════════════════════

-- ── Group roles ──────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linkedin_agent_app') THEN
    CREATE ROLE linkedin_agent_app NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linkedin_agent_admin') THEN
    CREATE ROLE linkedin_agent_admin NOLOGIN BYPASSRLS;
  END IF;
END$$;

-- Re-assert key attributes in case the role was created
-- previously without them (e.g., during an iteration on this
-- file). ALTER ROLE is idempotent.
ALTER ROLE linkedin_agent_app NOBYPASSRLS;
ALTER ROLE linkedin_agent_admin BYPASSRLS;

-- ── Schema usage ─────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO linkedin_agent_app;
GRANT USAGE ON SCHEMA public TO linkedin_agent_admin;

-- ── Platform tables: read-only for app, full for admin ───────
-- The app needs to look up tenants and memberships before any
-- tenant context is set (to resolve "which tenant does this
-- logged-in user belong to?"). It does NOT need to write to
-- these tables — tenant creation is an admin operation.
GRANT SELECT ON tenants, memberships, schema_version TO linkedin_agent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, memberships, schema_version
  TO linkedin_agent_admin;

-- ── Tenant tables: full access for both, RLS does the work ───
-- linkedin_agent_app gets full DML on tenant tables but is
-- constrained by RLS. linkedin_agent_admin gets the same DML
-- and bypasses RLS via the role attribute.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  topics, feeds, articles, posts, agent_state, activity_log, credentials
  TO linkedin_agent_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  topics, feeds, articles, posts, agent_state, activity_log, credentials
  TO linkedin_agent_admin;

-- ── Sequences for IDENTITY columns ───────────────────────────
-- IDENTITY columns use sequences under the hood. INSERT requires
-- USAGE on the sequence (or it's auto-granted in pg10+? safer
-- to grant explicitly). This grants on every sequence in public.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO linkedin_agent_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO linkedin_agent_admin;

-- Default privileges for any sequences created in the future
-- (e.g., when adding new IDENTITY columns).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO linkedin_agent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO linkedin_agent_admin;

-- ── Functions ────────────────────────────────────────────────
-- The app needs to call current_tenant_id() implicitly via
-- RLS policies. EXECUTE on the function is required.
GRANT EXECUTE ON FUNCTION current_tenant_id() TO linkedin_agent_app;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO linkedin_agent_admin;
GRANT EXECUTE ON FUNCTION set_updated_at() TO linkedin_agent_app;
GRANT EXECUTE ON FUNCTION set_updated_at() TO linkedin_agent_admin;

-- ── Default privileges for future tables ─────────────────────
-- If you add new tables in the public schema later, these
-- ALTER DEFAULT PRIVILEGES statements ensure the group roles
-- pick them up automatically. Caveat: they only apply to
-- tables created by the role that ran this statement.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO linkedin_agent_admin;

-- For linkedin_agent_app, default privileges on new tables are
-- intentionally NOT granted automatically — new tables should
-- have their access reviewed and granted explicitly so RLS
-- policies can be added in the same migration. Auto-granting
-- DML on new tables would let an unprotected new table leak
-- across tenants until someone notices.

COMMENT ON ROLE linkedin_agent_app IS
  'Application runtime role. RLS-bound, no BYPASSRLS. Grant to a LOGIN role for the app.';
COMMENT ON ROLE linkedin_agent_admin IS
  'Migration and admin role. BYPASSRLS. Grant to a LOGIN role used by ops scripts only.';
