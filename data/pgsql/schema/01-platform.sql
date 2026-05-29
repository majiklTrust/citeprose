-- ═══════════════════════════════════════════════════════════════
-- 01-platform.sql — LinkedIn Agent multi-tenant platform schema
-- ═══════════════════════════════════════════════════════════════
-- Target: PostgreSQL 17
-- Layout: Single database, public schema (option A from design)
-- Idempotent: safe to re-run with `psql -f 01-platform.sql`
--
-- Creates the platform-level tables that hold tenant metadata
-- and authenticated identity → tenant mappings. These tables
-- are NOT subject to row-level security (they live above the
-- tenant boundary, not inside it).
--
-- gen_random_uuid() is built into PostgreSQL 13+ — no extension
-- required. Uncomment pgcrypto if you want crypt(), digest(),
-- or hmac() helpers at the database layer for some other purpose.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Platform enum types ──────────────────────────────────────
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

-- ── tenants ──────────────────────────────────────────────────
-- One row per customer organization. UUID surrogate key is the
-- foreign-key target for every tenant-scoped table. The slug
-- column gives ops scripts a stable human-readable handle for
-- a tenant without exposing UUIDs in the dashboard URLs.
CREATE TABLE IF NOT EXISTS tenants (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         VARCHAR(64)  NOT NULL UNIQUE,
  name         VARCHAR(256) NOT NULL,
  status       tenant_status NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by   TEXT
);

-- Partial index — only active tenants are scanned by the most
-- common query (the scheduler iterating over live tenants).
CREATE INDEX IF NOT EXISTS idx_tenants_status_active
  ON tenants(id) WHERE status = 'active';

COMMENT ON TABLE tenants IS
  'One row per customer organization. UUID id is the FK target for all tenant-scoped tables.';
COMMENT ON COLUMN tenants.slug IS
  'Human-readable identifier (e.g., "tenant_001"). Globally unique. Used by ops scripts.';
COMMENT ON COLUMN tenants.status IS
  'Lifecycle: active → suspended → deleted. Inactive tenants are excluded by partial index.';

-- ── memberships ──────────────────────────────────────────────
-- Maps an authenticated identity (provider + sub) to a tenant.
-- The UNIQUE constraint enforces "one auth identity = one
-- tenant" in v1. To allow a single user to belong to multiple
-- tenants in v2, drop the constraint and add a default_tenant_id
-- column to a separate users table.
CREATE TABLE IF NOT EXISTS memberships (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL,
  auth_provider   auth_provider NOT NULL,
  auth_sub        VARCHAR(256)  NOT NULL,
  role            member_role   NOT NULL DEFAULT 'owner',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_memberships_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT uq_memberships_auth_identity
    UNIQUE (auth_provider, auth_sub)
);

CREATE INDEX IF NOT EXISTS idx_memberships_tenant_id
  ON memberships(tenant_id);

COMMENT ON TABLE memberships IS
  'Maps an authenticated identity to a tenant. UNIQUE(auth_provider, auth_sub) enforces one-user-per-tenant in v1.';
COMMENT ON COLUMN memberships.auth_sub IS
  'Auth provider subject identifier (e.g., "auth0|abc123" for Auth0, "user_01H..." for WorkOS).';

-- ── schema_version ───────────────────────────────────────────
-- Migration version marker. Future schema changes should bump
-- this and check it before applying. For pgsql, consider
-- replacing this with a real migration framework (Flyway,
-- Liquibase, Sqitch) when the schema starts evolving frequently.
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER      PRIMARY KEY,
  applied_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  notes      TEXT
);

INSERT INTO schema_version (version, notes)
VALUES (1, 'Initial multi-tenant platform + tenant schema')
ON CONFLICT (version) DO NOTHING;

-- ── updated_at trigger ───────────────────────────────────────
-- Automatically maintain updated_at columns. Reusable across
-- any table that has an updated_at TIMESTAMPTZ column.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenants_updated_at ON tenants;
CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
