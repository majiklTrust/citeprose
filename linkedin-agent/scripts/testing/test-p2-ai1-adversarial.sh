#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 2 AI-1/AI-3 — Pipeline Hardening ADVERSARIAL Test Suite
# ═══════════════════════════════════════════════════════════════
# Does NOT require the server — tests modules directly.
(
PASS=0; FAIL=0; RUN_ALL=
for i in "$@"; do case $i in --all) shift && RUN_ALL=YES;; esac; done
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 2 AI-1/AI-3 — Pipeline ADVERSARIAL Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

SCRIPT_DIR="scripts/testing/test-p2-ai1-adversarial"

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

run_group "injection-evasion.mjs" "Groups 1-3 (sanitization evasion + links + injection + filter bypass)" 24

echo ""
echo "  ═══════════════════════════════════════"
echo "  Phase 2 AI-1/AI-3 — Pipeline ADVERSARIAL:"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then echo "  ⚠ ${FAIL} vulnerability/test failure(s)."; else echo "  All adversarial tests passed."; fi
echo "━━━━━━"
echo ""; exit $FAIL
)
