-- All memberships for your tenant
SELECT m.id, m.auth_sub, m.role::text, m.created_at
FROM memberships m
WHERE m.tenant_id = '53f2e104-4192-439b-abdc-70954bfa9583'
ORDER BY m.created_at;

-- Your specific membership
SELECT m.id, m.auth_sub, m.role::text, m.created_at
FROM memberships m
WHERE m.auth_sub = '***REMOVED***';

-- What permissions does your role have?
SELECT rp.role::text, rp.permission
FROM role_permissions rp
JOIN memberships m ON m.role = rp.role
WHERE m.auth_sub = '***REMOVED***'
ORDER BY rp.permission;

-- All pending invites for your tenant
BEGIN;
SELECT set_config('app.current_tenant_id', '53f2e104-4192-439b-abdc-70954bfa9583', true);
SELECT id, email, role::text, status::text, invited_by, created_at
FROM invites
ORDER BY created_at DESC;
COMMIT;