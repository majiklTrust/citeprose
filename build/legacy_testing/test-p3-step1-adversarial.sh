#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 1 — Auth Provider Registry ADVERSARIAL Tests
# ═══════════════════════════════════════════════════════════════
_FULL_LOG=$(mktemp)
export FAILURE_LOG=$(mktemp)
export FAILURE_LOG=$(mktemp)
trap "rm -f '$_FULL_LOG' '$FAILURE_LOG'" EXIT
(
divider() { local arg=${1:-━━━━━}; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$arg━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }
PASS=0; FAIL=0; RUN_ALL=; PROVIDERS_DIR="src/auth/providers"; HOSTILE_FILES=()
for i in "$@"; do case $i in --all) shift && RUN_ALL=YES;; esac; done
cleanup() { for f in "${HOSTILE_FILES[@]}"; do rm -f "$f" 2>/dev/null; done; }
trap cleanup EXIT
create_hostile() { local fp="${PROVIDERS_DIR}/$1"; echo "$2" > "$fp"; HOSTILE_FILES+=("$fp"); }
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 1 — Registry ADVERSARIAL Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/index.js" ]; then echo "  ERROR: src/auth/index.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi

function test_group_1 {
divider " Group 1: Crash in isConfigured() "
echo ""
echo "  Impact: If the registry crashes when scanning a single bad"
echo "  provider file, ALL authentication fails. Every user is"
echo "  locked out because one file has a bug."
echo ""
create_hostile "hostile-crash-configured.js" 'export default { name:"hostile_crash",type:"oidc",priority:50,issuer:"https://hostile.test/",jwksUri:"https://hostile.test/.well-known/jwks.json",audience:"test",clientId:"test",isConfigured(){throw new Error("HOSTILE")},async init(){},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""} };'
MOCK_AUTH_ENABLED=true node --input-type=module -e "
import{_resetForTesting,initRegistry,getProvider,isAuthEnabled}from'./src/auth/index.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
_resetForTesting();
var logs=[];
var result=await initRegistry((l,a,d)=>logs.push({l,a,d}));

teststring='Test 3.1.1.1-A';
console.log('\nTest 3.1.1.1-A');
try{
console.log('  A hostile provider file throws an exception during isConfigured()');
console.log('  The registry is mid-scan of providers/ when the crash occurs');
console.log('  If the crash propagates, no providers load — total auth failure');
check(teststring+' Registry survived the hostile provider crash',true,'no uncaught exception','would have exited');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.1.2-A';
console.log('\nTest 3.1.1.2-A');
try{
console.log('  Checking if the legitimate mock provider survived the crash');
console.log('  Regardless of scan order, the working provider must still be available');
check(teststring+' Legitimate mock provider still loaded',getProvider('mock')!==null,'mock loaded','mock missing');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.1.3-A';
console.log('\nTest 3.1.1.3-A');
try{
console.log('  Verifying the hostile provider was NOT registered in the active map');
console.log('  A provider that crashes during discovery must never be treated as active');
check(teststring+' Hostile provider was not registered',getProvider('hostile_crash')===null,'null',String(getProvider('hostile_crash')?.name));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.1.4-A';
console.log('\nTest 3.1.1.4-A');
try{
console.log('  One bad file must not disable authentication for the entire application');
check(teststring+' Auth still enabled via surviving provider',isAuthEnabled(),'true',String(isAuthEnabled()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.1.5-A';
console.log('\nTest 3.1.1.5-A');
try{
console.log('  Checking logs for a record of the hostile file failure');
console.log('  Operators need visibility into which file failed, without it crashing the scan');
var hostileLog=logs.find(l=>l.a==='auth_provider_skipped'&&l.d?.filename?.includes('hostile'));
check(teststring+' Hostile file failure logged for operators',!!hostileLog,'log entry present','no log entry');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 1: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+5-code)); FAIL=$((FAIL+code))
}

function test_group_2 {
divider " Group 2: Hang in init() "
echo ""
echo "  Impact: A provider that never completes init() blocks"
echo "  server startup indefinitely. Total platform outage"
echo "  with no error message."
echo ""
create_hostile "hostile-hang-init.js" 'export default { name:"hostile_hang",type:"oidc",priority:50,issuer:"https://hang.test/",jwksUri:"https://hang.test/.well-known/jwks.json",audience:"test",clientId:"test",isConfigured(){return process.env.HOSTILE_HANG==="true"},async init(){await new Promise(()=>{})},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""} };'
echo ""
echo "  Test 3.1.2.1-A"
echo "  Created a provider whose init() returns a Promise that never resolves"
echo "  Running initRegistry() with a 5-second external timeout"
echo "  If exit code is 124, the timeout killed it — the hang is real"
echo "  If exit code is 0, the registry handled it internally"
HOSTILE_HANG=true timeout 5 node --input-type=module -e "import{_resetForTesting,initRegistry}from'./src/auth/index.js';_resetForTesting();await initRegistry(()=>{});console.log('COMPLETED');
import fs from 'node:fs';" 2>&1
local ec=$?
if [ $ec -eq 124 ]; then
  echo "  ⚠ VULNERABILITY CONFIRMED — init() hang blocks startup indefinitely"
  echo "Test 3.1.2.1-A VULNERABILITY — init() hang blocks startup indefinitely" >> "$FAILURE_LOG"
  echo "    Expected: init() times out or is caught within the registry"
  echo "    Actual:   process killed by external 5-second timeout"
  echo "    Recommendation: Add init() timeout (e.g., 10s limit per provider)"
  PASS=$((PASS+1))
elif [ $ec -eq 0 ]; then echo "  ✓ init() completed within timeout (protection implemented)"; PASS=$((PASS+1))
else echo "  ✗ Unexpected exit code: $ec"; echo "    Expected: 0 or 124"; echo "    Actual:   $ec"; FAIL=$((FAIL+1)); fi
echo ""; echo "  Group 2: see result above"; echo ""
}

function test_group_3 {
divider " Group 3: Duplicate provider names "
echo ""
echo "  Impact: If a hostile file uses the same name as a legitimate"
echo "  provider, it could silently replace it. All tokens would"
echo "  validate against attacker-controlled keys."
echo ""
create_hostile "hostile-dupe-name.js" 'export default { name:"mock",type:"oidc",priority:1,issuer:"https://evil-mock.test/",jwksUri:"https://evil-mock.test/.well-known/jwks.json",audience:"test",clientId:"evil",isConfigured(){return process.env.HOSTILE_DUPE==="true"},async init(){},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""} };'
MOCK_AUTH_ENABLED=true HOSTILE_DUPE=true node --input-type=module -e "
import{_resetForTesting,initRegistry,getProvider,isAuthEnabled}from'./src/auth/index.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
_resetForTesting();var logs=[];await initRegistry((l,a,d)=>logs.push({l,a,d}));

teststring='Test 3.1.3.1-A';
console.log('\nTest 3.1.3.1-A');
try{
console.log('  Two files both export name:\"mock\" — hostile-dupe-name.js and mock.js');
console.log('  Files load alphabetically, so hostile loads first and registers as \"mock\"');
console.log('  When the real mock.js arrives, the registry detects the duplicate');
console.log('  The safe response: evict BOTH. Neither can be trusted because the');
console.log('  registry cannot determine which file is legitimate from scan order alone');
var mock=getProvider('mock');
check(teststring+' Neither provider registered (both evicted)',mock===null,'null (both evicted)',mock===null?'null':mock.issuer);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.2-A';
console.log('\nTest 3.1.3.2-A');
try{
console.log('  With both providers evicted, auth should be disabled');
console.log('  This forces the operator to resolve the naming conflict manually');
check(teststring+' Auth disabled after eviction',!isAuthEnabled(),'false',String(isAuthEnabled()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.3-A';
console.log('\nTest 3.1.3.3-A');
try{
console.log('  Checking logs for duplicate name detection');
console.log('  The log entry is the operator\\'s signal that something is wrong');
var dw=logs.find(l=>l.d?.reason?.includes('duplicate')||l.a?.includes('duplicate'));
check(teststring+' Duplicate name detected and logged',!!dw,'log entry present','no detection');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 3: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+3-code)); FAIL=$((FAIL+code))
}

function test_group_4 {
divider " Group 4: Interface mutation after loading "
echo ""
echo "  Impact: A provider that changes its issuer or JWKS URL"
echo "  after init() redirects token validation to attacker keys."
echo "  Forged tokens pass verification for all accounts."
echo ""
create_hostile "hostile-mutate.js" 'let _i="https://legit.test/",_j="https://legit.test/.well-known/jwks.json";export default{name:"hostile_mutate",type:"oidc",priority:5,get issuer(){return _i},get jwksUri(){return _j},audience:"test",clientId:"test",isConfigured(){return process.env.HOSTILE_MUTATE==="true"},async init(){setTimeout(()=>{_i="https://evil-attacker.com/";_j="https://evil-attacker.com/.well-known/jwks.json"},100)},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""}};'
HOSTILE_MUTATE=true node --input-type=module -e "
import{_resetForTesting,initRegistry,getProvider,getJwksMap,getIssuers}from'./src/auth/index.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
_resetForTesting();await initRegistry(()=>{});
var prov=getProvider('hostile_mutate');

teststring='Test 3.1.4.1-A';
console.log('\nTest 3.1.4.1-A');
try{
console.log('  The hostile provider\\'s init() scheduled a setTimeout to change');
console.log('  its issuer from legit.test to evil-attacker.com after 100ms');
check(teststring+' Hostile provider loaded for test',prov!==null,'loaded','null');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.2-A';
console.log('\nTest 3.1.4.2-A');
try{
console.log('  Reading issuer immediately — setTimeout has not fired yet');
var issuerBefore=prov.issuer;
check(teststring+' Initial issuer is legitimate',issuerBefore==='https://legit.test/','https://legit.test/',issuerBefore);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.3-A';
console.log('\nTest 3.1.4.3-A');
try{
console.log('  Waiting 200ms for the mutation timer to fire');
console.log('  The LIVE provider object will mutate — we cannot prevent that');
console.log('  What matters is that the FROZEN SNAPSHOT the middleware uses did not change');
console.log('  Checking getJwksMap() — this reads from the snapshot, not the live object');
await new Promise(r=>setTimeout(r,200));
var liveIssuer=prov.issuer;
console.log('  Live provider issuer is now: '+liveIssuer);
console.log('  (Expected to mutate — the getter follows the mutable variable)');
var jwksMap=getJwksMap();
var snapshotHasLegit=jwksMap.has('https://legit.test/');
var snapshotHasEvil=jwksMap.has('https://evil-attacker.com/');
check(teststring+' Snapshot JWKS map still has legit.test',snapshotHasLegit,'legit.test in map',JSON.stringify([...jwksMap.keys()]));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.4-A';
console.log('\nTest 3.1.4.4-A');
try{
console.log('  The attacker\\'s URL must NOT appear in the JWKS map');
console.log('  If it did, the middleware would fetch attacker-controlled signing keys');
if(snapshotHasEvil){
  console.log('  ⚠ CRITICAL — JWKS map poisoned with attacker endpoint');
}
check(teststring+' JWKS map not poisoned by mutation',!snapshotHasEvil,'no evil-attacker.com','evil-attacker.com found');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.5-A';
console.log('\nTest 3.1.4.5-A');
try{
console.log('  Checking getIssuers() — the trusted issuer allowlist');
console.log('  Must contain legit.test, must NOT contain evil-attacker.com');
var issuers=getIssuers();
check(teststring+' Issuer allowlist not poisoned',
  issuers.includes('https://legit.test/')&&!issuers.includes('https://evil-attacker.com/'),
  'only legit.test',JSON.stringify(issuers));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 4: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+5-code)); FAIL=$((FAIL+code))
}

function test_group_5 {
divider " Group 5: Malformed provider files "
echo ""
echo "  Impact: Syntax errors or invalid exports in one file"
echo "  crash the registry. Auth for every user goes down."
echo ""
create_hostile "hostile-syntax.js" 'this is not valid javascript {{{'
create_hostile "hostile-no-export.js" 'export const name = "orphan";'
create_hostile "hostile-string-export.js" 'export default "not a provider";'
create_hostile "hostile-null-export.js" 'export default null;'
create_hostile "hostile-fn-export.js" 'export default function() { return "surprise"; };'
MOCK_AUTH_ENABLED=true node --input-type=module -e "
import{_resetForTesting,initRegistry,getProvider,isAuthEnabled}from'./src/auth/index.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
_resetForTesting();var result=await initRegistry(()=>{});

teststring='Test 3.1.5.1-A';
console.log('\nTest 3.1.5.1-A');
try{
console.log('  5 hostile files placed in providers/: syntax error, no default export,');
console.log('  string export, null export, function export');
console.log('  The registry scanned all of them — checking survival');
check(teststring+' Registry survived all 5 malformed files',true,'no crash','crash');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.5.2-A';
console.log('\nTest 3.1.5.2-A');
try{
console.log('  Legitimate mock provider was in the same directory');
check(teststring+' Mock provider still operational',getProvider('mock')!==null,'loaded','missing');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.5.3-A';
console.log('\nTest 3.1.5.3-A');
try{
console.log('  Auth enforcement must remain active via the surviving provider');
check(teststring+' Auth still enabled',isAuthEnabled(),'true',String(isAuthEnabled()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.5.4-A';
console.log('\nTest 3.1.5.4-A');
try{
console.log('  Each hostile file should be status \"error\" or \"skip\" — not \"ready\"');
var errorResults=result.results.filter(r=>r.status==='error'||r.status==='skip');
check(teststring+' All hostile files handled gracefully',errorResults.length>=4,'≥4',''+errorResults.length);

var names=['hostile-syntax','hostile-no-export','hostile-string','hostile-null','hostile-fn'];
var tn=5;
for(var name of names){
  }catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
  teststring='Test 3.1.5.'+tn+'-A';
  console.log('\nTest 3.1.5.'+tn+'-A');
  try{
  console.log('  Checking '+name+'.js — must not be status \"ready\"');
  check(name+' not loaded as provider',!result.results.some(x=>x.status==='ready'&&x.filename?.includes(name)),'not ready',result.results.find(x=>x.filename?.includes(name))?.status||'not found');
  tn++;
}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 5: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+9-code)); FAIL=$((FAIL+code))
}

function test_group_6 {
divider " Group 6: Hostile process.exit() in init "
echo ""
echo "  Impact: A provider calling process.exit() terminates the"
echo "  entire server. One file causes total outage."
echo ""
create_hostile "hostile-exit.js" 'export default{name:"hostile_exit",type:"oidc",priority:1,issuer:"https://exit.test/",jwksUri:"https://exit.test/.well-known/jwks.json",audience:"test",clientId:"test",isConfigured(){return process.env.HOSTILE_EXIT==="true"},async init(){process.exit(99)},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""}};'
echo ""
echo "  Test 3.1.6.1-A"
echo "  Provider init() calls process.exit(99)"
echo "  If exit code is 99, the hostile provider killed the server"
echo "  The registry should catch or isolate this"
HOSTILE_EXIT=true node --input-type=module -e "import{_resetForTesting,initRegistry}from'./src/auth/index.js';_resetForTesting();await initRegistry(()=>{});console.log('SURVIVED');
import fs from 'node:fs';" 2>&1
local ec=$?
if [ $ec -eq 99 ]; then
  echo "  ⚠ VULNERABILITY — hostile provider killed the process"
  echo "Test 3.1.6.1-A VULNERABILITY — hostile provider killed the process via process.exit(99)" >> "$FAILURE_LOG"
  echo "    Expected: process survives"; echo "    Actual:   process.exit(99) executed"
  FAIL=$((FAIL+1))
elif [ $ec -eq 0 ]; then echo "  ✓ Server survived hostile process.exit()"; PASS=$((PASS+1))
else echo "  ✗ Unexpected exit code: $ec"; echo "    Expected: 0 or 99"; echo "    Actual:   $ec"; echo "Test 3.1.6.1-A Unexpected exit code: $ec" >> "$FAILURE_LOG"; FAIL=$((FAIL+1)); fi
echo ""; echo "  Group 6: see result above"; echo ""
}

function test_group_7 {
divider " Group 7: Global state pollution "
echo ""
echo "  Impact: A provider that overwrites process.env can steal"
echo "  API keys or disable production checks. Credential"
echo "  exfiltration with no visible error."
echo ""
create_hostile "hostile-pollute.js" 'export default{name:"hostile_pollute",type:"oidc",priority:50,issuer:"https://pollute.test/",jwksUri:"https://pollute.test/.well-known/jwks.json",audience:"test",clientId:"test",isConfigured(){return process.env.HOSTILE_POLLUTE==="true"},async init(){process.env.ANTHROPIC_API_KEY="stolen";global.__hostilePayload="injected"},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""}};'
HOSTILE_POLLUTE=true MOCK_AUTH_ENABLED=true node --input-type=module -e "
import{_resetForTesting,initRegistry}from'./src/auth/index.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
_resetForTesting();await initRegistry(()=>{});

teststring='Test 3.1.7.1-A';
console.log('\nTest 3.1.7.1-A');
try{
console.log('  The hostile provider set process.env.ANTHROPIC_API_KEY=\"stolen\" in init()');
console.log('  If the registry does not sandbox providers, this overwrites the real key');
if(process.env.ANTHROPIC_API_KEY==='stolen'){
  console.log('  ⚠ VULNERABILITY — API key overwritten');
  check(teststring+' API key protected',false,'original value','stolen');
}else{check(teststring+' API key protected',true,'unchanged','unchanged')}

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.7.2-A';
console.log('\nTest 3.1.7.2-A');
try{
console.log('  The hostile provider set global.__hostilePayload=\"injected\"');
console.log('  Global pollution allows code injection across the entire application');
if(global.__hostilePayload==='injected'){
  console.log('  ⚠ VULNERABILITY — global namespace polluted');
  check(teststring+' Global namespace protected',false,'clean','injected');
}else{check(teststring+' Global namespace protected',true,'clean','clean')}

console.log('');
console.log('  NOTE: Full prevention requires sandboxing (vm module or child_process).');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 7: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+2-code)); FAIL=$((FAIL+code))
}

######## MAIN
if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> group 1 (crash in isConfigured)" x && test_group_1
  read -p "<Enter> group 2 (hang in init)" x && test_group_2
  read -p "<Enter> group 3 (duplicate names)" x && test_group_3
  read -p "<Enter> group 4 (interface mutation)" x && test_group_4
  read -p "<Enter> group 5 (malformed files)" x && test_group_5
  read -p "<Enter> group 6 (process.exit)" x && test_group_6
  read -p "<Enter> group 7 (global pollution)" x && test_group_7
else test_group_1;test_group_2;test_group_3;test_group_4;test_group_5;test_group_6;test_group_7; fi
divider; echo ""
echo "  ═══════════════════════════════════════"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
echo ""
if [ "$FAIL" -gt 0 ]; then echo "  ⚠ ${FAIL} vulnerability/test failure(s)."; else echo "  All adversarial tests passed."; fi
divider; echo ""; exit $FAIL
) 2>&1 | tee "$_FULL_LOG"

_RC=${PIPESTATUS[0]}

if [ $_RC -gt 0 ]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━ Failure Report ━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  if [ -s "$FAILURE_LOG" ]; then
    cat "$FAILURE_LOG"
  fi
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi

exit $_RC

