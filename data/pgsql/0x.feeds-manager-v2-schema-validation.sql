-- ═══════════════════════════════════════════════════════════════
-- 0x-verify-migrations.sql — Check whether DDL migrations are applied
-- ═══════════════════════════════════════════════════════════════
-- Run against any environment to verify schema state.
-- Each check returns APPLIED or MISSING.
--
-- Usage:
--   psql -U $PGUSER -d $PGDATABASE -f data/pgsql/0x-verify-migrations.sql
-- ═══════════════════════════════════════════════════════════════

\echo ''
\echo '══════════════════════════════════════════════════'
\echo '  Migration Verification Report'
\echo '══════════════════════════════════════════════════'
\echo ''

-- ── 11-feeds-domains.sql ─────────────────────────────────────
\echo '── 11-feeds-domains.sql ──'

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'feeds_v2' AND column_name = 'domains'
) THEN '  ✓ APPLIED  feeds_v2.domains'
  ELSE '  ✗ MISSING  feeds_v2.domains' END AS result;

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'topics' AND column_name = 'domains'
) THEN '  ✓ APPLIED  topics.domains'
  ELSE '  ✗ MISSING  topics.domains' END AS result;

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_indexes
  WHERE tablename = 'feeds_v2' AND indexname LIKE '%domains%'
) THEN '  ✓ APPLIED  feeds_v2 domains GIN index'
  ELSE '  ✗ MISSING  feeds_v2 domains GIN index' END AS result;

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_indexes
  WHERE tablename = 'topics' AND indexname LIKE '%domains%'
) THEN '  ✓ APPLIED  topics domains GIN index'
  ELSE '  ✗ MISSING  topics domains GIN index' END AS result;

-- ── 12-image-support.sql ─────────────────────────────────────
\echo ''
\echo '── 12-image-support.sql ──'

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'articles_v2' AND column_name = 'image_url'
) THEN '  ✓ APPLIED  articles_v2.image_url'
  ELSE '  ✗ MISSING  articles_v2.image_url' END AS result;

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'posts' AND column_name = 'image_url'
) THEN '  ✓ APPLIED  posts.image_url'
  ELSE '  ✗ MISSING  posts.image_url' END AS result;

-- ── 12.1-articles-update-grant.sql ───────────────────────────
\echo ''
\echo '── 12.1-articles-update-grant.sql ──'

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.role_table_grants
  WHERE table_name = 'articles_v2'
    AND grantee = 'linkedin_agent_app'
    AND privilege_type = 'UPDATE'
) THEN '  ✓ APPLIED  UPDATE grant on articles_v2'
  ELSE '  ✗ MISSING  UPDATE grant on articles_v2' END AS result;

-- ── 14-feed-validation.sql ───────────────────────────────────
\echo ''
\echo '── 14-feed-validation.sql ──'

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'feeds_v2' AND column_name = 'consecutive_failures'
) THEN '  ✓ APPLIED  feeds_v2.consecutive_failures'
  ELSE '  ✗ MISSING  feeds_v2.consecutive_failures' END AS result;

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'feeds_v2' AND column_name = 'last_validation_grade'
) THEN '  ✓ APPLIED  feeds_v2.last_validation_grade'
  ELSE '  ✗ MISSING  feeds_v2.last_validation_grade' END AS result;

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'feeds_v2' AND column_name = 'last_validated_at'
) THEN '  ✓ APPLIED  feeds_v2.last_validated_at'
  ELSE '  ✗ MISSING  feeds_v2.last_validated_at' END AS result;

-- ── 15-agent-state-schema.sql ────────────────────────────────
\echo ''
\echo '── 15-agent-state-schema.sql ──'

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_name = 'agent_state_schema'
) THEN '  ✓ APPLIED  agent_state_schema table'
  ELSE '  ✗ MISSING  agent_state_schema table' END AS result;

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'agent_state_schema' AND column_name = 'value_type'
) THEN '  ✓ APPLIED  agent_state_schema.value_type column'
  ELSE '  ✗ MISSING  agent_state_schema.value_type column' END AS result;

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgname = 'trg_validate_agent_state'
) THEN '  ✓ APPLIED  agent_state validation trigger'
  ELSE '  ✗ MISSING  agent_state validation trigger' END AS result;

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'chk_validation_grade'
) THEN '  ✓ APPLIED  feeds_v2 validation grade CHECK constraint'
  ELSE '  ✗ MISSING  feeds_v2 validation grade CHECK constraint' END AS result;

SELECT '  ✓ KEYS     ' || count(*) || ' keys registered' AS result
FROM agent_state_schema;

-- ── 16-feeds-manager-version-key.sql ─────────────────────────
\echo ''
\echo '── 16-feeds-manager-version-key.sql ──'

SELECT CASE WHEN EXISTS (
  SELECT 1 FROM agent_state_schema
  WHERE key = 'feeds_manager_version'
) THEN '  ✓ APPLIED  feeds_manager_version registered in schema'
  ELSE '  ✗ MISSING  feeds_manager_version not in schema' END AS result;

-- ── Summary ──────────────────────────────────────────────────
\echo ''
\echo '══════════════════════════════════════════════════'

SELECT '  Total checks: 14  |  Missing: ' ||
  (14 - (
    (SELECT count(*) FROM information_schema.columns WHERE table_name = 'feeds_v2' AND column_name IN ('domains','consecutive_failures','last_validation_grade','last_validated_at')) +
    (SELECT count(*) FROM information_schema.columns WHERE table_name = 'topics' AND column_name = 'domains') +
    (SELECT count(*) FROM information_schema.columns WHERE table_name = 'articles_v2' AND column_name = 'image_url') +
    (SELECT count(*) FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'image_url') +
    (SELECT count(*) FROM information_schema.role_table_grants WHERE table_name = 'articles_v2' AND grantee = 'linkedin_agent_app' AND privilege_type = 'UPDATE') +
    (SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_state_schema') THEN 1 ELSE 0 END) +
    (SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_validate_agent_state') THEN 1 ELSE 0 END) +
    (SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_validation_grade') THEN 1 ELSE 0 END) +
    (SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'feeds_v2' AND indexname LIKE '%domains%') THEN 1 ELSE 0 END) +
    (SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'topics' AND indexname LIKE '%domains%') THEN 1 ELSE 0 END)
  )) AS summary;

\echo '══════════════════════════════════════════════════'
\echo ''
