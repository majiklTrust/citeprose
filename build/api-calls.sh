# The status route calls four things in sequence: getPostStats(), canPostNow(), validateToken(), and getArticleStats(). Test them individually:
curl -s http://localhost:3001/api/status | python3 -m json.tool
node -e "
  import('./src/services/database.js').then(db => {
    db.initDatabase();
    try { console.log('getPostStats:', JSON.stringify(db.getPostStats())); }
    catch(e) { console.log('getPostStats FAILED:', e.message); }
  });
"
node -e "
  import('./src/services/database.js').then(db => {
    db.initDatabase();
    import('./src/services/scheduler.js').then(s => {
      try { console.log('canPostNow:', JSON.stringify(s.canPostNow())); }
      catch(e) { console.log('canPostNow FAILED:', e.message); }
    });
  });
"
node -e "
  import('./src/services/database.js').then(db => {
    db.initDatabase();
    import('./src/services/scheduler.js').then(s => {
      try { console.log(JSON.stringify(s.canPostNow())); }
      catch(e) { console.log(e.stack); }
    });
  });
"

# This tells you exactly how many posts count against the window and whether the scheduler thinks you can post.
curl -s http://localhost:3001/api/status | node -e "
  const d=require('fs').readFileSync('/dev/stdin','utf8');
  const j=JSON.parse(d);
  console.log('Posts last 10 days:', j.stats.postsLast10Days);
  console.log('Cadence allowed:', j.cadence.allowed);
  console.log('Cadence reason:', j.cadence.reason || 'ready');
"

Test 2.2 — /api/generate-preview
# curl -s -w n%{http_code} -X POST http://localhost:3001/api/generate-preview -H Content-Type: application/json -d {"topicId":""}
This is preview-only. The execution path is:
api.js: POST /api/generate-preview
  → content-generator.js: generatePost(topicId)
    → research.js: conductResearch() — web search + optional corroboration
    → content-generator.js: builds prompt, calls Claude, returns JSON
  → content-generator.js: qualityCheck()
  → api.js: res.json({ post, quality })
The post is returned in the HTTP response body and nothing is saved to the database. It's designed for the dashboard's Preview modal — you see it, review it, then either click "Queue for Approval" (which calls /api/save-preview to persist it) or "Discard" (which throws it away). Since you ran this via curl, the post content was printed to your terminal and is now gone. No post on the dashboard — that's correct behavior.
Tests 2.3 and 2.4 — /api/force-cycle
This triggers the full scheduler pipeline:
api.js: POST /api/force-cycle
  → scheduler.js: forceCycle(topicId)
    → scheduler.js: schedulerTick(topicId)
      → content-generator.js: generatePost()
        → research.js: conductResearch()
      → content-generator.js: qualityCheck()
      → database.js: createPost() — SAVES to database
      → If mode=manual: updatePostStatus("pending_approval")
      → If mode=auto: executePost() → linkedin-api.js: publishPost()
These do save to the database. If your mode is manual, the posts should appear in the "Awaiting Approval" section of the dashboard. If they're not showing, check two things:
bashcurl -s http://localhost:3001/api/posts?status=pending_approval | python3 -c "
import json, sys
posts = json.load(sys.stdin)['posts']
print(f'{len(posts)} pending posts')
for p in posts[:5]:
    print(f'  #{p[\"id\"]} {p[\"title\"][:60]}')
"
If that shows posts, they're in the database but the dashboard may need a refresh. If it shows 0, the posts may have been blocked due to insufficient sources — check the activity log for post_blocked entries with the same timestamp.

