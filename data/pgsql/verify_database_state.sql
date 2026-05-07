select '-- Registration claimed';
SELECT status, tenant_id, claimed_at
FROM tenant_registrations
ORDER BY created_at DESC
LIMIT 1;

select '-- New tenant created';
SELECT id, slug, name, status FROM tenants ORDER BY created_at DESC LIMIT 1;

select '-- Pending owner invite';
SELECT tenant_id, email, role::text, status::text
FROM invites
ORDER BY created_at DESC
LIMIT 1;

select '-- Agent state seeded';
BEGIN;
SELECT set_config('app.current_tenant_id', '<new_tenant_uuid>', true);
SELECT key, value FROM agent_state;
COMMIT;

select '-- Credentials stored';
BEGIN;
SELECT set_config('app.current_tenant_id', '<new_tenant_uuid>', true);
SELECT key FROM credentials;
COMMIT;
