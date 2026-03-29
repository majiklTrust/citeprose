#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 7 — Dashboard Auth Architecture & Design
# ═══════════════════════════════════════════════════════════════
# Does NOT require the server — reads source code only.
(
PASS=0; FAIL=0; RUN_ALL=
for i in "$@"; do case $i in --all) shift && RUN_ALL=YES;; esac; done
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 7 — Dashboard Auth Architecture & Design"
echo "═══════════════════════════════════════════════════════════"
echo ""

SCRIPT_DIR="scripts/testing/test-p3-step7-design"

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

run_group "auth-architecture.mjs" "Groups 1-3 (status fields + frontend + middleware)" 15

echo ""
echo "  ═══════════════════════════════════════"
echo "  Phase 3 Step 7 — Dashboard Auth Architecture & Design:"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then echo "  ⚠ ${FAIL} test(s) failed."; else echo "  All design tests passed."; fi
echo "━━━━━━"
echo ""; exit $FAIL
)
