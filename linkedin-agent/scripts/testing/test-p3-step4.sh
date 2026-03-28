#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 4 — API Route Protection Test Suite
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
echo "  Phase 3 Step 4 — API Route Protection Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/routes/api.js" ]; then echo "  ERROR: src/routes/api.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi
echo -n "  jose dependency check: "
node --input-type=module -e "import 'jose'; console.log('installed');" 2>/dev/null
if [ $? -ne 0 ]; then echo "  ERROR: jose not installed. Run: npm install jose"; exit 1; fi

run_mjs "Group 8: Import safety (gate)" "$SCRIPT_DIR/test-p3-step4/import-safety.mjs"

# If import safety failed, warn but continue — other groups will fail with clear errors
if [ "$TOTAL_FAIL" -gt 0 ]; then
  echo ""
  echo "  ⚠ Import safety failed. Remaining groups may not run correctly."
  echo ""
fi

run_mjs "Groups 1+2: Protected read routes" "$SCRIPT_DIR/test-p3-step4/protected-read.mjs"
run_mjs "Groups 3+4: Protected write routes" "$SCRIPT_DIR/test-p3-step4/protected-write.mjs"
run_mjs "Group 5: Public routes" "$SCRIPT_DIR/test-p3-step4/public-routes.mjs"
run_mjs "Group 6: Dev mode passthrough" "$SCRIPT_DIR/test-p3-step4/dev-mode.mjs"
run_mjs "Group 7: User identity in handlers" "$SCRIPT_DIR/test-p3-step4/user-identity.mjs"

echo "━━━━━━"
echo ""
echo "  ═══════════════════════════════════════"
echo "  Phase 3 Step 4 — API Route Protection Test Suite:"
echo "  Results:  ${TOTAL_PASS} PASSED  ${TOTAL_FAIL} FAILED"
echo "  ═══════════════════════════════════════"
echo ""
if [ "$TOTAL_FAIL" -gt 0 ]; then
  echo "  ⚠ ${TOTAL_FAIL} test(s) failed."
  if [ -s "$FAILURE_LOG" ]; then echo ""; echo "━━ Failure Report ━━"; echo ""; cat "$FAILURE_LOG"; echo "━━━━━━"; fi
else echo "  All tests passed."; fi
echo "━━━━━━"
echo ""; exit $TOTAL_FAIL
