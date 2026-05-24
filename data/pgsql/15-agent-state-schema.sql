-- ═══════════════════════════════════════════════════════════════
-- 15-agent-state-schema.sql — Typed config registry + enforcement
-- ═══════════════════════════════════════════════════════════════
-- Adds type enforcement to agent_state via a schema registry
-- and a validation trigger. Every write to agent_state is
-- validated against the registry:
--
--   1. Key must exist in agent_state_schema (rejects unknown keys)
--   2. If allowed_values is set, value must be in the list
--   3. If value_type is 'boolean', value must be 'true'/'false'
--   4. If value_type is 'integer', value must be numeric
--
-- Also adds a CHECK constraint on feeds_v2.last_validation_grade
-- to restrict it to valid grades (A/B/C/F).
--
-- Re-runnable: uses IF NOT EXISTS, ON CONFLICT DO UPDATE, and
-- CREATE OR REPLACE for idempotency.
-- ═══════════════════════════════════════════════════════════════

-- ── Schema registry ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_state_schema (
  key            TEXT PRIMARY KEY,
  value_type     TEXT NOT NULL DEFAULT 'string'
                   CHECK (value_type IN ('string', 'enum', 'boolean', 'integer')),
  allowed_values TEXT[],
  default_value  TEXT,
  description    TEXT,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_state_schema IS
  'Registry of valid agent_state keys with type enforcement. Trigger on agent_state validates writes against this table.';

COMMENT ON COLUMN agent_state_schema.value_type IS
  'Expected type: string (any text), enum (must be in allowed_values), boolean (true/false), integer (numeric).';

-- ── Current keys ─────────────────────────────────────────────

INSERT INTO agent_state_schema (key, value_type, allowed_values, default_value, description) VALUES
  ('mode',
   'enum',
   '{"manual","auto"}',
   'manual',
   'Content generation mode. manual = on demand only. auto = scheduled.'),

  ('paused',
   'boolean',
   NULL,
   'false',
   'Pause all scheduled operations. Does not affect manual triggers.'),

  ('corroboration',
   'enum',
   '{"enabled","disabled"}',
   'enabled',
   'Research corroboration toggle. When disabled, skips cross-source verification.'),

  ('anthropic_model',
   'string',
   NULL,
   NULL,
   'Anthropic model ID. Any claude-* string. Falls back to ANTHROPIC_MODEL env then claude-haiku-4-5-20251001.'),

  ('feed_validation_action',
   'enum',
   '{"log_only","disable","skip"}',
   'log_only',
   'Behavior on feed validation failure. log_only = keep feed, log warning. disable = mark inactive. skip = exclude from polling.')

ON CONFLICT (key) DO UPDATE SET
  value_type = EXCLUDED.value_type,
  allowed_values = EXCLUDED.allowed_values,
  default_value = EXCLUDED.default_value,
  description = EXCLUDED.description;

-- ── Validation trigger ───────────────────────────────────────

CREATE OR REPLACE FUNCTION validate_agent_state()
RETURNS TRIGGER AS $$
DECLARE
  schema_row agent_state_schema%ROWTYPE;
BEGIN
  -- 1. Key must exist in the registry
  SELECT * INTO schema_row
  FROM agent_state_schema
  WHERE key = NEW.key;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent_state key "%" is not registered in agent_state_schema', NEW.key;
  END IF;

  -- 2. Type-specific validation
  CASE schema_row.value_type
    WHEN 'boolean' THEN
      IF NEW.value NOT IN ('true', 'false') THEN
        RAISE EXCEPTION 'agent_state key "%" requires boolean (true/false), got "%"', NEW.key, NEW.value;
      END IF;

    WHEN 'integer' THEN
      IF NEW.value !~ '^\d+$' THEN
        RAISE EXCEPTION 'agent_state key "%" requires integer, got "%"', NEW.key, NEW.value;
      END IF;

    WHEN 'enum' THEN
      IF schema_row.allowed_values IS NOT NULL
         AND NEW.value != ALL(schema_row.allowed_values) THEN
        RAISE EXCEPTION 'agent_state key "%" value "%" not in allowed values: %',
          NEW.key, NEW.value, schema_row.allowed_values;
      END IF;

    ELSE
      -- 'string' type: no validation beyond key existence
      NULL;
  END CASE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger (drop first for idempotency)
DROP TRIGGER IF EXISTS trg_validate_agent_state ON agent_state;

CREATE TRIGGER trg_validate_agent_state
  BEFORE INSERT OR UPDATE ON agent_state
  FOR EACH ROW
  EXECUTE FUNCTION validate_agent_state();

-- ── Feed validation grade constraint ─────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_validation_grade'
  ) THEN
    ALTER TABLE feeds_v2
      ADD CONSTRAINT chk_validation_grade
      CHECK (last_validation_grade IS NULL OR last_validation_grade IN ('A', 'B', 'C', 'F'));
  END IF;
END $$;
