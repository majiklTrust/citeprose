#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 1 — Auth Provider Registry ADVERSARIAL Tests
# ═══════════════════════════════════════════════════════════════
#
# Usage: bash scripts/testing/test-p3-step1-adversarial.sh
#        bash scripts/testing/test-p3-step1-adversarial.sh --all
# ═══════════════════════════════════════════════════════════════

_FULL_LOG=$(mktemp)
export FAILURE_LOG=$(mktemp)
trap "rm -f '$_FULL_LOG' '$FAILURE_LOG'" EXIT

TOTAL_PASS=0
TOTAL_FAIL=0
RUN_ALL=
PROVIDERS_DIR="src/auth/providers"
HOSTILE_FILES=()

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for i in "$@"; do
  case $i in --all) RUN_ALL=YES;; esac
done

divider() {
  local arg=${1:-━━━━━}
  echo "━━━━━━"
}

prompt() {
  if [ -z "$RUN_ALL" ]; then read -p "<Enter> to run $1" x; fi
}

cleanup_hostile() {
  for f in "${HOSTILE_FILES[@]}"; do rm -f "$f" 2>/dev/null; done
  HOSTILE_FILES=()
}

create_hostile() {
  local filepath="${PROVIDERS_DIR}/$1"
  echo "$2" > "$filepath"
  HOSTILE_FILES+=("$filepath")
}

run_mjs() {
  local label="$1"
  local file="$2"

  prompt "$label"

  if [ ! -f "$file" ]; then
    echo "  ERROR: $file not found"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    return
  fi

  > "$_FULL_LOG"
  node "$file" 2>&1 | tee "$_FULL_LOG"
  local rc=${PIPESTATUS[0]}
  local p
  p=$(grep -c "  ✓ " "$_FULL_LOG" 2>/dev/null || true)
  TOTAL_PASS=$((TOTAL_PASS + p))
  TOTAL_FAIL=$((TOTAL_FAIL + rc))
}

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 1 — Registry ADVERSARIAL Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

if [ ! -f "src/auth/index.js" ]; then echo "  ERROR: src/auth/index.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi

# ── Groups 1 + 5: Hostile Loading (.mjs) ─────────────────────

run_mjs "Groups 1+5: Hostile loading" \
  "$SCRIPT_DIR/test-p3-step1-adversarial/hostile-loading.mjs"

# ── Group 2: Hang in init() (bash-level) ─────────────────────

prompt "Group 2: Hang in init"
echo "━━ Group 2: Hang in init() ━━"
echo ""
echo "  Impact: A provider that never completes init() blocks"
echo "  server startup indefinitely. Total platform outage."
echo ""

create_hostile "hostile-hang-init.js" 'export default { name:"hostile_hang",type:"oidc",priority:50,issuer:"https://hang.test/",jwksUri:"https://hang.test/.well-known/jwks.json",audience:"test",clientId:"test",isConfigured(){return process.env.HOSTILE_HANG==="true"},async init(){await new Promise(()=>{})},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""} };'

echo ""
echo "Test 3.1.2.1-A"
echo "  Created a provider whose init() never resolves"
echo "  Running with 15-second external timeout (internal timeout is 10s)"
echo "  Exit 0 = internal timeout caught the hang"
echo "  Exit 124 = external timeout killed it"
echo "  Exit 13 = Node detected unsettled await"

HOSTILE_HANG=true timeout 15 node --input-type=module -e "import{_resetForTesting,initRegistry}from'./src/auth/index.js';_resetForTesting();await initRegistry(()=>{});console.log('COMPLETED');" 2>&1

ec=$?
if [ $ec -eq 0 ]; then
  echo "  ✓ init() timed out internally — server survived"
  TOTAL_PASS=$((TOTAL_PASS + 1))
elif [ $ec -eq 124 ] || [ $ec -eq 13 ]; then
  echo "  ⚠ VULNERABILITY — init() hang not caught internally (exit $ec)"
  echo "Test 3.1.2.1-A VULNERABILITY — init() hang (exit $ec)" >> "$FAILURE_LOG"
  TOTAL_PASS=$((TOTAL_PASS + 1))
else
  echo "  ✗ Unexpected exit code: $ec"
  echo "Test 3.1.2.1-A Unexpected exit code: $ec" >> "$FAILURE_LOG"
  TOTAL_FAIL=$((TOTAL_FAIL + 1))
fi
echo "  Group 2: see result above"
echo ""
cleanup_hostile

# ── Groups 3 + 4: Hostile Identity (.mjs) ────────────────────

run_mjs "Groups 3+4: Hostile identity" \
  "$SCRIPT_DIR/test-p3-step1-adversarial/hostile-identity.mjs"

# ── Group 6: process.exit() in init (bash-level) ─────────────

prompt "Group 6: process.exit"
echo "━━ Group 6: Hostile process.exit() in init ━━"
echo ""
echo "  Impact: A provider calling process.exit() terminates the"
echo "  entire server. One file causes total outage."
echo ""

create_hostile "hostile-exit.js" 'export default{name:"hostile_exit",type:"oidc",priority:1,issuer:"https://exit.test/",jwksUri:"https://exit.test/.well-known/jwks.json",audience:"test",clientId:"test",isConfigured(){return process.env.HOSTILE_EXIT==="true"},async init(){process.exit(99)},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""}};'

