-- ═══════════════════════════════════════════════════════════════
-- 11-feeds-domains.sql — Domain tags for Feeds Manager v2.0
-- ═══════════════════════════════════════════════════════════════
-- Adds domain tag arrays to feeds_v2 and topics for domain-based
-- feed-topic matching. Tags are JSONB arrays of lowercase strings
-- (e.g., ["security", "regulatory", "government"]).
--
-- Non-destructive:
--   • Default '[]' matches nothing — v1 behavior unchanged
--   • FEEDS_MANAGER_VERSION=1 ignores these columns entirely
--   • FEEDS_MANAGER_VERSION=2 activates domain matching
--   • Switching back to v1 leaves tags dormant, no data loss
--
-- GIN indexes support future SQL-side JSONB containment queries
-- (v2 starts with application-side filtering; indexes are
-- pre-built for the optimization path).
-- ═══════════════════════════════════════════════════════════════

-- ── Feed domain tags ─────────────────────────────────────────
ALTER TABLE feeds_v2
  ADD COLUMN IF NOT EXISTS domains JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN feeds_v2.domains IS
  'JSONB array of lowercase domain tag strings. Used by Feeds Manager v2 for domain-based topic matching. Empty array = no domain matching (catchall or topic-specific only).';

CREATE INDEX IF NOT EXISTS idx_feeds_v2_domains
  ON feeds_v2 USING GIN (domains);

-- ── Topic domain tags ────────────────────────────────────────
ALTER TABLE topics
  ADD COLUMN IF NOT EXISTS domains JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN topics.domains IS
  'JSONB array of lowercase domain tag strings. Matched against feed domains when FEEDS_MANAGER_VERSION=2. Empty array = topic uses only feed_topics mappings and catchall feeds.';

CREATE INDEX IF NOT EXISTS idx_topics_domains
  ON topics USING GIN (domains);
