-- ═══════════════════════════════════════════════════════════════
-- 10.x-insert-catchall.sql — default set of catchall feeds
-- ═══════════════════════════════════════════════════════════════
-- Adds defualt feeds to an existing tenant
-- ═══════════════════════════════════════════════════════════════
\set tenant_id '<uuid>'

BEGIN;
SELECT set_config('app.current_tenant_id', :'tenant_id', true);
INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes, is_catchall) VALUES
  (current_tenant_id(), 'https://www.technologyreview.com/feed/', 'MIT Technology Review', 'primary', 240, true),
  (current_tenant_id(), 'https://www.wired.com/feed/rss', 'Wired', 'secondary', 120, true),
  (current_tenant_id(), 'https://feeds.arstechnica.com/arstechnica/index', 'Ars Technica', 'primary', 120, true),
  (current_tenant_id(), 'https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Technology', 'primary', 180, true),
  (current_tenant_id(), 'https://hbr.org/feed', 'Harvard Business Review', 'primary', 360, true)
ON CONFLICT (tenant_id, url) DO NOTHING;
COMMIT;