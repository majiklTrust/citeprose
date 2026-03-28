

sqlite3 data/agent.db "SELECT id, substr(title, 1, 40), length(content) FROM posts ORDER BY id DESC LIMIT 10;"
-- sqlite3 data/agent.db "DELETE FROM posts WHERE title LIKE 'TTT%' OR title = 'Test' OR title = 'Test title';"
sqlite3 data/agent.db "SELECT id, substr(title, 1, 40), status FROM posts WHERE status = 'pending_approval';"
-- sqlite3 data/agent.db "UPDATE posts SET status = 'rejected' WHERE title IN ('Test', 'Test title') OR title LIKE 'TTT%';"

sqlite3 -batch data/agent.db "DELETE FROM articles WHERE feed_name='TEST-FEED';"
sqlite3 -batch data/agent.db "SELECT title,link FROM articles WHERE feed_name='TEST-FEED';"
-- posts with cycleId
SELECT id, json_extract(news_context, '$.cycleId') AS cycleId, topic_id, title, status FROM posts ORDER BY id DESC;

-- Is the corroboration indicator (whether set on/off) as well as the corroboration status (skipped, well... etc) able to connected to a post through SQL?

/**
The CASE logic mirrors exactly what getCorroborationLevel() does in the dashboard JavaScript. corroborationSkipped
being 1/true means the toggle was OFF when that post was generated — the corroboration step was bypassed entirely. 
When it's null or false, the pipeline ran corroboration and verifiedClaims tells you how many claims were independently verified across multiple sources.
*/
SELECT
  id,
  json_extract(news_context, '$.cycleId') AS cycleId,
  topic_id,
  title,
  status,
  CASE
    WHEN json_extract(news_context, '$.researchSummary.corroborationSkipped') = 1 THEN 'skipped'
    WHEN json_extract(news_context, '$.researchSummary.verifiedClaims') >= 3 THEN 'well-corroborated'
    WHEN json_extract(news_context, '$.researchSummary.verifiedClaims') >= 1 THEN 'limited'
    ELSE 'uncorroborated'
  END AS corrobLevel,
  json_extract(news_context, '$.researchSummary.corroborationSkipped') AS corrobSkipped,
  json_extract(news_context, '$.researchSummary.verifiedClaims') AS verifiedClaims
FROM posts
ORDER BY id DESC;

SELECT count(*) AS pending_count FROM posts WHERE status = 'pending_approval';
SELECT id, topic_id, title, created_at, json_extract(news_context, '$.cycleId') AS cycleId
FROM posts
WHERE status = 'pending_approval'
ORDER BY created_at DESC;
-- Activity Log
/*
No generation is queued or pending to kick off. force-cycle is synchronous — it ran the full scheduler tick inline and returned 200 before your curl completed. 
  It's not a "schedule for later" call; it's "run the cycle right now and tell me when it's done."
  What actually happened depends on whether you had pending posts at the time. 
  Based on the earlier discussion, you likely did — the Group 6/7 tests created test posts in pending_approval status.
  If so, the scheduler saw them, logged scheduler_waiting, and exited without generating anything.
Check what happened:
*/
SELECT id, action, timestamp, details
FROM activity_log
WHERE details LIKE '%cybersecurity-incidents%'
ORDER BY id DESC
LIMIT 10;


select count(*) AS posts from posts;
select count(*) AS activity_log from activity_log;
select count(*) AS agent_state from agent_state;
select count(*) AS sqlite_sequence from sqlite_sequence;
select count(*) AS articles from articles;

.header on
.mode column
sqlite3  data/agent.db ".header on" ".mode column" "SELECT id, status, created_at, posted_at, scheduled_for FROM posts ORDER BY id DESC LIMIT 10;"
PRAGMA table_info('posts');
PRAGMA table_info('activity_log');
PRAGMA table_info('agent_state');
PRAGMA table_info('sqlite_sequence');
PRAGMA table_info('articles');
SELECT sql FROM sqlite_schema WHERE name = 'table_name';
select id,topic_id,title,topic_id,hashtags,status,linkedin_id,created_at,scheduled_for,posted_at,error_message from posts;

tables=(posts activity_log agent_state sqlite_sequence articles)
for t in "${tables[@]}";do
sqlite3 data/agent.db ".header on" "select count(*) AS $t from $t;"
done
