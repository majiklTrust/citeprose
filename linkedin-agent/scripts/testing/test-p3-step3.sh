#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 3 — JWT Verification + Auth Middleware Test Suite
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
echo "  Phase 3 Step 3 — JWT Verification + Middleware Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/jwt-verifier.js" ]; then echo "  ERROR: src/auth/jwt-verifier.js not found."; exit 1; fi
if [ ! -f "src/auth/middleware.js" ]; then echo "  ERROR: src/auth/middleware.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi
echo -n "  jose dependency check: "
node --input-type=module -e "import 'jose'; console.log('installed');" 2>/dev/null
if [ $? -ne 0 ]; then echo "  ERROR: jose not installed. Run: npm install jose"; exit 1; fi

run_mjs "Groups 1+2: JWT verifier" "$SCRIPT_DIR/test-p3-step3/jwt-verifier.mjs"
run_mjs "Groups 3+4+5: Middleware auth" "$SCRIPT_DIR/test-p3-step3/middleware-auth.mjs"
run_mjs "Group 6: Safety checks" "$SCRIPT_DIR/test-p3-step3/safety-checks.mjs"

# ── Group 7: jose isolation (bash-level grep) ─────────────────

prompt "Group 7: jose isolation"
echo "━━ Group 7: jose library isolation ━━"
echo ""
echo "  Impact: If jose is imported in multiple files, replacing"
echo "  it with hand-coded crypto requires editing every file —"
echo "  multiplying regression risk."
echo ""

jose_in_verifier=$(grep -c "from ['\"]jose['\"]" src/auth/jwt-verifier.js)
jose_in_middleware=$(grep -c "from ['\"]jose['\"]" src/auth/middleware.js)
jose_in_registry=$(grep -c "from ['\"]jose['\"]" src/auth/index.js)
jose_in_auth0=$(grep -c "from ['\"]jose['\"]" src/auth/providers/auth0.js)
jose_in_mock=$(grep -c "from ['\"]jose['\"]" src/auth/providers/mock.js)

echo "Test 3.3.7.1"
echo "  Searching jwt-verifier.js for jose import — should be the single import point"
if [ "$jose_in_verifier" -ge 1 ]; then echo "  ✓ Test 3.3.7.1 jwt-verifier.js is single jose import"; TOTAL_PASS=$((TOTAL_PASS+1))
else echo "  ✗ Test 3.3.7.1 jwt-verifier.js does not import jose"; echo "    Expected: ≥1"; echo "    Actual:   0"; echo "Test 3.3.7.1 jwt-verifier.js missing jose import" >> "$FAILURE_LOG"; TOTAL_FAIL=$((TOTAL_FAIL+1)); fi

echo ""
echo "Test 3.3.7.2"
echo "  Searching middleware.js — must NOT import jose directly"
if [ "$jose_in_middleware" -eq 0 ]; then echo "  ✓ Test 3.3.7.2 middleware.js does not import jose"; TOTAL_PASS=$((TOTAL_PASS+1))
else echo "  ✗ Test 3.3.7.2 middleware.js imports jose"; echo "    Expected: 0"; echo "    Actual:   $jose_in_middleware"; echo "Test 3.3.7.2 middleware.js imports jose" >> "$FAILURE_LOG"; TOTAL_FAIL=$((TOTAL_FAIL+1)); fi

echo ""
echo "Test 3.3.7.3"
if [ "$jose_in_registry" -eq 0 ]; then echo "  ✓ Test 3.3.7.3 registry does not import jose"; TOTAL_PASS=$((TOTAL_PASS+1))
else echo "  ✗ Test 3.3.7.3 registry imports jose"; echo "Test 3.3.7.3 registry imports jose" >> "$FAILURE_LOG"; TOTAL_FAIL=$((TOTAL_FAIL+1)); fi

echo ""
echo "Test 3.3.7.4"
if [ "$jose_in_auth0" -eq 0 ]; then echo "  ✓ Test 3.3.7.4 Auth0 provider does not import jose"; TOTAL_PASS=$((TOTAL_PASS+1))
else echo "  ✗ Test 3.3.7.4 Auth0 provider imports jose"; echo "Test 3.3.7.4 Auth0 imports jose" >> "$FAILURE_LOG"; TOTAL_FAIL=$((TOTAL_FAIL+1)); fi

echo ""
echo "Test 3.3.7.5"
if [ "$jose_in_mock" -eq 0 ]; then echo "  ✓ Test 3.3.7.5 Mock provider does not import jose"; TOTAL_PASS=$((TOTAL_PASS+1))
else echo "  ✗ Test 3.3.7.5 Mock provider imports jose"; echo "Test 3.3.7.5 mock imports jose" >> "$FAILURE_LOG"; TOTAL_FAIL=$((TOTAL_FAIL+1)); fi

echo ""
echo "  Group 7: see results above"
echo ""

# ── Summary ───────────────────────────────────────────────────
echo "━━━━━━"
echo ""
echo "  ═══════════════════════════════════════"
  echo "  Phase 3 Step 3 — JWT Verification + Middleware Test Suite:"
echo "  Results:  ${TOTAL_PASS} PASSED  ${TOTAL_FAIL} FAILED"
echo "  ═══════════════════════════════════════"
echo ""
if [ "$TOTAL_FAIL" -gt 0 ]; then
  echo "  ⚠ ${TOTAL_FAIL} test(s) failed."
  if [ -s "$FAILURE_LOG" ]; then echo ""; echo "━━ Failure Report ━━"; echo ""; cat "$FAILURE_LOG"; echo "━━━━━━"; fi
else echo "  All tests passed."; fi
echo "━━━━━━"
echo ""; exit $TOTAL_FAIL
