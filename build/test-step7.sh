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
(
function yesno { read -p "$1 yes (default) or no: " && if [[ ${REPLY,,} = n ]] || [[ ${REPLY,,} = no ]]; then return 9; fi; return 0; }
divider() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# run_test GROUP TEST_NUM DESCRIPTION EXPECTED_HTTP_CODE CURL_ARGS...
run_test() {
  local group="$1"
  local test_num="$2"
  local description="$3"
  local expected_code="$4"
  shift 4

  echo ""
  echo "  Test ${group}.${test_num} — ${description}"

  local response
  echo "\$ curl -s -w "\n%{http_code}" "$@""
  response=$(curl -s -w "\n%{http_code}" "$@")
  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  echo -e "\t Expected HTTP: ${expected_code}"
  echo -e "\t Actual HTTP:   ${http_code}"
  echo -e "\t Body:          $(echo "$body" | head -c 500)"

  if [[ "$http_code" == "$expected_code" ]]; then
    echo "  ✓ PASS"
    PASS=$((PASS + 1))
  else
    echo "  ✗ FAIL (expected ${expected_code}, got ${http_code})"
    FAIL=$((FAIL + 1))
  fi
}

skip_test() {
  local group="$1"
  local test_num="$2"
  local description="$3"
  echo ""
  echo "  Test ${group}.${test_num} — ${description}"
  echo "  ⊘ SKIPPED (triggers Anthropic API call — run with --include-api)"
  SKIP=$((SKIP + 1))
}

# run_check GROUP TEST_NUM DESCRIPTION CHECK_DESC COMMAND
# For tests that verify counts/lengths rather than HTTP codes
run_check() {
  local group="$1"
  local test_num="$2"
  local description="$3"
  local check_description="$4"
  shift 4

  echo ""
  echo "  Test ${group}.${test_num} — ${description}"
  echo "  Check: ${check_description}"
  echo -n "  Result: "

  local result
  result=$(eval "$@" 2>&1)
  echo "$result"

  if echo "$result" | grep -q "PASS"; then
    PASS=$((PASS + 1))
  elif echo "$result" | grep -q "FAIL"; then
    FAIL=$((FAIL + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
# Group 1: parseId — Post ID validation
# ═══════════════════════════════════════════════════════════════

function test_group_1 {
divider
echo "  Group 1: parseId — Post ID validation"
divider

run_test 1 1 "Non-numeric string" 400 \
  "$API/api/posts/not_a_number"

run_test 1 2 "Mixed numeric string (123abc)" 400 \
  "$API/api/posts/123abc"

run_test 1 3 "Zero" 400 \
  "$API/api/posts/0"

run_test 1 4 "Negative number" 400 \
  "$API/api/posts/-5"

run_test 1 5 "Extremely large number (9999999)" 400 \
  "$API/api/posts/9999999"

run_test 1 6 "Valid ID format (may or may not exist)" 404 \
  "$API/api/posts/3555"

run_test 1 7 "Decimal number (3.14)" 400 \
  "$API/api/posts/3.14"

run_test 1 8 "Non-numeric on approve route" 400 \
  -X POST "$API/api/posts/not_a_number/approve" \
  -H "Content-Type: application/json"

run_test 1 9 "Non-numeric on reject route" 400 \
  -X POST "$API/api/posts/not_a_number/reject" \
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

run_test 2 1 "Invalid topic (SQL injection attempt)" 400 \
  -X POST "$API/api/generate-preview" \
  -H "Content-Type: application/json" \
  -d '{"topicId":"DROP TABLE posts"}'

run_test 2 5 "Close-but-wrong topic (typo: ai-guardrail)" 400 \
  -X POST "$API/api/generate-preview" \
  -H "Content-Type: application/json" \
  -d '{"topicId":"ai-guardrail"}'

run_test 2 6 "Invalid topic on save-preview" 400 \
  -X POST "$API/api/save-preview" \
  -H "Content-Type: application/json" \
  -d '{"topicId":"fake-topic","title":"Test","content":"Test content"}'

run_test 2 7 "Invalid topic on research/articles" 400 \
  "$API/api/research/articles?topic=injection-attack"

run_test 2 8 "Valid topic on research/articles" 200 \
  "$API/api/research/articles?topic=ai-guardrails"
}

function test_group_2_api {
if [ "$INCLUDE_API" = true ]; then
  if yesno "run test_group_2_2api?";then test_group_2_2api;fi
  if yesno "run test_group_2_3api?";then test_group_2_3api;fi
  if yesno "run test_group_2_4api?";then test_group_2_4api;fi
else
  skip_test 2 2-api "Empty string topic (auto-select)"
  skip_test 2 3-api "Null topic via force-cycle (auto-select)"
  skip_test 2 4-api "Valid topic via force-cycle"
fi
}
function test_group_2_2api {
  URL="$API/api/generate-preview"
  run_test 2 2-api "$URL Empty string topic (auto-select)" 200 \
    -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d '{"topicId":""}'
}
function test_group_2_3api {
  URL="$API/api/force-cycle"
  run_test 2 3-api "$URL Null topic via force-cycle (auto-select)" 200 \
    -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d '{}'
}
function test_group_2_4api {
  URL="$API/api/force-cycle"
  run_test 2 4-api "$URL Valid topic via force-cycle" 200 \
    -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d '{"topicId":"cybersecurity-incidents"}'
}
# ═══════════════════════════════════════════════════════════════
# Group 3: isValidStatus — Status allowlist
# ═══════════════════════════════════════════════════════════════

function test_group_3 {
divider
echo "  Group 3: isValidStatus — Status allowlist"
divider

run_test 3 1 "SQL injection in status" 400 \
  "$API/api/posts?status=posted%20OR%201=1"

run_test 3 2 "Valid status (pending_approval)" 200 \
  "$API/api/posts?status=pending_approval"

run_test 3 3 "No status (returns all posts)" 200 \
  "$API/api/posts"

echo ""
echo "  Test 3.4 — Each valid status accepted"
echo "  Expected: HTTP 200 for all five"
ALL_PASS=true
for s in posted rejected failed approved pending_approval; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/posts?status=$s")
  if [[ "$code" == "200" ]]; then
    echo "    $s: $code ✓"
  else
    echo "    $s: $code ✗"
    ALL_PASS=false
  fi
done
if [ "$ALL_PASS" = true ]; then
  echo "  ✓ PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL"
  FAIL=$((FAIL + 1))
fi
}

# ═══════════════════════════════════════════════════════════════
# Group 4: isValidMode — Mode allowlist
# ═══════════════════════════════════════════════════════════════

function test_group_4 {
divider
echo "  Group 4: isValidMode — Mode allowlist"
divider

run_test 4 1 "Invalid mode" 400 \
  -X POST "$API/api/mode" \
  -H "Content-Type: application/json" \
  -d '{"mode":"chaos"}'

run_test 4 2 "Valid mode (manual)" 200 \
  -X POST "$API/api/mode" \
  -H "Content-Type: application/json" \
  -d '{"mode":"manual"}'

run_test 4 3 "Missing mode field" 400 \
  -X POST "$API/api/mode" \
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

run_check 5 1 "Posts limit clamped to max 200" "count <= 200" \
  "curl -s '$API/api/posts?limit=999999' | python3 -c \"
import json, sys
posts = json.load(sys.stdin)['posts']
n = len(posts)
print(f'{n} posts returned — {\"PASS\" if n <= 200 else \"FAIL\"}')
\""

run_check 5 2 "Logs limit clamped to max 500" "count <= 500" \
  "curl -s '$API/api/logs?limit=999999' | python3 -c \"
import json, sys
logs = json.load(sys.stdin)['logs']
n = len(logs)
print(f'{n} logs returned — {\"PASS\" if n <= 500 else \"FAIL\"}')
\""

run_check 5 3 "Negative limit clamped to minimum" "count == 1" \
  "curl -s '$API/api/logs?limit=-5' | python3 -c \"
import json, sys
logs = json.load(sys.stdin)['logs']
n = len(logs)
print(f'{n} logs returned — {\"PASS\" if n == 1 else \"FAIL\"}')
\""

run_check 5 4 "Non-numeric limit falls back to default" "count <= 100" \
  "curl -s '$API/api/logs?limit=abc' | python3 -c \"
import json, sys
logs = json.load(sys.stdin)['logs']
n = len(logs)
print(f'{n} logs returned — {\"PASS\" if n <= 100 else \"FAIL\"}')
\""

run_check 5 5 "Research articles maxAge clamped to 90" "HTTP 200" \
  "code=\$(curl -s -o /dev/null -w '%{http_code}' '$API/api/research/articles?topic=ai-guardrails&maxAge=9999')
echo \"HTTP \$code — \$( [ \"\$code\" = \"200\" ] && echo PASS || echo FAIL )\""

run_check 5 6 "Research articles limit clamped to 100" "count <= 100" \
  "curl -s '$API/api/research/articles?topic=ai-guardrails&limit=500' | python3 -c \"
import json, sys
a = json.load(sys.stdin)['articles']
n = len(a)
print(f'{n} articles returned — {\"PASS\" if n <= 100 else \"FAIL\"}')
\""
}

# ═══════════════════════════════════════════════════════════════
# Group 6: sanitizeString — Length bounding
# ═══════════════════════════════════════════════════════════════

function test_group_6 {
divider
echo "  Group 6: sanitizeString — Length bounding"
divider

run_test 6 1 "Reject with 600-char reason (post 1 — may not exist)" 500 \
  -X POST "$API/api/posts/1/reject" \
  -H "Content-Type: application/json" \
  -d "{\"reason\":\"$(python3 -c "print('A'*600)")\"}"

echo -n "  Log check: "
curl -s "$API/api/logs?limit=5" | python3 -c "
import json, sys
logs = json.load(sys.stdin)['logs']
found = False
for l in logs:
    if 'reject' in l['action']:
        d = json.loads(l['details'])
        reason = d.get('reason','')
        n = len(reason)
        result = 'PASS' if n <= 500 else 'FAIL'
        print(f'Reason length: {n} — {result}')
        found = True
        break
if not found:
    print('No reject entry in recent logs (post may not exist — expected)')
" 2>/dev/null || echo "ERROR"

run_test 6 2 "Save-preview with 300-char title" 200 \
  -X POST "$API/api/save-preview" \
  -H "Content-Type: application/json" \
  -d "{\"topicId\":\"ai-guardrails\",\"title\":\"$(python3 -c "print('T'*300)")\",\"content\":\"Test content body\"}"

echo -n "  Log check: "
curl -s "$API/api/logs?limit=5" | python3 -c "
import json, sys
logs = json.load(sys.stdin)['logs']
found = False
for l in logs:
    if 'preview_saved' in l['action']:
        d = json.loads(l['details'])
        title = d.get('title','')
        n = len(title)
        result = 'PASS' if n <= 200 else 'FAIL'
        print(f'Title length: {n} — {result}')
        found = True
        break
if not found:
    print('No preview_saved entry found in recent logs')
" 2>/dev/null || echo "ERROR"

run_test 6 3 "Save-preview with 6000-char content" 200 \
  -X POST "$API/api/save-preview" \
  -H "Content-Type: application/json" \
  -d "{\"topicId\":\"ai-guardrails\",\"title\":\"Test title\",\"content\":\"$(python3 -c "print('C'*6000)")\"}"
}

# ═══════════════════════════════════════════════════════════════
# Group 7: Array limiting
# ═══════════════════════════════════════════════════════════════

function test_group_7 {
divider
echo "  Group 7: Array limiting"
divider

run_test 7 1 "Save-preview with 25 hashtags" 200 \
  -X POST "$API/api/save-preview" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "import json; print(json.dumps({'topicId':'ai-guardrails','title':'Test','content':'Test content','hashtags':['#tag'+str(i) for i in range(25)]}))")"

run_test 7 2 "Save-preview with non-array hashtags" 200 \
  -X POST "$API/api/save-preview" \
  -H "Content-Type: application/json" \
  -d '{"topicId":"ai-guardrails","title":"Test","content":"Body","hashtags":"not an array"}'
}

function test_group_fail {
  run_test "" fail "Expected failure" XXX \
  "$API/api/status"

}
function pre_flight {
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
  return 1
fi
}

function do_summary {

divider
echo ""
echo "  ═══════════════════════════════════════"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED  ${SKIP} SKIPPED"
echo "  ═══════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "  ⚠ ${FAIL} test(s) failed. Review output above."
elif [ "$INCLUDE_API" = false ]; then
  echo "  All executed tests passed. ${SKIP} tests skipped (use --include-api)."
else
  echo "  All tests passed."
fi

divider
echo ""

return $FAIL

}

# function run_tests {
# RUN_ALL=${1:-}
# if [ -n "$API_ONLY" ];then
#   test_group_2_api
# elif [ -z "$RUN_ALL" ];then
# read -p "<Enter> to run group 1" x && test_group_1
# read -p "<Enter> to run group 2" x && test_group_2
# read -p "<Enter> to run group 2-api" x && test_group_2_api
# read -p "<Enter> to run group 3" x && test_group_3
# read -p "<Enter> to run group 4" x && test_group_4
# read -p "<Enter> to run group 5" x && test_group_5
# read -p "<Enter> to run group 6" x && test_group_6
# read -p "<Enter> to run group 7" x && test_group_7
# read -p "<Enter> to run group fail" x && test_group_fail
# else
# test_group_1
# test_group_2
# test_group_2_api
# test_group_3
# test_group_4
# test_group_5
# test_group_6
# test_group_7
# test_group_fail
# fi
# }
######## MAIN

API="http://localhost:3001"
INCLUDE_API=false
RUN_ALL=
API_ONLY=
PASS=0
FAIL=0
SKIP=0


for i in "$@";do
case $i in
--include-api)
  shift && INCLUDE_API=true
  ;;
--api-only)
  shift && API_ONLY=true && INCLUDE_API=true
  ;;
--all)
  shift && RUN_ALL=YES
  ;;
