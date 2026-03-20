#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Step 7 — Input Validation Test Runner
# ═══════════════════════════════════════════════════════════════
#
# Usage: bash scripts/test-step7.sh
#
# Requires: server running at localhost:3001
#
# WARNING: Tests 2.2, 2.3, 2.4 trigger Anthropic API calls.
#          They are SKIPPED by default.
#          Run with --include-api to enable them.
# ═══════════════════════════════════════════════════════════════

divider() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

run_test() {
  local group="$1"
  local test_num="$2"
  local description="$3"
  local expected="$4"
  shift 4

  echo ""
  echo "  Test ${group}.${test_num} — ${description}"
  echo "  Expected: ${expected}"
  echo -n "  Result:   "

  local result
  result=$("$@" 2>&1)
  echo "$result"
}

skip_test() {
  local group="$1"
  local test_num="$2"
  local description="$3"
  echo ""
  echo "  Test ${group}.${test_num} — ${description}"
  echo "  SKIPPED (triggers Anthropic API call — run with --include-api)"
  SKIP=$((SKIP + 1))
}
# ═══════════════════════════════════════════════════════════════
# Group 1: parseId — Post ID validation
# ═══════════════════════════════════════════════════════════════

function test_group_1 {
divider
echo "  Group 1: parseId — Post ID validation"
divider

run_test 1 1 "Non-numeric string" \
  '{"error": "Invalid post ID."}' \
  curl -s "$API/api/posts/not_a_number"

run_test 1 2 "Mixed numeric string (123abc)" \
  '{"error": "Invalid post ID."}' \
  curl -s "$API/api/posts/123abc"

run_test 1 3 "Zero" \
  '{"error": "Invalid post ID."}' \
  curl -s "$API/api/posts/0"

run_test 1 4 "Negative number" \
  '{"error": "Invalid post ID."}' \
  curl -s "$API/api/posts/-5"

run_test 1 5 "Extremely large number (9999999)" \
  '{"error": "Invalid post ID."}' \
  curl -s "$API/api/posts/9999999"

run_test 1 6 "Valid ID format (may or may not exist)" \
  'Post JSON or {"error": "Post not found."} — no 400' \
  curl -s "$API/api/posts/3555"

run_test 1 7 "Decimal number (3.14)" \
  '{"error": "Invalid post ID."}' \
  curl -s "$API/api/posts/3.14"

run_test 1 8 "Non-numeric on approve route" \
  '{"error": "Invalid post ID."}' \
  curl -s -X POST "$API/api/posts/not_a_number/approve" \
    -H "Content-Type: application/json"

run_test 1 9 "Non-numeric on reject route" \
  '{"error": "Invalid post ID."}' \
  curl -s -X POST "$API/api/posts/not_a_number/reject" \
    -H "Content-Type: application/json" \
    -d '{"reason":"test"}'
}
# ═══════════════════════════════════════════════════════════════
# Group 2: isValidTopicId — Topic allowlist
# ═══════════════════════════════════════════════════════════════

function test_group_2 {
divider
echo "  Group 2: isValidTopicId — Topic allowlist"
divider

run_test 2 1 "Invalid topic (SQL injection attempt)" \
  '{"error": "Invalid topic ID."}' \
  curl -s -X POST "$API/api/generate-preview" \
    -H "Content-Type: application/json" \
    -d '{"topicId":"DROP TABLE posts"}'

if [ "$INCLUDE_API" = true ]; then
  run_test 2 2 "Empty string topic (auto-select)" \
    "Normal response (auto-select, triggers API call)" \
    curl -s -X POST "$API/api/generate-preview" \
      -H "Content-Type: application/json" \
      -d '{"topicId":""}'

  run_test 2 3 "Null topic via force-cycle (auto-select)" \
    '{"success": true, "message": "Scheduler cycle executed."}' \
    curl -s -X POST "$API/api/force-cycle" \
      -H "Content-Type: application/json" \
      -d '{}'

  run_test 2 4 "Valid topic via force-cycle" \
    '{"success": true, ...}' \
    curl -s -X POST "$API/api/force-cycle" \
      -H "Content-Type: application/json" \
      -d '{"topicId":"cybersecurity-incidents"}'
else
  skip_test 2 2 "Empty string topic (auto-select)"
  skip_test 2 3 "Null topic via force-cycle (auto-select)"
  skip_test 2 4 "Valid topic via force-cycle"
fi

run_test 2 5 "Close-but-wrong topic (typo: ai-guardrail)" \
  '{"error": "Invalid topic ID."}' \
  curl -s -X POST "$API/api/generate-preview" \
    -H "Content-Type: application/json" \
    -d '{"topicId":"ai-guardrail"}'

run_test 2 6 "Invalid topic on save-preview" \
  '{"error": "Invalid topic ID."}' \
  curl -s -X POST "$API/api/save-preview" \
    -H "Content-Type: application/json" \
    -d '{"topicId":"fake-topic","title":"Test","content":"Test content"}'

run_test 2 7 "Invalid topic on research/articles" \
  '{"error": "Invalid topic ID."}' \
  curl -s "$API/api/research/articles?topic=injection-attack"

run_test 2 8 "Valid topic on research/articles" \
  '{"articles": [...]}' \
  curl -s "$API/api/research/articles?topic=ai-guardrails"
}
# ═══════════════════════════════════════════════════════════════
# Group 3: isValidStatus — Status allowlist
# ═══════════════════════════════════════════════════════════════

