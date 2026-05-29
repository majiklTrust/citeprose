
----- DATABASE SEQUENCING ERROR CHECKING
-- tables with serial columns
SELECT table_name, column_name,
       pg_get_serial_sequence(table_name, column_name) AS sequence_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND identity_generation IS NOT NULL
   OR column_default LIKE 'nextval%'
ORDER BY table_name;

-- fix sequences - all at once
SELECT t.table_name,
       t.seq_name,
       (SELECT last_value FROM pg_sequences WHERE schemaname = 'public' AND sequencename = t.seq_name) AS seq_val,
       t.max_id
FROM (
  -- SELECT 'activity_log' AS table_name, 'activity_log_id_seq' AS seq_name, (SELECT MAX(id) FROM activity_log) AS max_id
  -- SELECT 'articles_v2' AS table_name, 'articles_v2_id_seq' AS seq_name, (SELECT MAX(id) FROM articles_v2) AS max_id
  -- SELECT 'feed_articles' AS table_name, 'feed_articles_id_seq' AS seq_name, (SELECT MAX(id) FROM feed_articles) AS max_id
  -- SELECT 'feed_topics' AS table_name, 'feed_topics_id_seq' AS seq_name, (SELECT MAX(id) FROM feed_topics) AS max_id
  -- SELECT 'feeds_v2' AS table_name, 'feeds_v2_id_seq' AS seq_name, (SELECT MAX(id) FROM feeds_v2) AS max_id
  -- SELECT 'posts' AS table_name, 'posts_id_seq' AS seq_name, (SELECT MAX(id) FROM posts) AS max_id
  -- SELECT 'topics' AS table_name, 'topics_id_seq' AS seq_name, (SELECT MAX(id) FROM topics) AS max_id
  -- add rows from the first query's results
) t;

-- fix sequences
SELECT setval(
  pg_get_serial_sequence('activity_log', 'id'),
  COALESCE((SELECT MAX(id) FROM activity_log), 0) + 1,
  false
);
-- fix sequences
SELECT setval(
  pg_get_serial_sequence('posts', 'id'),
  COALESCE((SELECT MAX(id) FROM posts), 0) + 1,
  false
);
-- fix sequences
SELECT setval(
  pg_get_serial_sequence('articles_v2', 'id'),
  COALESCE((SELECT MAX(id) FROM articles_v2), 0) + 1,
  false
);
-- fix sequences
SELECT setval(
  pg_get_serial_sequence('feeds_v2', 'id'),
  COALESCE((SELECT MAX(id) FROM feeds_v2), 0) + 1,
  false
);
-- fix sequences
SELECT setval(
  pg_get_serial_sequence('topics', 'id'),
  COALESCE((SELECT MAX(id) FROM topics), 0) + 1,
  false
);
-- fix sequences
SELECT setval(
  pg_get_serial_sequence('feed_articles', 'id'),
  COALESCE((SELECT MAX(id) FROM feed_articles), 0) + 1,
  false
);
-- fix sequences
SELECT setval(
  pg_get_serial_sequence('feed_topics', 'id'),
  COALESCE((SELECT MAX(id) FROM feed_topics), 0) + 1,
  false
);

-- Check all identity sequences vs actual max values
SELECT 'activity_log' AS tbl,
       (SELECT MAX(id) FROM activity_log) AS max_id,
       (SELECT last_value FROM activity_log_id_seq) AS seq_val
UNION ALL
SELECT 'posts',
       (SELECT MAX(id) FROM posts),
       (SELECT last_value FROM posts_id_seq)
UNION ALL
SELECT 'articles_v2',
       (SELECT MAX(id) FROM articles_v2),
       (SELECT last_value FROM articles_v2_id_seq);
UNION ALL
SELECT 'feed_articles' AS tbl,
       (SELECT MAX(id) FROM feed_articles) AS max_id,
       (SELECT last_value FROM feed_articles_id_seq) AS seq_val
UNION ALL
SELECT 'feed_topics',
       (SELECT MAX(id) FROM feed_topics),
       (SELECT last_value FROM feed_topics_id_seq)
UNION ALL
SELECT 'feeds_v2',
       (SELECT MAX(id) FROM feeds_v2),
       (SELECT last_value FROM feeds_v2_id_seq);
UNION ALL
SELECT 'topics',
       (SELECT MAX(id) FROM topics),
       (SELECT last_value FROM topics_id_seq);