esac
done

echo "
INCLUDE_API $INCLUDE_API
API_ONLY    $API_ONLY
RUN_ALL     $RUN_ALL
"

if [ pre_flight ];then

if [ "$INCLUDE_API" = true ]; then
  echo "  API tests: ENABLED (will consume Anthropic credits)"
else
  echo "  API tests: SKIPPED (use --include-api to enable)"
fi
## test
if [ -n "$API_ONLY" ];then
  test_group_2_api
elif [ -z "$RUN_ALL" ];then
read -p "<Enter> to run group 1" x && test_group_1
read -p "<Enter> to run group 2" x && test_group_2
# read -p "<Enter> to run group 2-api" x && test_group_2_api
read -p "<Enter> to run group 2.2api" x && test_group_2_2api
read -p "<Enter> to run group 2.3api" x && test_group_2_3api
read -p "<Enter> to run group 2.4api" x && test_group_2_4api
read -p "<Enter> to run group 3" x && test_group_3
read -p "<Enter> to run group 4" x && test_group_4
read -p "<Enter> to run group 5" x && test_group_5
read -p "<Enter> to run group 6" x && test_group_6
read -p "<Enter> to run group 7" x && test_group_7
read -p "<Enter> to run group fail" x && test_group_fail
else
test_group_1
test_group_2
test_group_2_api
test_group_3
test_group_4
test_group_5
test_group_6
test_group_7
test_group_fail
fi
##
# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════
do_summary
fi

)