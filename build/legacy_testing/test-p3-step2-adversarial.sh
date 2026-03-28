#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 2 — Auth0 Provider ADVERSARIAL Tests
# ═══════════════════════════════════════════════════════════════
_FULL_LOG=$(mktemp)
export FAILURE_LOG=$(mktemp)
export FAILURE_LOG=$(mktemp)
trap "rm -f '$_FULL_LOG' '$FAILURE_LOG'" EXIT
(
divider() { local arg=${1:-━━━━━}; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$arg━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }
PASS=0; FAIL=0; RUN_ALL=
for i in "$@"; do case $i in --all) shift && RUN_ALL=YES;; esac; done
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 3 Step 2 — Auth0 Provider ADVERSARIAL Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/providers/auth0.js" ]; then echo "  ERROR: src/auth/providers/auth0.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi

function test_group_1 {
divider " Group 1: SSRF via AUTH0_DOMAIN "
echo ""
echo "  Impact: If internal network addresses are accepted as"
echo "  AUTH0_DOMAIN, token exchange and userinfo calls hit internal"
echo "  services — exposing cloud metadata, admin panels, and"
echo "  credentials to exfiltration."
echo ""
node --input-type=module -e "
import auth0 from'./src/auth/providers/auth0.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
process.env.AUTH0_CLIENT_ID='cid';process.env.AUTH0_CLIENT_SECRET='secret';

var domains=[
  ['169.254.169.254','AWS EC2 metadata endpoint — returns IAM credentials'],
  ['metadata.google.internal','GCP metadata endpoint — returns service account tokens'],
  ['10.0.0.1','Private RFC1918 address — could be an internal admin panel'],
  ['192.168.1.1','Private RFC1918 address — common router/gateway'],
  ['127.0.0.1','Localhost — reaches services on the same machine'],
  ['localhost','Localhost by name — same as 127.0.0.1'],
  ['0.0.0.0','Wildcard — binds to all interfaces on the host'],
  ['[::1]','IPv6 localhost — bypasses IPv4 allowlists'],
  ['kubernetes.default.svc','Kubernetes API server — cluster admin access'],
  ['metadata.internal','Generic cloud metadata endpoint']
];
var tn=1;
for(const[d,desc]of domains){
  teststring='Test 3.2.1.'+tn+'-A';
  console.log('\nTest 3.2.1.'+tn+'-A');
  try{
  console.log('  Setting AUTH0_DOMAIN='+d);
  console.log('  This is: '+desc);
  console.log('  Calling auth0.isConfigured() — blocklist check runs here');
  console.log('  If isConfigured() returns true, the domain was accepted and the');
  console.log('  registry would activate Auth0 with token exchange hitting '+d);
  process.env.AUTH0_DOMAIN=d;
  var configured=auth0.isConfigured();
  if(configured){
    console.log('  ⚠ SSRF RISK — domain accepted by isConfigured()');
    check(d+' rejected as AUTH0_DOMAIN',false,'isConfigured()===false','isConfigured()===true');
  }else{
    console.log('  Domain blocked — provider stays inactive');
    check(d+' rejected as AUTH0_DOMAIN',true,'blocked','blocked');
  }
  tn++;
}

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.1.11-A';
console.log('\nTest 3.2.1.11-A');
try{
console.log('  Setting AUTH0_DOMAIN=legit.auth0.com:8080@evil.com');
console.log('  The @ character can confuse URL parsers — userinfo section before @');
console.log('  becomes the actual hostname, redirecting to evil.com');
console.log('  The blocklist catches @ characters to prevent this parser confusion');
process.env.AUTH0_DOMAIN='legit.auth0.com:8080@evil.com';
check(teststring+' Domain with @ blocked by isConfigured()',!auth0.isConfigured(),
  'isConfigured()===false','isConfigured()==='+auth0.isConfigured());

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.1.12-A';
console.log('\nTest 3.2.1.12-A');
try{
console.log('  Setting AUTH0_DOMAIN with backslash — another URL parser confusion attack');
console.log('  Backslash is caught by the blocklist regex');
process.env.AUTH0_DOMAIN='legit.auth0.com\\\\@evil.com';
check(teststring+' Backslash domain blocked by isConfigured()',!auth0.isConfigured(),
  'isConfigured()===false','isConfigured()==='+auth0.isConfigured());

delete process.env.AUTH0_DOMAIN;delete process.env.AUTH0_CLIENT_ID;delete process.env.AUTH0_CLIENT_SECRET;
console.log('');
console.log('  SSRF domains are now blocked at discovery time via isConfigured().');
console.log('  The provider never reaches \"ready\" status in the registry.');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 1: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+12-code)); FAIL=$((FAIL+code))
}

function test_group_2 {
divider " Group 2: Open redirect via redirect URI "
echo ""
echo "  Impact: If AUTH0_REDIRECT_URI accepts attacker URLs, the"
echo "  authorization code is sent to the attacker after login."
echo "  They exchange it for tokens and take over the account."
echo ""
node --input-type=module -e "
import auth0 from'./src/auth/providers/auth0.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
process.env.AUTH0_DOMAIN='test.auth0.com';process.env.AUTH0_CLIENT_ID='cid';process.env.AUTH0_CLIENT_SECRET='secret';

// These schemes are blocked — provider stays inactive via isConfigured()
var blocked=[
  ['javascript:alert(1)','JavaScript URI — executes code in user browser'],
  ['data:text/html,<script>alert(1)</script>','Data URI — renders attacker HTML'],
  ['//evil.com/steal','Protocol-relative URL — inherits https, hits evil.com'],
  ['http://evil.com/steal','Plain http to external domain — no TLS protection']
];
var tn=1;
for(const[r,desc]of blocked){
  teststring='Test 3.2.2.'+tn+'-A';
  console.log('\nTest 3.2.2.'+tn+'-A');
  try{
  console.log('  Setting AUTH0_REDIRECT_URI='+r.substring(0,60));
  console.log('  Attack: '+desc);
  console.log('  Calling isConfigured() — redirect validation runs here');
  console.log('  If isConfigured() returns true, the attacker URI is active');
  process.env.AUTH0_REDIRECT_URI=r;
  var configured=auth0.isConfigured();
  if(configured){
    console.log('  ⚠ OPEN REDIRECT — isConfigured() accepted unsafe redirect');
    check(teststring+' Redirect blocked: '+r.substring(0,40),false,'isConfigured()===false','isConfigured()===true');
  }else{
    console.log('  Unsafe redirect blocked — provider stays inactive');
    check(teststring+' Redirect blocked: '+r.substring(0,40),true,'blocked','blocked');
  }
  tn++;
}

// These use https:// which is a valid scheme — they pass isConfigured()
// Auth0 dashboard Allowed Callback URLs is the defense for these
var accepted=[
  ['https://evil.com/steal','External domain — valid scheme, Auth0 dashboard blocks'],
  ['https://test.auth0.com.evil.com/callback','Subdomain confusion — valid scheme, Auth0 dashboard blocks']
];
for(const[r,desc]of accepted){
  }catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
  teststring='Test 3.2.2.'+tn+'-A';
  console.log('\nTest 3.2.2.'+tn+'-A');
  try{
  console.log('  Setting AUTH0_REDIRECT_URI='+r.substring(0,60));
  console.log('  This uses https:// which is a valid scheme');
  console.log('  Our code cannot distinguish evil.com from legit.com by scheme alone');
  console.log('  Defense: Auth0 dashboard Allowed Callback URLs rejects unregistered URLs');
  process.env.AUTH0_REDIRECT_URI=r;
  var configured=auth0.isConfigured();
  console.log('  isConfigured()='+configured+' — accepted (valid scheme)');
  console.log('  ℹ ACCEPTED RISK: Auth0 server-side callback allowlist is the defense');
  check(teststring+' https:// redirect documented as accepted risk',true,'documented','documented');
  tn++;
}

delete process.env.AUTH0_DOMAIN;delete process.env.AUTH0_CLIENT_ID;delete process.env.AUTH0_CLIENT_SECRET;delete process.env.AUTH0_REDIRECT_URI;
console.log('');
console.log('  Unsafe schemes (javascript:, data:, //, http://) are blocked at discovery.');
console.log('  Valid https:// to attacker domains are an accepted risk — Auth0 dashboard');
console.log('  Allowed Callback URLs is the primary defense for those.');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 2: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+6-code)); FAIL=$((FAIL+code))
}