function test_group_3 {
divider
echo "  Group 3: isValidStatus — Status allowlist"
divider

run_test 3 1 "SQL injection in status" \
  '{"error": "Invalid status parameter."}' \
  curl -s "$API/api/posts?status=posted%20OR%201=1"

run_test 3 2 "Valid status (pending_approval)" \
  '{"posts": [...]}' \
  curl -s "$API/api/posts?status=pending_approval"

run_test 3 3 "No status (returns all posts)" \
  '{"posts": [...]} — no error' \
  curl -s "$API/api/posts"

echo ""
echo "  Test 3.4 — Each valid status accepted"
echo "  Expected: a count for each — no errors"
echo "  Result:"
for s in posted rejected failed approved pending_approval; do
  echo -n "    $s: "
  curl -s "$API/api/posts?status=$s" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{len(d[\"posts\"])} posts')" 2>/dev/null || echo "ERROR"
done
}
# ═══════════════════════════════════════════════════════════════
# Group 4: isValidMode — Mode allowlist
# ═══════════════════════════════════════════════════════════════

function test_group_4 {
divider
echo "  Group 4: isValidMode — Mode allowlist"
divider

run_test 4 1 "Invalid mode" \
  '{"error": "Mode must be '\''auto'\'' or '\''manual'\''."} ' \
  curl -s -X POST "$API/api/mode" \
    -H "Content-Type: application/json" \
    -d '{"mode":"chaos"}'

run_test 4 2 "Valid mode (manual)" \
  '{"mode": "manual"}' \
  curl -s -X POST "$API/api/mode" \
    -H "Content-Type: application/json" \
    -d '{"mode":"manual"}'

run_test 4 3 "Missing mode field" \
  '{"error": "Mode must be '\''auto'\'' or '\''manual'\''."} ' \
  curl -s -X POST "$API/api/mode" \
    -H "Content-Type: application/json" \
    -d '{}'
}
# ═══════════════════════════════════════════════════════════════
# Group 5: sanitizeInt — Range clamping
# ═══════════════════════════════════════════════════════════════

function test_group_5 {
divider
echo "  Group 5: sanitizeInt — Range clamping"
divider

echo ""
echo "  Test 5.1 — Posts limit clamped to max 200"
echo "  Expected: at most 200 posts"
echo -n "  Result:   "
curl -s "$API/api/posts?limit=999999" | python3 -c "
import json, sys
posts = json.load(sys.stdin)['posts']
print(f'{len(posts)} posts returned (max should be 200)')
" 2>/dev/null || echo "ERROR"

echo ""
echo "  Test 5.2 — Logs limit clamped to max 500"
echo "  Expected: at most 500 entries"
echo -n "  Result:   "
curl -s "$API/api/logs?limit=999999" | python3 -c "
import json, sys
logs = json.load(sys.stdin)['logs']
print(f'{len(logs)} logs returned (max should be 500)')
" 2>/dev/null || echo "ERROR"

echo ""
echo "  Test 5.3 — Negative limit clamped to minimum"
echo "  Expected: exactly 1 entry"
echo -n "  Result:   "
curl -s "$API/api/logs?limit=-5" | python3 -c "
import json, sys
logs = json.load(sys.stdin)['logs']
print(f'{len(logs)} logs returned (min should be 1)')
" 2>/dev/null || echo "ERROR"

echo ""
echo "  Test 5.4 — Non-numeric limit falls back to default"
echo "  Expected: up to 100 entries (default)"
echo -n "  Result:   "
curl -s "$API/api/logs?limit=abc" | python3 -c "
import json, sys
logs = json.load(sys.stdin)['logs']
print(f'{len(logs)} logs returned (default should be 100)')
" 2>/dev/null || echo "ERROR"

echo ""
echo "  Test 5.5 — Research articles maxAge clamped to 90"
echo "  Expected: normal response, no error"
echo -n "  Result:   "
curl -s "$API/api/research/articles?topic=ai-guardrails&maxAge=9999" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'error' in d:
    print(f'ERROR: {d[\"error\"]}')
else:
    print(f'{len(d[\"articles\"])} articles returned (maxAge silently clamped to 90)')
" 2>/dev/null || echo "ERROR"

echo ""
echo "  Test 5.6 — Research articles limit clamped to 100"
echo "  Expected: at most 100 articles"
echo -n "  Result:   "
curl -s "$API/api/research/articles?topic=ai-guardrails&limit=500" | python3 -c "
import json, sys
articles = json.load(sys.stdin)['articles']
print(f'{len(articles)} articles returned (max should be 100)')
" 2>/dev/null || echo "ERROR"
}
# ═══════════════════════════════════════════════════════════════
# Group 6: sanitizeString — Length bounding
# ═══════════════════════════════════════════════════════════════

function test_group_6 {
divider
echo "  Group 6: sanitizeString — Length bounding"
divider

echo ""
echo "  Test 6.1 — Reject reason truncated at 500 chars"
echo "  Expected: success or invalid ID, then check log for reason length <= 500"
echo -n "  Result:   "
python3 -c "import json; print(json.dumps({'reason': 'A' * 600}))" | \
  curl -s -X POST "$API/api/posts/1/reject" \
    -H "Content-Type: application/json" \
    -d @-
echo ""
echo -n "  Log check: "
curl -s "$API/api/logs?limit=5" | python3 -c "
import json, sys
logs = json.load(sys.stdin)['logs']
found = False
for l in logs:
    if 'reject' in l['action']:
        d = json.loads(l['details'])
        reason = d.get('reason','')
        print(f'Reason length: {len(reason)} (should be <= 500)')
        found = True
        break
if not found:
    print('No reject entry found in recent logs')
" 2>/dev/null || echo "ERROR"

echo ""
echo "  Test 6.2 — Save-preview title truncated at 200 chars"
echo "  Expected: success, then check log for title length <= 200"
echo -n "  Result:   "
python3 -c "
import json
print(json.dumps({
    'topicId': 'ai-guardrails',
    'title': 'T' * 300,
    'content': 'Test content body'
}))" | curl -s -X POST "$API/api/save-preview" \
    -H "Content-Type: application/json" \
    -d @-
echo ""
echo -n "  Log check: "
curl -s "$API/api/logs?limit=5" | python3 -c "
import json, sys
logs = json.load(sys.stdin)['logs']
found = False
for l in logs:
    if 'preview_saved' in l['action']:
        d = json.loads(l['details'])
        title = d.get('title','')
        print(f'Title length: {len(title)} (should be <= 200)')
        found = True
        break
if not found:
    print('No preview_saved entry found in recent logs')
" 2>/dev/null || echo "ERROR"

echo ""
echo "  Test 6.3 — Content truncated at 5000 chars"
echo "  Expected: success (content silently clamped to 5000)"
echo -n "  Result:   "
python3 -c "
import json
print(json.dumps({
    'topicId': 'ai-guardrails',
    'title': 'Test title',
    'content': 'C' * 6000
}))" | curl -s -X POST "$API/api/save-preview" \
    -H "Content-Type: application/json" \
    -d @-
echo ""
}
# ═══════════════════════════════════════════════════════════════
# Group 7: Array limiting
# ═══════════════════════════════════════════════════════════════

function test_group_7 {
divider
echo "  Group 7: Array limiting"
divider

echo ""
echo "  Test 7.1 — Hashtags clamped to 10"
echo "  Expected: success (25 hashtags silently reduced to 10)"
echo -n "  Result:   "
python3 -c "
import json
print(json.dumps({
    'topicId': 'ai-guardrails',
    'title': 'Test',
    'content': 'Test content',
    'hashtags': ['#tag' + str(i) for i in range(25)]
}))" | curl -s -X POST "$API/api/save-preview" \
    -H "Content-Type: application/json" \
    -d @-
echo ""

echo ""
echo "  Test 7.2 — Non-array hashtags handled gracefully"
echo "  Expected: success (string replaced with empty array, no crash)"
echo -n "  Result:   "
curl -s -X POST "$API/api/save-preview" \
  -H "Content-Type: application/json" \
  -d '{"topicId":"ai-guardrails","title":"Test","content":"Body","hashtags":"not an array"}'
echo ""
}


API="http://localhost:3001"
INCLUDE_API=false
PASS=0
FAIL=0
SKIP=0

if [[ "$1" == "--include-api" ]]; then
  INCLUDE_API=true
fi

# ── Preflight check ──────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Step 7 — Input Validation Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo -n "  Server check: "
if curl -s --max-time 3 "$API/api/status" > /dev/null 2>&1; then
  echo "OK — server is running"
else
  echo "FAILED — server not reachable at $API"
  echo "  Start the server first, then re-run this script."
  exit 1
fi

if [ "$INCLUDE_API" = true ]; then
  echo "  API tests: ENABLED (will consume Anthropic credits)"
else
  echo "  API tests: SKIPPED (use --include-api to enable)"
fi
## test
read -p "<Enter> to run group 1" x && test_group_1
read -p "<Enter> to run group 2" x && test_group_2
read -p "<Enter> to run group 3" x && test_group_3
read -p "<Enter> to run group 4" x && test_group_4
read -p "<Enter> to run group 5" x && test_group_5
read -p "<Enter> to run group 6" x && test_group_6
read -p "<Enter> to run group 7" x && test_group_7
##
# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════

divider
echo "  Test run complete."
if [ "$INCLUDE_API" = false ]; then
  echo "  Tests 2.2, 2.3, 2.4 were skipped (use --include-api to enable)"
fi
echo "  Review output above and compare with expected values."
divider
echo ""