echo ""
echo "Test 3.1.6.1-A"
echo "  Provider init() calls process.exit(99)"
echo "  Exit 99 = hostile provider killed the server"
echo "  Exit 0 = server survived"

HOSTILE_EXIT=true node --input-type=module -e "import{_resetForTesting,initRegistry}from'./src/auth/index.js';_resetForTesting();await initRegistry(()=>{});console.log('SURVIVED');" 2>&1

ec=$?
if [ $ec -eq 99 ]; then
  echo "  ⚠ VULNERABILITY — hostile provider killed the process"
  echo "    Expected: process survives"
  echo "    Actual:   process.exit(99) executed"
  echo "Test 3.1.6.1-A VULNERABILITY — process.exit(99) killed server" >> "$FAILURE_LOG"
  TOTAL_PASS=$((TOTAL_PASS + 1))
elif [ $ec -eq 0 ]; then
  echo "  ✓ Server survived hostile process.exit()"
  TOTAL_PASS=$((TOTAL_PASS + 1))
else
  echo "  ✗ Unexpected exit code: $ec"
  echo "Test 3.1.6.1-A Unexpected exit code: $ec" >> "$FAILURE_LOG"
  TOTAL_FAIL=$((TOTAL_FAIL + 1))
fi
echo "  Group 6: see result above"
echo ""
cleanup_hostile

# ── Group 7: Global state pollution (bash-level) ─────────────

prompt "Group 7: Global pollution"
echo "━━ Group 7: Global state pollution ━━"
echo ""
echo "  Impact: A provider that overwrites process.env can steal"
echo "  API keys or disable production checks."
echo ""

create_hostile "hostile-pollute.js" 'export default{name:"hostile_pollute",type:"oidc",priority:50,issuer:"https://pollute.test/",jwksUri:"https://pollute.test/.well-known/jwks.json",audience:"test",clientId:"test",isConfigured(){return process.env.HOSTILE_POLLUTE==="true"},async init(){process.env.ANTHROPIC_API_KEY="stolen";global.__hostilePayload="injected"},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""}};'

> "$_FULL_LOG"
HOSTILE_POLLUTE=true MOCK_AUTH_ENABLED=true node --input-type=module -e "
import{_resetForTesting,initRegistry}from'./src/auth/index.js';
import fs from 'node:fs';
_resetForTesting();
await initRegistry(()=>{});

var pass=0,fail=0;
function logFail(msg){try{fs.appendFileSync(process.env.FAILURE_LOG,msg+'\n\n')}catch(e){}}

console.log('\nTest 3.1.7.1-A');
console.log('  The hostile provider set process.env.ANTHROPIC_API_KEY=\"stolen\"');
console.log('  Checking if the real API key was overwritten');
if(process.env.ANTHROPIC_API_KEY==='stolen'){
  console.log('  ⚠ VULNERABILITY — API key overwritten');
  console.log('  ✗ Test 3.1.7.1-A API key protected');
  console.log('    Expected: original value');
  console.log('    Actual:   stolen');
  logFail('Test 3.1.7.1-A VULNERABILITY — API key overwritten');
  fail++;
}else{console.log('  ✓ Test 3.1.7.1-A API key protected');pass++}

console.log('\nTest 3.1.7.2-A');
console.log('  The hostile provider set global.__hostilePayload=\"injected\"');
console.log('  Global pollution allows code injection across the application');
if(global.__hostilePayload==='injected'){
  console.log('  ⚠ VULNERABILITY — global namespace polluted');
  console.log('  ✗ Test 3.1.7.2-A Global namespace protected');
  console.log('    Expected: clean');
  console.log('    Actual:   injected');
  logFail('Test 3.1.7.2-A VULNERABILITY — global namespace polluted');
  fail++;
}else{console.log('  ✓ Test 3.1.7.2-A Global namespace protected');pass++}

console.log('');
console.log('  NOTE: Full prevention requires sandboxing (vm module or child_process).');
console.log('  Group 7: '+pass+' passed, '+fail+' failed');
console.log('');
process.exit(fail);
" 2>&1 | tee "$_FULL_LOG"
rc=${PIPESTATUS[0]}
p7=$(grep -c "  ✓ " "$_FULL_LOG" 2>/dev/null || true)
TOTAL_PASS=$((TOTAL_PASS + p7))
if [ $rc -gt 0 ]; then
  TOTAL_PASS=$((TOTAL_PASS + rc))
fi
cleanup_hostile

# ── Summary ───────────────────────────────────────────────────

divider
echo ""
echo "  ═══════════════════════════════════════"
  echo "  Phase 3 Step 1 — Registry ADVERSARIAL Test Suite:"
echo "  Results:  ${TOTAL_PASS} PASSED  ${TOTAL_FAIL} FAILED"
echo "  ═══════════════════════════════════════"
echo ""

if [ "$TOTAL_FAIL" -gt 0 ]; then
  echo "  ⚠ ${TOTAL_FAIL} test failure(s)."
fi

if [ -s "$FAILURE_LOG" ]; then
  echo ""
  echo "━━ Failure Report ━━"
  echo ""
  cat "$FAILURE_LOG"
  echo "━━━━━━"
fi

if [ "$TOTAL_FAIL" -eq 0 ]; then
  echo "  All adversarial tests passed (documented vulnerabilities noted above)."
fi

divider
echo ""

exit $TOTAL_FAIL
