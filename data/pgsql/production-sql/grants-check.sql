\c linkedin_dev

-- What role owns feed_articles?
SELECT tableowner FROM pg_tables WHERE tablename = 'feed_articles';

-- What grants exist on feed_articles?
SELECT grantee, string_agg(privilege_type, ', ') AS privileges
FROM information_schema.table_privileges
WHERE table_name = 'feed_articles'
GROUP BY grantee;

-- What role does the app connect as?
SELECT rolname FROM pg_roles WHERE rolname LIKE 'liagt%' OR rolname LIKE 'linkedin%';


\c linkedin_dev ***REMOVED***

BEGIN;
SELECT set_config('app.current_tenant_id', '53f2e104-4192-439b-abdc-70954bfa9583', true);

-- Test 1: Can we read feeds?
SELECT count(*) AS feeds FROM feeds_v2;

-- Test 2: Can we insert a global article?
INSERT INTO articles_v2 (title, link, summary)
VALUES ('test', 'https://test.example/perm-check', 'test')
ON CONFLICT (link) DO NOTHING;

-- Test 3: Can we insert a feed_articles link?
INSERT INTO feed_articles (tenant_id, feed_id, article_id)
VALUES (current_tenant_id(), 
  (SELECT id FROM feeds_v2 LIMIT 1),
  (SELECT id FROM articles_v2 WHERE link = 'https://test.example/perm-check'))
ON CONFLICT DO NOTHING;

-- Clean up
DELETE FROM feed_articles WHERE article_id = (SELECT id FROM articles_v2 WHERE link = 'https://test.example/perm-check');
DELETE FROM articles_v2 WHERE link = 'https://test.example/perm-check';

ROLLBACK;