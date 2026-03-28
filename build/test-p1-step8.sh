#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Step 8 — Diagnostic Silencing + Extra Headers Test Runner
# ═══════════════════════════════════════════════════════════════
#
# Usage: bash scripts/test-step8.sh
#        bash scripts/test-step8.sh --all          (skip prompts)
#
# Requires: server running at localhost:3001
#
# Groups 1-2: Automated header checks against running server
# Group 3:    HSTS conditional — requires restart with NODE_ENV
# Group 4:    Diagnostic silencing — requires restart with bad config
# ═══════════════════════════════════════════════════════════════
(
function yesno { read -p "$1 yes (default) or no: " && if [[ ${REPLY,,} = n ]] || [[ ${REPLY,,} = no ]]; then return 9; fi; return 0; }
divider() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# run_header_present GROUP TEST_NUM DESCRIPTION HEADER_NAME EXPECTED_VALUE URL
# Checks that a header exists in the response and optionally matches a value
run_header_present() {
  local group="$1"
  local test_num="$2"
  local description="$3"
  local header_name="$4"
  local expected_value="$5"
  local url="$6"

  echo ""
  echo "  Test ${group}.${test_num} — ${description}"
  echo "  Header: ${header_name}"

  local headers
  headers=$(curl -s -I "$url" 2>&1)
  local header_line
  header_line=$(echo "$headers" | grep -i "^${header_name}:" | head -1)

  if [ -z "$header_line" ]; then
    echo "  Expected: present"
    echo "  Actual:   MISSING"
    echo "  ✗ FAIL"
    FAIL=$((FAIL + 1))
    return
  fi

  local actual_value
  actual_value=$(echo "$header_line" | sed "s/^[^:]*: *//" | tr -d '\r')

  echo "  Expected: ${expected_value}"
  echo "  Actual:   ${actual_value}"

  if [[ "$actual_value" == *"$expected_value"* ]]; then
    echo "  ✓ PASS"
    PASS=$((PASS + 1))
  else
    echo "  ✗ FAIL (value mismatch)"
    FAIL=$((FAIL + 1))
  fi
}

# run_header_absent GROUP TEST_NUM DESCRIPTION HEADER_NAME URL
# Checks that a header does NOT exist in the response
run_header_absent() {
  local group="$1"
  local test_num="$2"
  local description="$3"
  local header_name="$4"
  local url="$5"

  echo ""
  echo "  Test ${group}.${test_num} — ${description}"
  echo "  Header: ${header_name}"

  local headers
  headers=$(curl -s -I "$url" 2>&1)
  local header_line
  header_line=$(echo "$headers" | grep -i "^${header_name}:" | head -1)

  if [ -z "$header_line" ]; then
    echo "  Expected: absent"
    echo "  Actual:   absent"
    echo "  ✓ PASS"
    PASS=$((PASS + 1))
  else
    local actual_value
    actual_value=$(echo "$header_line" | tr -d '\r')
    echo "  Expected: absent"
    echo "  Actual:   ${actual_value}"
    echo "  ✗ FAIL (header should not be present)"
    FAIL=$((FAIL + 1))
  fi
}

# ═══════════════════════════════════════════════════════════════
# Group 1: Security headers present
# ═══════════════════════════════════════════════════════════════

function test_group_1 {
divider
echo "  Group 1: Security headers present"
divider

local URL="$API/api/status"

echo ""
echo "  Fetching headers from: $URL"
echo "  ─────────────────────────────────────"
curl -s -I "$URL" | grep -v "^Date:\|^Connection:\|^Keep-Alive:" | sed 's/^/  /'
echo "  ─────────────────────────────────────"

run_header_present 1 1 "X-Content-Type-Options" \
  "X-Content-Type-Options" "nosniff" "$URL"

run_header_present 1 2 "X-Frame-Options" \
  "X-Frame-Options" "DENY" "$URL"

run_header_present 1 3 "X-XSS-Protection" \
  "X-XSS-Protection" "0" "$URL"

run_header_present 1 4 "Referrer-Policy" \
  "Referrer-Policy" "strict-origin-when-cross-origin" "$URL"

run_header_present 1 5 "Content-Security-Policy" \
  "Content-Security-Policy" "default-src 'self'" "$URL"

run_header_present 1 6 "Permissions-Policy" \
  "Permissions-Policy" "camera=(), microphone=(), geolocation=(), interest-cohort=()" "$URL"

run_header_present 1 7 "X-DNS-Prefetch-Control" \
  "X-DNS-Prefetch-Control" "off" "$URL"

run_header_present 1 8 "X-Permitted-Cross-Domain-Policies" \
  "X-Permitted-Cross-Domain-Policies" "none" "$URL"
}

# ═══════════════════════════════════════════════════════════════
# Group 2: Information disclosure headers removed
# ═══════════════════════════════════════════════════════════════

function test_group_2 {
divider
echo "  Group 2: Information disclosure headers removed"
divider

local URL="$API/api/status"

run_header_absent 2 1 "X-Powered-By removed" \
  "X-Powered-By" "$URL"

run_header_absent 2 2 "ETag removed" \
  "ETag" "$URL"
}

# ═══════════════════════════════════════════════════════════════
# Group 3: Headers on multiple endpoints
# ═══════════════════════════════════════════════════════════════

function test_group_3 {
divider
echo "  Group 3: Headers consistent across endpoints"
divider

echo ""
echo "  Verifying headers are set globally, not just on /api/status"

run_header_present 3 1 "Security headers on /api/posts" \
  "X-Frame-Options" "DENY" "$API/api/posts"

run_header_present 3 2 "Security headers on /api/logs" \
  "X-Content-Type-Options" "nosniff" "$API/api/logs"

run_header_present 3 3 "Security headers on static file (dashboard)" \
  "X-Frame-Options" "DENY" "$API/"

run_header_absent 3 4 "X-Powered-By absent on /api/posts" \
  "X-Powered-By" "$API/api/posts"

run_header_absent 3 5 "X-Powered-By absent on static file (dashboard)" \
  "X-Powered-By" "$API/"

run_header_absent 3 6 "ETag absent on /api/posts" \
  "ETag" "$API/api/posts"
}

# ═══════════════════════════════════════════════════════════════
# Group 4: HSTS conditional on NODE_ENV
# ═══════════════════════════════════════════════════════════════

function test_group_4 {
divider
echo "  Group 4: HSTS conditional on NODE_ENV"
divider

local URL="$API/api/status"

echo ""
echo "  Test 4.1 — HSTS absent in development mode"
echo "  (Server should be running WITHOUT NODE_ENV=production)"

run_header_absent 4 1 "HSTS absent in dev mode" \
  "Strict-Transport-Security" "$URL"

echo ""
echo "  ─────────────────────────────────────────────────────"
echo "  Tests 4.2 requires a server restart."
echo ""
echo "  To test HSTS in production mode:"
echo "    1. Stop the server"
echo "    2. Run: NODE_ENV=production npm run start"
echo "    3. Then run this test group again"
echo "    4. Test 4.1 will FAIL (expected) and 4.2 will PASS"
echo "    5. Stop and restart normally when done"
echo "  ─────────────────────────────────────────────────────"

if yesno "Is server running with NODE_ENV=production?"; then
  run_header_present 4 2 "HSTS present in production mode" \
    "Strict-Transport-Security" "max-age=31536000; includeSubDomains" "$URL"
else
  echo ""
  echo "  Test 4.2 — HSTS present in production mode"
  echo "  ⊘ SKIPPED (server not in production mode)"
  SKIP=$((SKIP + 1))
fi
}

# ═══════════════════════════════════════════════════════════════
# Group 5: Diagnostic silencing — bad decryption
# ═══════════════════════════════════════════════════════════════

function test_group_5 {
divider
echo "  Group 5: Diagnostic silencing — decryption failure"
divider

echo ""
echo "  This group requires starting the server with a wrong secret."
echo "  The server will fail to start — that's the test."
echo ""
echo "  ─────────────────────────────────────────────────────"
echo "  Steps:"
echo "    1. Stop the running server"
echo "    2. Run: ENCRYPTION_SECRET=wrong npm run start"
echo "    3. Capture the console output"
echo "    4. Answer the questions below"
echo "  ─────────────────────────────────────────────────────"

if ! yesno "Have you run the bad-secret startup and captured output?"; then
  echo ""
  echo "  ⊘ SKIPPED (run bad-secret startup first)"
  SKIP=$((SKIP + 5))
  return
fi

echo ""
echo "  Test 5.1 — Output contains generic failure message"
echo "  Expected: [FATAL] API key decryption failed. Run: node scripts/verify-key.js"
if yesno "  Does the output contain the generic message above?"; then
  echo "  ✓ PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "  Test 5.2 — Output does NOT contain .env file path"
echo "  Check for: any path like /home/..., /Users/..., or .env"
if yesno "  Is the .env path absent from the output?"; then
  echo "  ✓ PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL (path disclosed)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "  Test 5.3 — Output does NOT contain variable names or lengths"
echo "  Check for: ENCRYPTION_SECRET, ENCRYPTION_SALT, ANTHROPIC_API_KEY_ENCRYPTED"
echo "  Check for: 'set (XX chars)' or 'NOT SET'"
if yesno "  Are variable names and lengths absent from the output?"; then
  echo "  ✓ PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL (secrets metadata disclosed)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "  Test 5.4 — Output does NOT contain the word 'Diagnostic'"
if yesno "  Is the word 'Diagnostic' absent from the output?"; then
  echo "  ✓ PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL (diagnostic block present)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "  Test 5.5 — Output does NOT contain err.message or stack trace"
echo "  Check for: 'Unsupported state', 'bad decrypt', or any Error: line"
if yesno "  Are error details and stack traces absent from the output?"; then
  echo "  ✓ PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL (error details leaked)"
  FAIL=$((FAIL + 1))
fi
}

# ═══════════════════════════════════════════════════════════════
# Group 6: Diagnostic silencing — missing .env
# ═══════════════════════════════════════════════════════════════

function test_group_6 {
divider
echo "  Group 6: Diagnostic silencing — missing .env"
divider

echo ""
echo "  This group tests the dotenv warning when .env is missing."
echo ""
echo "  ─────────────────────────────────────────────────────"
echo "  Steps:"
echo "    1. Stop the running server"
echo "    2. Temporarily rename .env: mv .env .env.bak"
echo "    3. Run: npm run start (will fail — that's expected)"
echo "    4. Capture the console output"
echo "    5. Restore: mv .env.bak .env"
echo "  ─────────────────────────────────────────────────────"

if ! yesno "Have you run the missing-.env startup and captured output?"; then
  echo ""
  echo "  ⊘ SKIPPED (run missing-.env startup first)"
  SKIP=$((SKIP + 2))
  return
fi

echo ""
echo "  Test 6.1 — Warning message is generic"
echo "  Expected: [WARN] Could not load .env — falling back to OS environment variables."
if yesno "  Does the output contain the generic warning above?"; then
  echo "  ✓ PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "  Test 6.2 — Warning does NOT contain the full .env path"
echo "  Check for: absence of /home/.../linkedin-agent/.env or similar"
if yesno "  Is the full .env path absent from the warning?"; then
  echo "  ✓ PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL (path disclosed)"
  FAIL=$((FAIL + 1))
fi
}

# ═══════════════════════════════════════════════════════════════
# Group 7: Diagnostic silencing — startup crash
# ═══════════════════════════════════════════════════════════════

function test_group_7 {
divider
echo "  Group 7: Diagnostic silencing — startup crash"
divider

echo ""
echo "  This group tests the top-level catch when startup fails."
echo "  A missing .env with no OS environment variables triggers this."
echo ""
echo "  Expected console output:"
echo "    [WARN] Could not load .env — falling back to OS environment variables."
echo "    [FATAL] API key decryption failed. Run: node scripts/verify-key.js"
echo "    (process exits)"
echo ""
echo "  If you already captured output from Group 5 or 6, you can reuse it."

if ! yesno "Have you captured startup crash output?"; then
  echo ""
  echo "  ⊘ SKIPPED"
  SKIP=$((SKIP + 2))
  return
fi

echo ""
echo "  Test 7.1 — Crash message does NOT contain err.message"
echo "  The top-level catch should say: [FATAL] Startup failed."
echo "  NOT: [FATAL] Startup failed: <actual error message>"
if yesno "  Does the crash output say only '[FATAL] Startup failed.' with no error detail?"; then
  echo "  ✓ PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL (error message leaked in top-level catch)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "  Test 7.2 — Total console output is 3 lines or fewer"
echo "  Expected: [WARN]... + [FATAL]... + [OK]... or just [FATAL]..."
echo "  NOT: a multi-line diagnostic dump"
if yesno "  Is the total error output 3 lines or fewer?"; then
  echo "  ✓ PASS"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL (verbose output)"
  FAIL=$((FAIL + 1))
fi
}

# ═══════════════════════════════════════════════════════════════
# Group 8: CSP header detail verification
# ═══════════════════════════════════════════════════════════════

function test_group_8 {
divider
echo "  Group 8: Content-Security-Policy directive verification"
divider

local URL="$API/api/status"
local CSP
CSP=$(curl -s -I "$URL" | grep -i "^Content-Security-Policy:" | sed 's/^[^:]*: *//' | tr -d '\r')

echo ""
echo "  Full CSP: ${CSP}"
echo ""

local ALL_PASS=true

declare -A directives
directives=(
  ["default-src 'self'"]="default-src"
  ["script-src 'self'"]="script-src"
  ["style-src 'self' 'unsafe-inline'"]="style-src"
  ["connect-src 'self'"]="connect-src"
  ["img-src 'self' data:"]="img-src"
  ["font-src 'self'"]="font-src"
)

local test_num=1
for expected in "default-src 'self'" "script-src 'self'" "style-src 'self' 'unsafe-inline'" "connect-src 'self'" "img-src 'self' data:" "font-src 'self'"; do
  local directive_name
  directive_name=$(echo "$expected" | awk '{print $1}')
  echo -n "  Test 8.${test_num} — CSP contains ${directive_name}: "

  if echo "$CSP" | grep -q "$expected"; then
    echo "✓ PASS"
    PASS=$((PASS + 1))
  else
    echo "✗ FAIL (missing or wrong)"
    FAIL=$((FAIL + 1))
    ALL_PASS=false
  fi

  test_num=$((test_num + 1))
done

echo -n "  Test 8.${test_num} — CSP allows cdnjs.cloudflare.com: "
if echo "$CSP" | grep -q "https://cdnjs.cloudflare.com"; then
  echo "✓ PASS"
  PASS=$((PASS + 1))
else
  echo "✗ FAIL"
  FAIL=$((FAIL + 1))
fi

test_num=$((test_num + 1))
echo -n "  Test 8.${test_num} — CSP allows unpkg.com: "
if echo "$CSP" | grep -q "https://unpkg.com"; then
  echo "✓ PASS"
  PASS=$((PASS + 1))
else
  echo "✗ FAIL"
  FAIL=$((FAIL + 1))
fi
}

function pre_flight {
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Step 8 — Diagnostic Silencing + Extra Headers Test Suite"
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
else
  echo "  All executed tests passed."
fi

if [ "$SKIP" -gt 0 ]; then
  echo "  ${SKIP} tests skipped (require server restart — see Groups 4-7)."
fi

divider
echo ""

return $FAIL

}

######## MAIN

API="http://localhost:3001"
RUN_ALL=
PASS=0
FAIL=0
SKIP=0

for i in "$@";do
case $i in
--all)
  shift && RUN_ALL=YES
  ;;
esac
done

echo "
RUN_ALL     $RUN_ALL
"

if [ pre_flight ];then

## test
if [ -z "$RUN_ALL" ];then
read -p "<Enter> to run group 1 (headers present)" x && test_group_1
read -p "<Enter> to run group 2 (headers removed)" x && test_group_2
read -p "<Enter> to run group 3 (headers on multiple endpoints)" x && test_group_3
read -p "<Enter> to run group 4 (HSTS conditional)" x && test_group_4
read -p "<Enter> to run group 5 (diagnostic: bad secret)" x && test_group_5
read -p "<Enter> to run group 6 (diagnostic: missing .env)" x && test_group_6
read -p "<Enter> to run group 7 (diagnostic: startup crash)" x && test_group_7
read -p "<Enter> to run group 8 (CSP directives)" x && test_group_8
else
test_group_1
test_group_2
test_group_3
test_group_4
test_group_5
test_group_6
test_group_7
test_group_8
fi
##
# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════
do_summary
fi

)
