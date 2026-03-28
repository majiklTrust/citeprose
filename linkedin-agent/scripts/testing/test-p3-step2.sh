#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 2 — Auth0 OIDC Provider Test Suite
# ═══════════════════════════════════════════════════════════════
_FULL_LOG=$(mktemp)
export FAILURE_LOG=$(mktemp)
trap "rm -f '$_FULL_LOG' '$FAILURE_LOG'" EXIT
TOTAL_PASS=0; TOTAL_FAIL=0; RUN_ALL=
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for i in "$@"; do case $i in --all) RUN_ALL=YES;; esac; done
prompt() { if [ -z "$RUN_ALL" ]; then read -p "<Enter> to run $1" x; fi; }
run_mjs() {
  local label="$1" file="$2"
  prompt "$label"
  if [ ! -f "$file" ]; then echo "  ERROR: $file not found"; TOTAL_FAIL=$((TOTAL_FAIL+1)); return; fi
  > "$_FULL_LOG"
  node "$file" 2>&1 | tee "$_FULL_LOG"
  local rc=${PIPESTATUS[0]} p
  p=$(grep -c "  ✓ " "$_FULL_LOG" 2>/dev/null || true)
  TOTAL_PASS=$((TOTAL_PASS+p)); TOTAL_FAIL=$((TOTAL_FAIL+rc))
}
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 2 — Auth0 OIDC Provider Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/providers/auth0.js" ]; then echo "  ERROR: src/auth/providers/auth0.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi

run_mjs "Groups 1+2+6: Auth0 config" "$SCRIPT_DIR/test-p3-step2/auth0-config.mjs"
run_mjs "Groups 3+4+5: OAuth flow" "$SCRIPT_DIR/test-p3-step2/auth0-oauth-flow.mjs"
run_mjs "Groups 7+8: Integration" "$SCRIPT_DIR/test-p3-step2/auth0-integration.mjs"

echo "━━━━━━"
echo ""
echo "  ═══════════════════════════════════════"
  echo "  Phase 3 Step 2 — Auth0 OIDC Provider Test Suite:"
echo "  Results:  ${TOTAL_PASS} PASSED  ${TOTAL_FAIL} FAILED"
echo "  ═══════════════════════════════════════"
echo ""
if [ "$TOTAL_FAIL" -gt 0 ]; then
  echo "  ⚠ ${TOTAL_FAIL} test(s) failed."
  if [ -s "$FAILURE_LOG" ]; then echo ""; echo "━━ Failure Report ━━"; echo ""; cat "$FAILURE_LOG"; echo "━━━━━━"; fi
else echo "  All tests passed."; fi
echo "━━━━━━"
echo ""; exit $TOTAL_FAIL
