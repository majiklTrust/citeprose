#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 5 — Session ADVERSARIAL Test Suite
# ═══════════════════════════════════════════════════════════════
(
PASS=0; FAIL=0; RUN_ALL=
for i in "$@"; do case $i in --all) shift && RUN_ALL=YES;; esac; done
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 5 — Session ADVERSARIAL Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/session.js" ]; then echo "  ERROR: src/auth/session.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi

SCRIPT_DIR="scripts/testing/test-p3-step5-adversarial"

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

run_group "hostile-sessions.mjs" "Groups 1-2 (cookie tampering + encryption attacks)" 17

echo ""
echo "  ═══════════════════════════════════════"
echo "  Phase 3 Step 5 — Session ADVERSARIAL Test Suite:"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then echo "  ⚠ ${FAIL} vulnerability/test failure(s)."; else echo "  All adversarial tests passed."; fi
echo "━━━━━━"
echo ""; exit $FAIL
)
