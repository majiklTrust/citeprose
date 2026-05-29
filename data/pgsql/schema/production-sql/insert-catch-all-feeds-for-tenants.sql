INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes, is_catchall)
SELECT t.id, f.url, f.name, f.tier::feed_tier, f.refresh, true
FROM tenants t
CROSS JOIN (VALUES
  ('https://www.technologyreview.com/feed/', 'MIT Technology Review', 'primary', 240),
  ('https://www.wired.com/feed/rss', 'Wired', 'secondary', 120),
  ('https://feeds.arstechnica.com/arstechnica/index', 'Ars Technica', 'primary', 120),
  ('https://www.theverge.com/rss/index.xml', 'The Verge', 'secondary', 120),
  ('https://www.zdnet.com/news/rss.xml', 'ZDNet', 'secondary', 120),
  ('https://hbr.org/feed', 'Harvard Business Review', 'primary', 360),
  ('https://www.forbes.com/innovation/feed/', 'Forbes Innovation', 'secondary', 180),
  ('https://www.fastcompany.com/latest/rss', 'Fast Company', 'secondary', 180),
  ('https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Technology', 'primary', 180),
  ('https://www.reutersagency.com/feed/', 'Reuters', 'primary', 120),
  ('https://feeds.npr.org/1019/rss.xml', 'NPR Technology', 'primary', 240),
  ('https://www.nature.com/nature.rss', 'Nature News', 'primary', 360),
  ('https://rss.sciam.com/ScientificAmerican-Global', 'Scientific American', 'primary', 360),
  ('https://www.statnews.com/feed/', 'STAT News', 'primary', 240),
  ('https://www.brookings.edu/feed/', 'Brookings Institution', 'primary', 360)
) AS f(url, name, tier, refresh)
WHERE t.status = 'active'
ON CONFLICT (tenant_id, url) DO NOTHING;
