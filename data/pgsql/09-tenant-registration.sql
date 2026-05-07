-- ═══════════════════════════════════════════════════════════════
-- 09-tenant-registration.sql — Self-service tenant registration
-- ═══════════════════════════════════════════════════════════════
-- Target: ***REMOVED*** (schema: public)
-- Run as: agent (superuser)
-- Prerequisite: 01-platform.sql applied (tenants table exists).
--
-- Platform-level table — no RLS. Registration tokens are created
-- by the platform admin and consumed by unauthenticated users
-- during the signup flow. The app needs access before any tenant
-- context exists.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenant_registrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token           TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'claimed', 'expired')),
  invited_by_sub  TEXT NOT NULL,
  tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tenant_registrations_token
  ON tenant_registrations (token) WHERE status IN ('pending', 'active');

CREATE INDEX IF NOT EXISTS idx_tenant_registrations_email
  ON tenant_registrations (lower(email));

COMMENT ON TABLE tenant_registrations IS
  'Platform-level registration tokens for self-service tenant provisioning. No RLS.';
COMMENT ON COLUMN tenant_registrations.status IS
  'pending = created, active = page loaded, claimed = registration complete, expired = TTL passed.';
COMMENT ON COLUMN tenant_registrations.tenant_id IS
  'Set when the registration completes and the tenant is created. NULL until then.';

-- ── Grants ───────────────────────────────────────────────────
-- App needs full DML: INSERT (create invite), SELECT (validate),
-- UPDATE (mark active/claimed/expired), DELETE (cleanup).
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_registrations TO linkedin_agent_app;

-- Admin role gets full access for maintenance
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_registrations TO linkedin_agent_admin;
