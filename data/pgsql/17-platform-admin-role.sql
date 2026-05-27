-- ═══════════════════════════════════════════════════════════════
-- 17-platform-admin-role.sql
-- ═══════════════════════════════════════════════════════════════
-- Grants the app role (linkedin_agent_app) the ability to assume
-- the admin role (***REMOVED***) via SET LOCAL ROLE. This is used
-- exclusively by platform-admin-api.js to bypass RLS for
-- cross-tenant administrative queries.
--
-- SET LOCAL ROLE is transaction-scoped — the elevated role
-- reverts automatically on COMMIT/ROLLBACK. The pooled
-- connection returns to linkedin_agent_app with no leaked
-- privileges.
--
-- Prerequisites:
--   • ***REMOVED*** must exist with BYPASSRLS or SUPERUSER
--   • linkedin_agent_app must exist
--
-- Idempotent: re-running is a no-op if the grant already exists.
-- ═══════════════════════════════════════════════════════════════

-- Allow the app role to assume the admin role inside transactions
GRANT ***REMOVED*** TO linkedin_agent_app;

-- Verify the grant was applied
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid = '***REMOVED***'::regrole
      AND member = 'linkedin_agent_app'::regrole
  ) THEN
    RAISE NOTICE '  ✓ GRANT ***REMOVED*** TO linkedin_agent_app confirmed';
  ELSE
    RAISE WARNING '  ✗ GRANT ***REMOVED*** TO linkedin_agent_app FAILED';
  END IF;
END $$;
