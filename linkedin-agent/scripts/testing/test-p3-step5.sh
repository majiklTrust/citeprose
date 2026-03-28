#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 5 — Session Management Test Suite
# ═══════════════════════════════════════════════════════════════
(
PASS=0; FAIL=0; RUN_ALL=
for i in "$@"; do case $i in --all) shift && RUN_ALL=YES;; esac; done
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 5 — Session Management Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/session.js" ]; then echo "  ERROR: src/auth/session.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi

SCRIPT_DIR="scripts/testing/test-p3-step5"

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

run_group "session-create.mjs" "Group 1 (session creation)" 13
run_group "session-read.mjs" "Group 2 (session reading)" 13
run_group "session-expiry-clear.mjs" "Groups 3-4 (expiry + clearing)" 14
run_group "session-middleware.mjs" "Groups 5-6 (middleware + coexistence)" 13

echo ""
echo "  ═══════════════════════════════════════"
echo "  Phase 3 Step 5 — Session Management Test Suite:"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then echo "  ⚠ ${FAIL} test(s) failed."; else echo "  All tests passed."; fi
echo "━━━━━━"
echo ""; exit $FAIL
)
