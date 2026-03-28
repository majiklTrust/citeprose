#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 5 — Session Architecture & Design Test Suite
# ═══════════════════════════════════════════════════════════════
(
PASS=0; FAIL=0; RUN_ALL=
for i in "$@"; do case $i in --all) shift && RUN_ALL=YES;; esac; done
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 5 — Session Architecture & Design"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/session.js" ]; then echo "  ERROR: src/auth/session.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi

SCRIPT_DIR="scripts/testing/test-p3-step5-design"

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

run_group "session-module-design.mjs" "Groups 1-2 (exports + imports)" 18
run_group "session-crypto-design.mjs" "Groups 3-4 (crypto + cookie flags)" 15

echo ""
echo "  ═══════════════════════════════════════"
echo "  Phase 3 Step 5 — Session Architecture & Design:"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then echo "  ⚠ ${FAIL} test(s) failed."; else echo "  All design tests passed."; fi
echo "━━━━━━"
echo ""; exit $FAIL
)
