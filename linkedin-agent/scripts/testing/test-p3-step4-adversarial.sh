#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 4 — API Route Protection ADVERSARIAL Tests
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
echo "  Phase 3 Step 4 — API Route Protection ADVERSARIAL Tests"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/routes/api.js" ]; then echo "  ERROR: src/routes/api.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi
echo -n "  jose dependency check: "
node --input-type=module -e "import 'jose'; console.log('installed');" 2>/dev/null
if [ $? -ne 0 ]; then echo "  ERROR: jose not installed. Run: npm install jose"; exit 1; fi

run_mjs "Groups 1+2+3: Hostile access" "$SCRIPT_DIR/test-p3-step4-adversarial/hostile-access.mjs"

echo "━━━━━━"
echo ""
echo "  ═══════════════════════════════════════"
echo "  Phase 3 Step 4 — API Route Protection ADVERSARIAL:"
echo "  Results:  ${TOTAL_PASS} PASSED  ${TOTAL_FAIL} FAILED"
echo "  ═══════════════════════════════════════"
echo ""
if [ "$TOTAL_FAIL" -gt 0 ]; then
  echo "  ⚠ ${TOTAL_FAIL} vulnerability/test failure(s)."
  if [ -s "$FAILURE_LOG" ]; then echo ""; echo "━━ Failure Report ━━"; echo ""; cat "$FAILURE_LOG"; echo "━━━━━━"; fi
else echo "  All adversarial tests passed."; fi
echo "━━━━━━"
echo ""; exit $TOTAL_FAIL
