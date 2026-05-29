-- ═══════════════════════════════════════════════════════════════
-- 16-feeds-manager-version-key.sql — Per-tenant FM version config
-- ═══════════════════════════════════════════════════════════════
-- Registers feeds_manager_version as a valid agent_state key.
-- Allows tenants to be on different FM versions independently.
--
-- Fallback chain: agent_state (per-tenant) → .env (global) → 1
-- ═══════════════════════════════════════════════════════════════

INSERT INTO agent_state_schema (key, value_type, allowed_values, default_value, description)
VALUES (
  'feeds_manager_version',
  'enum',
  '{"1","2"}',
  '1',
  'Feeds Manager version. 1 = basic feed-topic mappings. 2 = domain tagging, AI discovery, domain-based article matching.'
)
ON CONFLICT (key) DO UPDATE SET
  value_type = EXCLUDED.value_type,
  allowed_values = EXCLUDED.allowed_values,
  default_value = EXCLUDED.default_value,
  description = EXCLUDED.description;
