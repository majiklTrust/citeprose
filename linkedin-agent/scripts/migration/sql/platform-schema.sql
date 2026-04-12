-- ═══════════════════════════════════════════════════════════════
-- Platform-level SQLite schema
-- ═══════════════════════════════════════════════════════════════
-- Single global database file: platform.sqlite
-- Created once. Holds tenants, memberships, and platform-wide
-- metadata. Does NOT hold any tenant-scoped content.
--
-- Idempotent: safe to apply against an existing platform DB.
-- All CREATE statements use IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Tenants ──────────────────────────────────────────────────
-- One row per tenant. The db_path column is the location of the
-- tenant's own SQLite file relative to the application root.
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'suspended', 'deleted')),
  db_path      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

-- ── Memberships ──────────────────────────────────────────────
-- Maps an authenticated identity (provider + sub) to a tenant.
-- The UNIQUE constraint enforces "one auth identity = one
-- tenant" in v1. To allow a single user to belong to multiple
-- tenants in v2, drop this constraint and add a separate users
-- table with default_tenant_id.
CREATE TABLE IF NOT EXISTS memberships (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  auth_provider   TEXT NOT NULL
                    CHECK (auth_provider IN ('auth0', 'workos', 'mock')),
  auth_sub        TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'owner'
                    CHECK (role IN ('owner')),
  created_at      TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_unique_user
  ON memberships(auth_provider, auth_sub);

CREATE INDEX IF NOT EXISTS idx_memberships_tenant
  ON memberships(tenant_id);

-- ── Schema version marker ────────────────────────────────────
-- Future migrations check this and apply changes only when the
-- on-disk version is older than the expected version. Initial
-- value is 1 — this is the v1 multi-tenant schema.
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, applied_at)
VALUES (1, datetime('now'));
