-- ═══════════════════════════════════════════════════════════════
-- 10-feeds-catchall.sql — Catchall flag + feed metadata
-- ═══════════════════════════════════════════════════════════════
-- Adds is_catchall, feed_description, and feed_categories to
-- feeds_v2. Catchall feeds serve ALL topics without feed_topics
-- mappings. Metadata fields are populated automatically during
-- RSS polling from the feed's own XML.
-- ═══════════════════════════════════════════════════════════════

-- ── Catchall flag ────────────────────────────────────────────
ALTER TABLE feeds_v2
  ADD COLUMN IF NOT EXISTS is_catchall BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_feeds_v2_catchall
  ON feeds_v2 (tenant_id, is_catchall)
  WHERE is_catchall = true;

COMMENT ON COLUMN feeds_v2.is_catchall IS
  'When true, this feed serves ALL topics without explicit feed_topics mappings.';

-- ── Feed metadata (derived from RSS XML) ─────────────────────
-- Populated automatically during polling. No manual entry needed.
--   feed_description: <channel><description> from RSS
--   feed_categories:  <channel><category> + aggregated <item><category>
ALTER TABLE feeds_v2
  ADD COLUMN IF NOT EXISTS feed_description TEXT,
  ADD COLUMN IF NOT EXISTS feed_categories JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN feeds_v2.feed_description IS
  'Channel description from RSS XML. Populated on first poll. Used for relevance matching.';
COMMENT ON COLUMN feeds_v2.feed_categories IS
  'JSONB array of category strings. Initially from <channel><category>, enriched over time from <item><category> aggregation.';
