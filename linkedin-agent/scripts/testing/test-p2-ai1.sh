#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 2 AI-1/AI-3 — Pipeline Hardening Test Suite
# ═══════════════════════════════════════════════════════════════
# Does NOT require the server — tests modules directly.
(
PASS=0; FAIL=0; RUN_ALL=
for i in "$@"; do case $i in --all) shift && RUN_ALL=YES;; esac; done
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 2 AI-1/AI-3 — Pipeline Hardening Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

SCRIPT_DIR="scripts/testing/test-p2-ai1"

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

run_group "sanitize-and-framing.mjs" "Groups 1-3 (RSS sanitization + links + prompt injection + framing)" 36
run_group "output-filter.mjs" "Groups 4-5 (secret detection + prompt leak + exfiltration)" 16

echo ""
echo "  ═══════════════════════════════════════"
echo "  Phase 2 AI-1/AI-3 — Pipeline Hardening:"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then echo "  ⚠ ${FAIL} test(s) failed."; else echo "  All functional tests passed."; fi
echo "━━━━━━"
echo ""; exit $FAIL
)
