BEGIN
SELECT set_config('app.current_tenant_id', '53f2e104-4192-439b-abdc-70954bfa9583', true);
-- Who did what today:
-- sql
SELECT timestamp, action, user_sub, details
FROM activity_log
WHERE tenant_id = '53f2e104-4192-439b-abdc-70954bfa9583'
  AND timestamp > now() - interval '24 hours'
ORDER BY timestamp DESC;
COMMIT

-- All actions by a specific user:
-- sql
SELECT timestamp, action, details
FROM activity_log
WHERE user_sub = '***REMOVED***'
ORDER BY timestamp DESC
LIMIT 50;
-- Who approved or rejected posts:
-- sql
SELECT timestamp, action, user_sub,
       details->>'postId' AS post_id,
       details->>'reason' AS reason
FROM activity_log
WHERE action IN ('post_approved', 'post_rejected')
  AND tenant_id = '53f2e104-4192-439b-abdc-70954bfa9583'
ORDER BY timestamp DESC;
-- System actions vs user actions:
-- sql
SELECT
  CASE WHEN user_sub IS NULL THEN 'system' ELSE 'user' END AS actor,
  action,
  count(*) AS occurrences
FROM activity_log
WHERE tenant_id = '53f2e104-4192-439b-abdc-70954bfa9583'
GROUP BY 1, 2
ORDER BY 1, 3 DESC;
-- Who changed operational settings:
-- sql
SELECT timestamp, user_sub, action, details
FROM activity_log
WHERE action IN ('corroboration_toggled', 'force_cycle', 'post_edited')
  AND user_sub IS NOT NULL
ORDER BY timestamp DESC;
-- Accountability question — "who published that post?":
-- sql
SELECT al.timestamp, al.user_sub, al.action,
       al.details->>'postId' AS post_id,
       p.title
FROM activity_log al
LEFT JOIN posts p ON p.id = (al.details->>'postId')::int
WHERE al.action = 'post_approved'
  AND al.tenant_id = '53f2e104-4192-439b-abdc-70954bfa9583'
ORDER BY al.timestamp DESC;
