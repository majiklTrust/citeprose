INSERT INTO memberships (auth_provider, auth_sub, tenant_id, role)
VALUES ('auth0', 'auth0|test_user_001', '53f2e104-4192-439b-abdc-70954bfa9583', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO memberships (auth_provider, auth_sub, tenant_id, role)
VALUES ('auth0', '***REMOVED***', '53f2e104-4192-439b-abdc-70954bfa9583', 'owner')
ON CONFLICT DO NOTHING;
