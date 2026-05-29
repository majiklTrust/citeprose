-- ═══════════════════════════════════════════════════════════════
-- 12-image-support.sql — Image URL columns for posts + articles
-- ═══════════════════════════════════════════════════════════════
-- Additive: both columns default to NULL. Existing rows are
-- unaffected. Text-only posts continue to work unchanged.
--
-- articles_v2.image_url: captured from RSS <enclosure>,
--   <media:content>, or <media:thumbnail> during polling.
--   Not all articles have images — NULL is common.
--
-- posts.image_url: the image chosen for this post. Set during
--   content generation (auto-sourced from articles) or by the
--   user (upload or URL). NULL = text-only post.
-- ═══════════════════════════════════════════════════════════════

-- ── Article image URL (from RSS) ─────────────────────────────
ALTER TABLE articles_v2
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN articles_v2.image_url IS
  'Image URL harvested from RSS enclosure, media:content, or media:thumbnail. NULL if no image found in the feed item.';

-- ── Post image URL (chosen for publishing) ───────────────────
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN posts.image_url IS
  'Image URL to upload and attach to the LinkedIn post. NULL = text-only post. Set by auto-source from articles, user upload, or manual URL entry.';
