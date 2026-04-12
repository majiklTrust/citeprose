-- patch-fixup-tenants-status.sql
\set ON_ERROR_STOP on

BEGIN;

-- Drop the partial index that's blocking the type change
DROP INDEX IF EXISTS idx_tenants_status_active;

-- Now the type change can proceed
ALTER TABLE tenants
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE tenant_status USING status::text::tenant_status,
  ALTER COLUMN status SET DEFAULT 'active'::tenant_status;

-- Recreate the index with an explicit enum cast.
-- The literal 'active'::tenant_status is fully resolved at parse
-- time, so the predicate is immutable as far as PostgreSQL cares.
CREATE INDEX idx_tenants_status_active
  ON tenants(id) WHERE status = 'active'::tenant_status;

COMMIT;