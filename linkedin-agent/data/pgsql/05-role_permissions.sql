-- ═══════════════════════════════════════════════════════════════
-- Phase 2 + Phase 4 DDL — Role permissions + activity log attribution
-- ═══════════════════════════════════════════════════════════════
-- Target: ***REMOVED*** (schema: public)
-- Run as: agent (superuser — needs ALTER TYPE privilege)
--
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a
-- transaction block. Run these two lines FIRST, outside BEGIN:
-- ═══════════════════════════════════════════════════════════════

-- Phase 2, Step 1: Expand member_role enum
-- Run OUTSIDE a transaction (cannot be rolled back)
ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'editor';
ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'viewer';

-- Phase 2, Step 2: Global permissions lookup table
-- Not tenant-scoped — same permission matrix for all tenants.
-- No RLS needed.
CREATE TABLE IF NOT EXISTS role_permissions (
  role        member_role    NOT NULL,
  permission  VARCHAR(64)    NOT NULL,
  PRIMARY KEY (role, permission)
);

-- Phase 2, Step 3: Seed the permission matrix
INSERT INTO role_permissions (role, permission) VALUES
  -- owner: full control
  ('owner', 'view_dashboard'),
  ('owner', 'preview_post'),
  ('owner', 'edit_post'),
  ('owner', 'approve_reject_post'),
  ('owner', 'force_cycle'),
  ('owner', 'refresh_feeds'),
  ('owner', 'change_mode'),
  ('owner', 'toggle_corroboration'),
  ('owner', 'connect_linkedin'),
  ('owner', 'manage_users'),
  -- editor: everything except user management
  ('editor', 'view_dashboard'),
  ('editor', 'preview_post'),
  ('editor', 'edit_post'),
  ('editor', 'approve_reject_post'),
  ('editor', 'force_cycle'),
  ('editor', 'refresh_feeds'),
  ('editor', 'change_mode'),
  ('editor', 'toggle_corroboration'),
  ('editor', 'connect_linkedin'),
  -- viewer: read + content review only
  ('viewer', 'view_dashboard'),
  ('viewer', 'preview_post'),
  ('viewer', 'edit_post'),
  ('viewer', 'approve_reject_post')
ON CONFLICT DO NOTHING;

-- Phase 4: Activity log attribution
-- Adds user_sub column so each log entry records which user
-- performed the action. Nullable because existing rows don't
-- have this data and system-initiated actions have no user.
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS user_sub TEXT;

-- Grants: ***REMOVED*** needs to read the permissions table
-- and INSERT/DELETE on memberships for user management (Phase 5)
-- and test infrastructure (role enforcement tests).
GRANT SELECT ON role_permissions TO ***REMOVED***;
GRANT INSERT, UPDATE, DELETE ON memberships TO ***REMOVED***;