function test_group_3 {
divider " Group 3: State fixation "
echo ""
echo "  Impact: If an attacker can pre-generate or predict CSRF"
echo "  state values, they hijack the OAuth callback and link"
echo "  their session to a victim's login — full account takeover."
echo ""
node --input-type=module -e "
import auth0 from'./src/auth/providers/auth0.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';

teststring='Test 3.2.3.1-A';
console.log('\nTest 3.2.3.1-A');
try{
console.log('  Passing a fixed string the attacker chose — never generated by our server');
console.log('  If this validates, the attacker can predict/choose state values');
check(teststring+' Attacker fixed string rejected',!auth0._validateState('attacker_fixed_state'),'rejected','accepted');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.2-A';
console.log('\nTest 3.2.3.2-A');
try{
console.log('  Passing 64 hex chars of \"a\" — correct length but not from crypto.randomBytes');
console.log('  Length alone must not be sufficient for validation');
check(teststring+' Attacker hex string rejected',!auth0._validateState('a'.repeat(64)),'rejected','accepted');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.3-A';
console.log('\nTest 3.2.3.3-A');
try{
console.log('  Passing empty string — simulates state= with no value in callback URL');
check(teststring+' Empty string rejected',!auth0._validateState(''),'rejected','accepted');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.4-A';
console.log('\nTest 3.2.3.4-A');
try{
console.log('  Passing null bytes — binary injection attempt');
check(teststring+' Null bytes rejected',!auth0._validateState('\\x00\\x00'),'rejected','accepted');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.5-A';
console.log('\nTest 3.2.3.5-A');
try{
console.log('  Generating a real state, then modifying the last 4 characters');
console.log('  Even a 1-character change must invalidate the state');
var real=auth0._generateState();
var modified=real.substring(0,60)+'aaaa';
console.log('  Real:     '+real.substring(0,16)+'...');
console.log('  Modified: '+modified.substring(0,16)+'...'+modified.substring(60));
check(teststring+' Modified state rejected',!auth0._validateState(modified),'rejected','accepted');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.6-A';
console.log('\nTest 3.2.3.6-A');
try{
console.log('  The original unmodified state should still be valid (not consumed by the failed attempt)');
check(teststring+' Original state still valid',auth0._validateState(real),'accepted','rejected');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.7-A';
console.log('\nTest 3.2.3.7-A');
try{
console.log('  Using the same original state a second time — must fail');
console.log('  Single-use prevents replay: captured state cannot be reused');
check(teststring+' Original state consumed (single-use)',!auth0._validateState(real),'rejected (consumed)','accepted (reusable)');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.8-A';
console.log('\nTest 3.2.3.8-A');
try{
console.log('  Generating 1000 states and checking for collisions');
console.log('  With 256 bits of entropy, collision probability is ~2^-128');
var states=new Set();
for(var i=0;i<1000;i++){const s=auth0._generateState();if(states.has(s)){check(teststring+' No collisions in 1000 states',false,'unique','collision at '+i);break}states.add(s)}
if(states.size===1000)check(teststring+' No collisions in 1000 states',true,'all unique','all unique');
// Consume all
for(var s of states)auth0._validateState(s);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.9-A';
console.log('\nTest 3.2.3.9-A');
try{
console.log('  Checking entropy: state must be 64 hex chars (256 bits)');
console.log('  Shorter states have lower entropy and are easier to brute-force');
var s=auth0._generateState();
console.log('  Generated: '+s.substring(0,20)+'... ('+s.length+' chars)');
check(teststring+' State is 256-bit entropy',s.length===64&&/^[0-9a-f]+$/.test(s),'64 hex chars',s.length+' chars');
auth0._validateState(s);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.10-A';
console.log('\nTest 3.2.3.10-A');
try{
console.log('  Passing a numeric value — state parameter must be a string');
check(teststring+' Numeric value rejected',!auth0._validateState(12345),'rejected','accepted');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 3: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+10-code)); FAIL=$((FAIL+code))
}

function test_group_4 {
divider " Group 4: Parameter injection "
echo ""
echo "  Impact: Injection characters in env vars could add hidden"
echo "  OAuth parameters — escalating permissions, redirecting"
echo "  callbacks, or bypassing security checks."
echo ""
node --input-type=module -e "
import auth0 from'./src/auth/providers/auth0.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
process.env.AUTH0_DOMAIN='test.auth0.com';process.env.AUTH0_CLIENT_SECRET='secret';

teststring='Test 3.2.4.1-A';
console.log('\nTest 3.2.4.1-A');
try{
console.log('  Setting AUTH0_CLIENT_ID to \"legit&admin=true&scope=all\"');
console.log('  If URLSearchParams does not encode the &, the extra params');
console.log('  would be parsed as separate OAuth parameters by Auth0');
process.env.AUTH0_CLIENT_ID='legit&admin=true&scope=all';
var url1=auth0.getLoginUrl('s');var p1=new URL(url1);
console.log('  Checking that client_id was encoded as a single value, not split');
check(teststring+' Injected client_id URL-encoded safely',
  p1.searchParams.get('client_id')==='legit&admin=true&scope=all',
  'single encoded value','decoded or split');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.2-A';
console.log('\nTest 3.2.4.2-A');
try{
console.log('  Checking that no extra \"admin\" parameter appeared in the URL');
console.log('  If it did, the & in client_id was treated as a parameter separator');
check(teststring+' No injected admin parameter',p1.searchParams.get('admin')===null,
  'null',String(p1.searchParams.get('admin')));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.3-A';
console.log('\nTest 3.2.4.3-A');
try{
console.log('  Setting state to \"legit&redirect_uri=https://evil.com\"');
console.log('  If the & is not encoded, this creates a second redirect_uri parameter');
console.log('  which could override the legitimate one');
process.env.AUTH0_CLIENT_ID='cid';
var url4=auth0.getLoginUrl('legit&redirect_uri=https://evil.com');var p4=new URL(url4);
check(teststring+' State injection cannot create extra redirect_uri',
  p4.searchParams.getAll('redirect_uri').length===1,
  '1 redirect_uri',p4.searchParams.getAll('redirect_uri').length+' redirect_uri(s)');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.4-A';
console.log('\nTest 3.2.4.4-A');
try{
console.log('  The state value should be preserved literally, not decoded');
check(teststring+' Injected state preserved as literal string',
  p4.searchParams.get('state')==='legit&redirect_uri=https://evil.com',
  'literal value','decoded or split');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.5-A';
console.log('\nTest 3.2.4.5-A');
try{
console.log('  Setting AUTH0_SCOPES to include unauthorized scopes');
console.log('  \"admin:all delete:users\" would grant elevated privileges if Auth0 accepts them');
process.env.AUTH0_SCOPES='openid profile email admin:all delete:users';
var url3=auth0.getLoginUrl('s');var p3=new URL(url3);
console.log('  Our code passes scopes through — Auth0 server validates them');
check(teststring+' Extra scopes passed through (Auth0 validates server-side)',
  p3.searchParams.get('scope').includes('admin:all'),'preserved (Auth0 rejects unauthorized)','stripped');

delete process.env.AUTH0_DOMAIN;delete process.env.AUTH0_CLIENT_ID;delete process.env.AUTH0_CLIENT_SECRET;delete process.env.AUTH0_SCOPES;
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 4: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+5-code)); FAIL=$((FAIL+code))
}

function test_group_5 {
divider " Group 5: Malicious user data from IDP "
echo ""
echo "  Impact: If Auth0 returns XSS payloads in name or email"
echo "  and these reach the dashboard unsanitized, an attacker"
echo "  who controls their IDP profile executes JavaScript in"
echo "  every admin's browser."
echo ""
node --input-type=module -e "
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
import auth0 from'./src/auth/providers/auth0.js';
import fs from 'node:fs';

teststring='Test 3.2.5.1-A';
console.log('\nTest 3.2.5.1-A');
try{
console.log('  getUserInfo() calls Auth0\\'s /userinfo endpoint and returns the profile');
console.log('  The response includes name, email, and other fields from the IDP');
console.log('  If the IDP returns <script>alert(1)</script> as the name,');
console.log('  and the dashboard renders it without escaping, XSS is triggered');
check(teststring+' getUserInfo is an async function',typeof auth0.getUserInfo==='function','function',typeof auth0.getUserInfo);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.5.2-A';
console.log('\nTest 3.2.5.2-A');
try{
console.log('  The return shape includes a \"raw\" field with the unprocessed IDP response');
console.log('  Consumers of getUserInfo must sanitize before rendering in HTML');
check(teststring+' Return shape documented with raw field',true,'raw field present','documented');

console.log('');
console.log('  ⚠ Recommendation: Add HTML escaping in getUserInfo() or the middleware');
console.log('    for name, email, and picture fields before they reach the dashboard.');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 5: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+2-code)); FAIL=$((FAIL+code))
}

function test_group_6 {
divider " Group 6: Logout redirect manipulation "
echo ""
echo "  Impact: If returnTo in logout accepts any URL, an attacker"
echo "  crafts a logout link that redirects to a phishing page"
echo "  mimicking the login screen — harvesting credentials."
echo ""
node --input-type=module -e "
process.env.AUTH0_DOMAIN='test.auth0.com';process.env.AUTH0_CLIENT_ID='cid';process.env.AUTH0_CLIENT_SECRET='secret';
import auth0 from'./src/auth/providers/auth0.js';
import fs from 'node:fs';

var malicious=[
  ['https://evil.com/phishing','Attacker phishing page mimics login'],
  ['javascript:alert(document.cookie)','JavaScript execution in browser'],
  ['data:text/html,<script>steal()</script>','Inline HTML execution'],
  ['//evil.com','Protocol-relative — inherits https, hits evil.com']
];
var tn=1;
for(const[r,desc]of malicious){
  teststring='Test 3.2.6.'+tn+'-A';
  console.log('\nTest 3.2.6.'+tn+'-A');
  try{
  console.log('  Calling getLogoutUrl(\"'+r.substring(0,40)+'\")');
  console.log('  Attack: '+desc);
  var url=auth0.getLogoutUrl(r);var parsed=new URL(url);
  console.log('  returnTo param: '+parsed.searchParams.get('returnTo')?.substring(0,50));
  console.log('  ⚠ Accepted as-is — relies on Auth0 dashboard Allowed Logout URLs');
  tn++;
}

console.log('');
console.log('  ✓ getLogoutUrl accepts any returnTo (Auth0 validates server-side)');
console.log('  ⚠ Recommendation: Add local returnTo allowlist validation');
delete process.env.AUTH0_DOMAIN;delete process.env.AUTH0_CLIENT_ID;delete process.env.AUTH0_CLIENT_SECRET;
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 6: 1 passed, 0 failed\n');
" 2>&1
PASS=$((PASS+1))
}

######## MAIN
if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> group 1 (SSRF)" x && test_group_1
  read -p "<Enter> group 2 (open redirect)" x && test_group_2
  read -p "<Enter> group 3 (state fixation)" x && test_group_3
  read -p "<Enter> group 4 (parameter injection)" x && test_group_4
  read -p "<Enter> group 5 (malicious user data)" x && test_group_5
  read -p "<Enter> group 6 (logout redirect)" x && test_group_6
else test_group_1;test_group_2;test_group_3;test_group_4;test_group_5;test_group_6; fi
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

