
-- Step 1: Find the missing catchall feed for the original tenant
SELECT name, url, is_catchall
FROM feeds_v2
WHERE is_catchall = false
  AND tenant_id = '<TENANT_ID>'
  AND url IN (
    'https://www.technologyreview.com/feed/',
    'https://www.wired.com/feed/rss',
    'https://feeds.arstechnica.com/arstechnica/index',
    'https://www.theverge.com/rss/index.xml',
    'https://www.zdnet.com/news/rss.xml',
    'https://hbr.org/feed',
    'https://www.forbes.com/innovation/feed/',
    'https://www.fastcompany.com/latest/rss',
    'https://feeds.bbci.co.uk/news/technology/rss.xml',
    'https://www.reutersagency.com/feed/',
    'https://feeds.npr.org/1019/rss.xml',
    'https://www.nature.com/nature.rss',
    'https://rss.sciam.com/ScientificAmerican-Global',
    'https://www.statnews.com/feed/',
    'https://www.brookings.edu/feed/'
  )
ORDER BY is_catchall, name;

-- Step 2: Flip it to catchall
UPDATE feeds_v2
SET is_catchall = true
WHERE tenant_id = '<TENANT_ID>'
  AND url = '<URL>'
  AND is_catchall = false;

  -- Step 3: Verify all three tenants match
SELECT tenant_id, count(*) AS catchall_feeds
FROM feeds_v2
WHERE is_catchall = true
GROUP BY tenant_id
ORDER BY tenant_id;
