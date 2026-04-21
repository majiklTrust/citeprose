-- ═══════════════════════════════════════════════════════════════
-- Phase 5 DDL — Invites table for user management
-- ═══════════════════════════════════════════════════════════════
-- Target: ***REMOVED*** (schema: public)
-- Run as: agent (superuser)
--
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a
-- transaction block. Run this file as standalone statements.
-- ═══════════════════════════════════════════════════════════════

-- Step 1: Create invite_status enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invite_status') THEN
    CREATE TYPE invite_status AS ENUM ('pending', 'claimed', 'revoked', 'expired');
  END IF;
END$$;

-- Step 2: Create invites table
CREATE TABLE IF NOT EXISTS invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  email           TEXT NOT NULL,
  email_domain    TEXT NOT NULL,
  role            member_role NOT NULL,
  invited_by      TEXT NOT NULL,
  status          invite_status NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  claimed_at      TIMESTAMPTZ,
  claimed_by_sub  TEXT
);

-- Step 3: Unique partial index — one pending invite per email per tenant
-- Uses lower(email) for case-insensitive duplicate prevention
CREATE UNIQUE INDEX IF NOT EXISTS uq_invites_pending_email
  ON invites (tenant_id, lower(email))
  WHERE status = 'pending';

-- Step 4: No RLS on invites
-- The invites table is a platform table, like memberships. The
-- invite claim flow in the resolver queries invites BEFORE any
-- tenant context exists (to find which tenant the invite belongs
-- to). RLS would block these queries because ***REMOVED***
-- has NOBYPASSRLS. All queries use explicit WHERE tenant_id
-- clauses instead.

-- Step 5: Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON invites TO ***REMOVED***;
