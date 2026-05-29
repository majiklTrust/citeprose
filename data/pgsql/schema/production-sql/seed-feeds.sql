-- ═══════════════════════════════════════════════════════════════
-- seed-feeds.sql — Seed default RSS feeds for a tenant
-- ═══════════════════════════════════════════════════════════════
-- Run AFTER the tenant and topics exist in the database.
-- This is NOT part of the schema build — it's operational data.
--
-- Usage:
-- psql -U agent -d ***REMOVED*** \
--   -v tenant_id="'$LAST_TENANT_ID'" \
--   -f data/pgsql/seed-feeds.sql
--
-- Or edit the v_tenant variable below directly.
-- ═══════════════════════════════════════════════════════════════

-- Pass the tenant UUID into the DO block via a session setting.
-- psql -v substitution works here (outside $$ quoting).
SELECT set_config('seed.tenant_id', :'tenant_id', false);

DO $$
DECLARE
  -- Read the tenant UUID from the session setting
  v_tenant UUID := current_setting('seed.tenant_id')::uuid;
  v_feed_id BIGINT;
  v_topic_id BIGINT;
BEGIN
  -- Set tenant context for RLS
  PERFORM set_config('app.current_tenant_id', v_tenant::text, true);

  -- ── Cybersecurity Incidents & Threat Intel ───────────────

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://krebsonsecurity.com/feed/', 'Krebs on Security', 'primary', 120)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://www.bleepingcomputer.com/feed/', 'BleepingComputer', 'primary', 60)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://therecord.media/feed', 'The Record by Recorded Future', 'primary', 120)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://www.darkreading.com/rss.xml', 'Dark Reading', 'primary', 120)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://feeds.feedburner.com/TheHackersNews', 'The Hacker News', 'secondary', 90)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://www.cisa.gov/news.xml', 'CISA Alerts', 'authoritative', 180)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://securelist.com/feed/', 'Securelist (Kaspersky)', 'primary', 240)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  -- ── Cybersecurity Technology & Advances ──────────────────

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://www.schneier.com/feed/atom/', 'Schneier on Security', 'primary', 240)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-guardrails' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://blog.google/technology/safety-security/rss/', 'Google Security Blog', 'primary', 360)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://api.msrc.microsoft.com/update-guide/rss', 'Microsoft Security Response Center', 'authoritative', 360)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-advances' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'cybersecurity-incidents' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  -- ── AI Practical Benefits & Guardrails ──────────────────

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://blog.google/technology/ai/rss/', 'Google AI Blog', 'primary', 360)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-practical-benefit' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://openai.com/blog/rss.xml', 'OpenAI Blog', 'primary', 360)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-practical-benefit' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-guardrails' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://www.technologyreview.com/feed/', 'MIT Technology Review', 'primary', 240)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-practical-benefit' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-guardrails' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://techcrunch.com/category/artificial-intelligence/feed/', 'TechCrunch AI', 'secondary', 120)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-practical-benefit' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
  VALUES (v_tenant, 'https://simonwillison.net/atom/everything/', 'Simon Willison', 'primary', 240)
  ON CONFLICT (tenant_id, url) DO NOTHING
  RETURNING id INTO v_feed_id;
  IF v_feed_id IS NOT NULL THEN
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-practical-benefit' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
    SELECT id INTO v_topic_id FROM topics WHERE slug = 'ai-guardrails' AND tenant_id = v_tenant;
    IF v_topic_id IS NOT NULL THEN
      INSERT INTO feed_topics (tenant_id, feed_id, topic_id) VALUES (v_tenant, v_feed_id, v_topic_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

END$$;
