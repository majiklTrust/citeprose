#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 7 — Dashboard Login Wall ADVERSARIAL Test Suite
# ═══════════════════════════════════════════════════════════════
# REQUIRES: Application server running at TEST_BASE_URL
(
PASS=0; FAIL=0; RUN_ALL=
for i in "$@"; do case $i in --all) shift && RUN_ALL=YES;; esac; done
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 7 — Dashboard ADVERSARIAL Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
BASE="${TEST_BASE_URL:-http://127.0.0.1:3001}"
echo "  Target: $BASE"
echo -n "  Server check: "
if curl -sf "$BASE/api/status" > /dev/null 2>&1; then
  echo "reachable"
else
  echo "UNREACHABLE — start the server first."
  exit 1
fi
echo ""

SCRIPT_DIR="scripts/testing/test-p3-step7-adversarial"

function run_group {
  local file=$1
  local label=$2
  local count=$3
  if [ -z "$RUN_ALL" ]; then read -p "<Enter> $label" x; fi
  node "$SCRIPT_DIR/$file" 2>&1
  local code=$?
  PASS=$((PASS + count - code))
  FAIL=$((FAIL + code))
}

run_group "hostile-bypass.mjs" "Groups 1-2 (bypass attacks + content leak)" 10

echo ""
echo "  ═══════════════════════════════════════"
echo "  Phase 3 Step 7 — Dashboard ADVERSARIAL:"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then echo "  ⚠ ${FAIL} vulnerability/test failure(s)."; else echo "  All adversarial tests passed."; fi
echo "━━━━━━"
echo ""; exit $FAIL
)
