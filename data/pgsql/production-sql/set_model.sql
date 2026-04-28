-- GET MODEL
-- RLS PROTECTED 
SELECT set_config('app.current_tenant_id', '53f2e104-4192-439b-abdc-70954bfa9583', true);
SELECT value FROM agent_state WHERE key = 'anthropic_model';
--AS SUPER
SELECT tenant_id,key,value FROM agent_state WHERE key = 'anthropic_model' AND tenant_id = '53f2e104-4192-439b-abdc-70954bfa9583';

-- SET MODEL
-- USING POLICY (RLS)
SELECT set_config('app.current_tenant_id', '53f2e104-4192-439b-abdc-70954bfa9583', true);
INSERT INTO agent_state (tenant_id, key, value)
VALUES (current_tenant_id(), 'anthropic_model', 'claude-sonnet-4-6')
ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value;
-- AS SUPER USER
INSERT INTO agent_state (tenant_id, key, value)
VALUES ('53f2e104-4192-439b-abdc-70954bfa9583', 'anthropic_model', 'claude-sonnet-4-6');

-- DELETE MODEL
-- USING POLICY (RLS)
SELECT set_config('app.current_tenant_id', '53f2e104-4192-439b-abdc-70954bfa9583', true);
DELETE FROM agent_state WHERE key = 'anthropic_model';
-- AS SUPER USER
DELETE FROM agent_state WHERE key = 'anthropic_model' AND tenant_id = '53f2e104-4192-439b-abdc-70954bfa9583';
