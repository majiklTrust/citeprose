#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 2 — Auth0 OIDC Provider Test Suite
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
echo "  Phase 3 Step 2 — Auth0 OIDC Provider Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/providers/auth0.js" ]; then echo "  ERROR: src/auth/providers/auth0.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi

function test_group_1 {
divider " Group 1: Env var gating "
echo ""
echo "  Impact: If these tests fail, Auth0 could activate without"
echo "  proper credentials or fail to activate when credentials"
echo "  are present. Users cannot log in, or the system attempts"
echo "  auth with incomplete config — producing cryptic errors."
echo ""
node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';
import fs from 'node:fs';
var pass = 0, fail = 0;
function check(info, cond, expected, actual) {
  if (cond) { console.log('  ✓ ' + info); pass++; }
  else { console.log('  ✗ ' + info); console.log('    Expected: ' + expected); console.log('    Actual:   ' + actual); try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){}; fail++; }
}
var teststring='';

// Auth0 requires three env vars: AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET.
// Without all three, the provider must not activate.
teststring='Test 3.2.1.1';
console.log('Test 3.2.1.1');
try{
console.log('  Clearing AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET');
delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
console.log('  Calling auth0.isConfigured() — should return false with zero credentials');
check(teststring+' Provider inactive when no env vars are set',
  !auth0.isConfigured(), 'false', String(auth0.isConfigured()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.1.2';
console.log('Test 3.2.1.2');
try{
console.log('  Setting AUTH0_DOMAIN=test.auth0.com (1 of 3 credentials)');
process.env.AUTH0_DOMAIN = 'test.auth0.com';
console.log('  Without client ID and secret, the provider cannot authenticate to Auth0');
check(teststring+' Provider inactive with only domain set',
  !auth0.isConfigured(), 'false', String(auth0.isConfigured()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.1.3';
console.log('Test 3.2.1.3');
try{
console.log('  Adding AUTH0_CLIENT_ID=cid (2 of 3 credentials)');
process.env.AUTH0_CLIENT_ID = 'cid';
console.log('  The client secret signs the token exchange — without it, login always fails');
check(teststring+' Provider inactive without client secret',
  !auth0.isConfigured(), 'false', String(auth0.isConfigured()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.1.4';
console.log('Test 3.2.1.4');
try{
console.log('  Adding AUTH0_CLIENT_SECRET=secret (3 of 3 credentials)');
process.env.AUTH0_CLIENT_SECRET = 'secret';
console.log('  All three present — this is the only combination that enables login');
check(teststring+' Provider activates with all three credentials',
  auth0.isConfigured(), 'true', String(auth0.isConfigured()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.1.5';
console.log('Test 3.2.1.5');
try{
console.log('  Setting AUTH0_DOMAIN to empty string (simulates blank .env value)');
console.log('  An empty domain would produce malformed URLs like https:///authorize');
process.env.AUTH0_DOMAIN = '';
check(teststring+' Provider rejects empty domain string',
  !auth0.isConfigured(), 'false', String(auth0.isConfigured()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.1.6';
console.log('Test 3.2.1.6');
try{
console.log('  Setting AUTH0_DOMAIN to three spaces (whitespace-only)');
console.log('  After trimming, domain is empty — same as missing');
process.env.AUTH0_DOMAIN = '   ';
check(teststring+' Provider rejects whitespace-only domain',
  !auth0.isConfigured(), 'false', String(auth0.isConfigured()));

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log(''); console.log('  Group 1: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 6 - code)); FAIL=$((FAIL + code))
}

function test_group_2 {
divider " Group 2: Domain normalization "
echo ""
echo "  Impact: If these tests fail, operators who paste the Auth0"
echo "  domain with a protocol prefix or trailing slash get broken"
echo "  token exchange URLs. Login fails silently."
echo ""
node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';
import fs from 'node:fs';
var pass = 0, fail = 0;
function check(info, cond, expected, actual) {
  if (cond) { console.log('  ✓ ' + info); pass++; }
  else { console.log('  ✗ ' + info); console.log('    Expected: ' + expected); console.log('    Actual:   ' + actual); try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){}; fail++; }
}
var teststring='';
process.env.AUTH0_CLIENT_ID = 'cid'; process.env.AUTH0_CLIENT_SECRET = 'secret';

teststring='Test 3.2.2.1';
console.log('Test 3.2.2.1');
try{
console.log('  Setting AUTH0_DOMAIN=test.auth0.com (clean, no protocol)');
process.env.AUTH0_DOMAIN = 'test.auth0.com';
console.log('  Domain should be used as-is when already clean');
check(teststring+' Clean domain accepted', auth0._getConfig().domain === 'test.auth0.com', 'test.auth0.com', auth0._getConfig().domain);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.2.2';
console.log('Test 3.2.2.2');
try{
console.log('  Setting AUTH0_DOMAIN=https://test.auth0.com');
console.log('  Operators copy this from browser URL bar — https:// must be stripped');
process.env.AUTH0_DOMAIN = 'https://test.auth0.com';
check(teststring+' https:// prefix stripped', auth0._getConfig().domain === 'test.auth0.com', 'test.auth0.com', auth0._getConfig().domain);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.2.3';
console.log('Test 3.2.2.3');
try{
console.log('  Setting AUTH0_DOMAIN=http://test.auth0.com/');
console.log('  Both http:// and trailing slash must be removed');
process.env.AUTH0_DOMAIN = 'http://test.auth0.com/';
check(teststring+' http:// and trailing / stripped', auth0._getConfig().domain === 'test.auth0.com', 'test.auth0.com', auth0._getConfig().domain);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.2.4';
console.log('Test 3.2.2.4');
try{
console.log('  Setting AUTH0_DOMAIN=test.auth0.com/');
console.log('  Trailing slash alone would double-slash URLs: https://test.auth0.com//authorize');
process.env.AUTH0_DOMAIN = 'test.auth0.com/';
check(teststring+' Trailing / stripped', auth0._getConfig().domain === 'test.auth0.com', 'test.auth0.com', auth0._getConfig().domain);

// Verify all derived URLs are constructed correctly from the normalized domain
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.2.5';
console.log('Test 3.2.2.5');
try{
process.env.AUTH0_DOMAIN = 'https://test.auth0.com/';
var cfg = auth0._getConfig();
console.log('  Verifying issuer URL constructed from normalized domain');
console.log('  The issuer must have a trailing slash — OIDC spec requirement');
check(teststring+' Issuer URL correct', cfg.issuer === 'https://test.auth0.com/', 'https://test.auth0.com/', cfg.issuer);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.2.6';
console.log('Test 3.2.2.6');
try{
console.log('  JWKS URI is where signing keys are published for token verification');
check(teststring+' JWKS URI correct', cfg.jwksUri === 'https://test.auth0.com/.well-known/jwks.json',
  'https://test.auth0.com/.well-known/jwks.json', cfg.jwksUri);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.2.7';
console.log('Test 3.2.2.7');
try{
console.log('  Token URL is called during code→token exchange after login callback');
check(teststring+' Token URL correct', cfg.tokenUrl === 'https://test.auth0.com/oauth/token',
  'https://test.auth0.com/oauth/token', cfg.tokenUrl);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.2.8';
console.log('Test 3.2.2.8');
try{
console.log('  UserInfo URL retrieves the authenticated user profile');
check(teststring+' UserInfo URL correct', cfg.userInfoUrl === 'https://test.auth0.com/userinfo',
  'https://test.auth0.com/userinfo', cfg.userInfoUrl);

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log(''); console.log('  Group 2: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 8 - code)); FAIL=$((FAIL + code))
}

function test_group_3 {
divider " Group 3: OAuth state management "
echo ""
echo "  Impact: If these tests fail, the login flow is vulnerable"
echo "  to CSRF attacks. An attacker could forge OAuth redirects"
echo "  and hijack a user's session — gaining full access to their"
echo "  account and connected LinkedIn profile."
echo ""
node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';
import fs from 'node:fs';
var pass = 0, fail = 0;
function check(info, cond, expected, actual) {
  if (cond) { console.log('  ✓ ' + info); pass++; }
  else { console.log('  ✗ ' + info); console.log('    Expected: ' + expected); console.log('    Actual:   ' + actual); try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){}; fail++; }
}
var teststring='';

// The state parameter prevents CSRF in OAuth flows. It must be:
// 1. Cryptographically random (unpredictable)
// 2. Sufficient entropy (256 bits = 64 hex chars)
// 3. Single-use (consumed on validation)
teststring='Test 3.2.3.1';
console.log('Test 3.2.3.1');
try{
console.log('  Generating a CSRF state via auth0._generateState()');
console.log('  This is called each time a user clicks \"Log in\"');
var s1 = auth0._generateState();
console.log('  Returned: ' + s1.substring(0, 16) + '...');
console.log('  Checking type — must be a string for URL parameter encoding');
check(teststring+' State is a string', typeof s1 === 'string', 'string', typeof s1);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.2';
console.log('Test 3.2.3.2');
try{
console.log('  Checking state format: must be exactly 64 hexadecimal characters');
console.log('  64 hex chars = 32 bytes = 256 bits of entropy from crypto.randomBytes(32)');
console.log('  This makes brute-force prediction computationally infeasible');
check(teststring+' State is 256-bit (64 hex chars)', /^[0-9a-f]{64}$/.test(s1), '64 hex chars matching [0-9a-f]', s1.length + ' chars');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.3';
console.log('Test 3.2.3.3');
try{
console.log('  Generating a second state and comparing to the first');
console.log('  If two states are ever identical, the PRNG is broken or seeded predictably');
var s2 = auth0._generateState();
console.log('  State 1: ' + s1.substring(0, 12) + '...');
console.log('  State 2: ' + s2.substring(0, 12) + '...');
console.log('  These must differ — identical states would allow replay attacks');
check(teststring+' Two states are never identical', s1 !== s2, 'different values', 'identical');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.4';
console.log('Test 3.2.3.4');
try{
console.log('  Validating state s2 — first use should succeed');
console.log('  This simulates the callback receiving the correct state from Auth0');
check(teststring+' Valid state accepted on first use', auth0._validateState(s2), 'true', 'false');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.5';
console.log('Test 3.2.3.5');
try{
console.log('  Attempting to validate s2 again — must fail');
console.log('  Single-use enforcement prevents replay: an attacker who captures a state');
console.log('  cannot reuse it to hijack a second login attempt');
check(teststring+' Same state rejected (single-use)', !auth0._validateState(s2), 'false (consumed)', 'true (reusable)');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.6';
console.log('Test 3.2.3.6');
try{
console.log('  Passing null to validateState — simulates missing state in callback');
check(teststring+' Null state rejected', !auth0._validateState(null), 'false', 'true');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.7';
console.log('Test 3.2.3.7');
try{
console.log('  Passing undefined — simulates callback without state query parameter');
check(teststring+' Undefined state rejected', !auth0._validateState(undefined), 'false', 'true');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.8';
console.log('Test 3.2.3.8');
try{
console.log('  Passing empty string — simulates state= with no value');
check(teststring+' Empty string rejected', !auth0._validateState(''), 'false', 'true');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.9';
console.log('Test 3.2.3.9');
try{
console.log('  Passing a plausible-looking string that was never generated by our server');
console.log('  This simulates an attacker crafting their own state value');
check(teststring+' Attacker-crafted string rejected', !auth0._validateState('not-a-real-state'), 'false', 'true');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.10';
console.log('Test 3.2.3.10');
try{
console.log('  Passing a number — state must be a string from our generator');
check(teststring+' Numeric value rejected', !auth0._validateState(12345), 'false', 'true');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.11';
console.log('Test 3.2.3.11');
try{
console.log('  Generating 10 states, shuffling, validating in random order');
console.log('  States must validate regardless of the order they are consumed');
var states = [];
for (var i = 0; i < 10; i++) states.push(auth0._generateState());
var shuffled = states.sort(() => Math.random() - 0.5);
var allValid = true;
for (var s of shuffled) { if (!auth0._validateState(s)) allValid = false; }
check(teststring+' 10 states validated in random order', allValid, 'all valid', 'some invalid');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.3.12';
console.log('Test 3.2.3.12');
try{
console.log('  Re-validating all 10 states — every one must fail (already consumed)');
var allInvalid = true;
for (var s of shuffled) { if (auth0._validateState(s)) allInvalid = false; }
check(teststring+' All 10 reject second validation', allInvalid, 'all rejected', 'some accepted');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log(''); console.log('  Group 3: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 12 - code)); FAIL=$((FAIL + code))
}

function test_group_4 {
divider " Group 4: Login URL construction "
echo ""
echo "  Impact: If these tests fail, clicking 'Log in' sends users"
echo "  to a malformed Auth0 URL. Login fails for every user —"
echo "  the platform is completely inaccessible."
echo ""
node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';
import fs from 'node:fs';
process.env.AUTH0_DOMAIN='my-tenant.auth0.com';process.env.AUTH0_CLIENT_ID='client_abc123';
process.env.AUTH0_CLIENT_SECRET='secret';process.env.AUTH0_AUDIENCE='https://my-api';
process.env.AUTH0_REDIRECT_URI='https://app.example.com/auth/callback';
process.env.AUTH0_SCOPES='openid profile email offline_access';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';

teststring='Test 3.2.4.1';
console.log('Test 3.2.4.1');
try{
console.log('  Generating login URL with state=state_xyz');
var url=auth0.getLoginUrl('state_xyz');var parsed=new URL(url);
console.log('  URL generated: '+url.substring(0,80)+'...');
console.log('  Checking protocol — must be HTTPS to protect credentials in transit');
check(teststring+' Login URL uses HTTPS',parsed.protocol==='https:','https:',parsed.protocol);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.2';
console.log('Test 3.2.4.2');
try{
console.log('  The hostname must match AUTH0_DOMAIN — any other domain is a redirect attack');
check(teststring+' Targets correct Auth0 domain',parsed.hostname==='my-tenant.auth0.com','my-tenant.auth0.com',parsed.hostname);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.3';
console.log('Test 3.2.4.3');
try{
console.log('  /authorize is Auth0\\'s OAuth2 authorization endpoint');
check(teststring+' Uses /authorize endpoint',parsed.pathname==='/authorize','/authorize',parsed.pathname);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.4';
console.log('Test 3.2.4.4');
try{
console.log('  response_type=code means we want an authorization code, not an implicit token');
console.log('  The code flow is more secure because tokens never pass through the browser URL');
check(teststring+' Requests authorization code flow',parsed.searchParams.get('response_type')==='code','code',parsed.searchParams.get('response_type'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.5';
console.log('Test 3.2.4.5');
try{
console.log('  client_id identifies our application to Auth0');
check(teststring+' Includes client ID',parsed.searchParams.get('client_id')==='client_abc123','client_abc123',parsed.searchParams.get('client_id'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.6';
console.log('Test 3.2.4.6');
try{
console.log('  redirect_uri is where Auth0 sends the user after they log in');
console.log('  Must match exactly what is configured in the Auth0 dashboard');
check(teststring+' Includes callback redirect',parsed.searchParams.get('redirect_uri')==='https://app.example.com/auth/callback',
  'https://app.example.com/auth/callback',parsed.searchParams.get('redirect_uri'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.7';
console.log('Test 3.2.4.7');
try{
console.log('  Scopes define what data we request: openid (required), profile, email');
console.log('  offline_access enables refresh tokens for long sessions');
check(teststring+' Includes OIDC scopes',parsed.searchParams.get('scope')==='openid profile email offline_access',
  'openid profile email offline_access',parsed.searchParams.get('scope'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.8';
console.log('Test 3.2.4.8');
try{
console.log('  audience tells Auth0 which API this token is for');
console.log('  The JWT aud claim will contain this value for verification');
check(teststring+' Includes API audience',parsed.searchParams.get('audience')==='https://my-api','https://my-api',parsed.searchParams.get('audience'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.9';
console.log('Test 3.2.4.9');
try{
console.log('  The state parameter is the CSRF token — must round-trip through Auth0');
check(teststring+' Includes CSRF state',parsed.searchParams.get('state')==='state_xyz','state_xyz',parsed.searchParams.get('state'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.10';
console.log('Test 3.2.4.10');
try{
console.log('  Calling getLoginUrl() with no state argument');
console.log('  The provider should auto-generate a 256-bit state for CSRF protection');
var url2=auth0.getLoginUrl();var parsed2=new URL(url2);
var autoState=parsed2.searchParams.get('state');
console.log('  Auto-generated state: '+(autoState?.substring(0,16)||'null')+'...');
check(teststring+' State auto-generated when none provided',autoState&&/^[0-9a-f]{64}$/.test(autoState),'64 hex chars',String(autoState?.length)+' chars');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.4.11';
console.log('Test 3.2.4.11');
try{
console.log('  Removing AUTH0_REDIRECT_URI and setting DASHBOARD_PORT=4000');
console.log('  The default redirect should use localhost with the configured port');
delete process.env.AUTH0_REDIRECT_URI;process.env.DASHBOARD_PORT='4000';
var url3=auth0.getLoginUrl('s');
console.log('  Generated URL contains: '+url3.substring(url3.indexOf('redirect'),url3.indexOf('redirect')+60));
check(teststring+' Default redirect uses DASHBOARD_PORT',url3.includes('localhost%3A4000')||url3.includes('localhost:4000'),
  'contains port 4000','see URL above');

delete process.env.AUTH0_DOMAIN;delete process.env.AUTH0_CLIENT_ID;delete process.env.AUTH0_CLIENT_SECRET;
delete process.env.AUTH0_AUDIENCE;delete process.env.AUTH0_SCOPES;delete process.env.DASHBOARD_PORT;
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 4: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 11 - code)); FAIL=$((FAIL + code))
}

function test_group_5 {
divider " Group 5: Logout URL construction "
echo ""
echo "  Impact: If these tests fail, users cannot log out. Sessions"
echo "  persist indefinitely — on shared devices, the next person"
echo "  has full access to the previous user's account."
echo ""
node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';
import fs from 'node:fs';
process.env.AUTH0_DOMAIN='my-tenant.auth0.com';process.env.AUTH0_CLIENT_ID='client_abc123';
process.env.AUTH0_CLIENT_SECRET='secret';process.env.AUTH0_LOGOUT_URI='https://app.example.com/';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';

teststring='Test 3.2.5.1';
console.log('Test 3.2.5.1');
try{
console.log('  Generating logout URL with returnTo=https://app.example.com/goodbye');
var url=auth0.getLogoutUrl('https://app.example.com/goodbye');var parsed=new URL(url);
console.log('  URL: '+url);
check(teststring+' Logout URL uses HTTPS',parsed.protocol==='https:','https:',parsed.protocol);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.5.2';
console.log('Test 3.2.5.2');
try{
console.log('  Logout must target the same Auth0 domain as login');
check(teststring+' Targets correct domain',parsed.hostname==='my-tenant.auth0.com','my-tenant.auth0.com',parsed.hostname);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.5.3';
console.log('Test 3.2.5.3');
try{
console.log('  Auth0 v2/logout endpoint clears the SSO session server-side');
check(teststring+' Uses /v2/logout endpoint',parsed.pathname==='/v2/logout','/v2/logout',parsed.pathname);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.5.4';
console.log('Test 3.2.5.4');
try{
console.log('  client_id ensures Auth0 clears the correct application session');
check(teststring+' Includes client ID',parsed.searchParams.get('client_id')==='client_abc123','client_abc123',parsed.searchParams.get('client_id'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.5.5';
console.log('Test 3.2.5.5');
try{
console.log('  returnTo is where the user lands after Auth0 clears the session');
check(teststring+' Redirects to specified destination',parsed.searchParams.get('returnTo')==='https://app.example.com/goodbye',
  'https://app.example.com/goodbye',parsed.searchParams.get('returnTo'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.5.6';
console.log('Test 3.2.5.6');
try{
console.log('  Calling getLogoutUrl() with no argument — should use AUTH0_LOGOUT_URI');
var url2=auth0.getLogoutUrl();var parsed2=new URL(url2);
console.log('  Default returnTo: '+parsed2.searchParams.get('returnTo'));
check(teststring+' Default uses AUTH0_LOGOUT_URI',parsed2.searchParams.get('returnTo')==='https://app.example.com/',
  'https://app.example.com/',parsed2.searchParams.get('returnTo'));

delete process.env.AUTH0_DOMAIN;delete process.env.AUTH0_CLIENT_ID;delete process.env.AUTH0_CLIENT_SECRET;delete process.env.AUTH0_LOGOUT_URI;
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 5: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 6 - code)); FAIL=$((FAIL + code))
}

function test_group_6 {
divider " Group 6: Init validation "
echo ""
echo "  Impact: If these tests fail, the app starts with invalid"
echo "  Auth0 config that fails on every login attempt. Users see"
echo "  broken login pages with no clear error."
echo ""
node --input-type=module -e "
import auth0 from './src/auth/providers/auth0.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';

teststring='Test 3.2.6.1';
console.log('Test 3.2.6.1');
try{
console.log('  Calling init() with AUTH0_DOMAIN missing');
console.log('  Init must throw with a message naming the missing variable');
process.env.AUTH0_CLIENT_ID='cid';process.env.AUTH0_CLIENT_SECRET='secret';delete process.env.AUTH0_DOMAIN;
try{await auth0.init();check(teststring+' Missing domain caught',false,'throws','succeeded')}
catch(e){check(teststring+' Missing domain caught at startup',e.message.includes('AUTH0_DOMAIN'),'mentions AUTH0_DOMAIN',e.message.substring(0,60))}

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.6.2';
console.log('Test 3.2.6.2');
try{
console.log('  Setting AUTH0_DOMAIN=nodots (no dots in domain)');
console.log('  A domain without dots cannot resolve in DNS — must be rejected');
process.env.AUTH0_DOMAIN='nodots';
try{await auth0.init();check(teststring+' Invalid domain caught',false,'throws','succeeded')}
catch(e){check(teststring+' No-dot domain caught',e.message.includes('appears invalid'),'mentions invalid',e.message.substring(0,60))}

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.6.3';
console.log('Test 3.2.6.3');
try{
console.log('  Setting AUTH0_DOMAIN with spaces — DNS cannot resolve this');
process.env.AUTH0_DOMAIN='has spaces.auth0.com';
try{await auth0.init();check(teststring+' Spaces caught',false,'throws','succeeded')}
catch(e){check(teststring+' Domain with spaces caught',e.message.includes('appears invalid'),'mentions invalid',e.message.substring(0,60))}

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.6.4';
console.log('Test 3.2.6.4');
try{
console.log('  Calling init() without AUTH0_CLIENT_SECRET');
process.env.AUTH0_DOMAIN='test.auth0.com';delete process.env.AUTH0_CLIENT_SECRET;
try{await auth0.init();check(teststring+' Missing secret caught',false,'throws','succeeded')}
catch(e){check(teststring+' Missing secret caught',e.message.includes('AUTH0_CLIENT_SECRET'),'mentions AUTH0_CLIENT_SECRET',e.message.substring(0,60))}

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.6.5';
console.log('Test 3.2.6.5');
try{
console.log('  Calling init() with all three valid credentials');
console.log('  Discovery fetch may fail (no real Auth0) but init should still succeed');
process.env.AUTH0_DOMAIN='test.auth0.com';process.env.AUTH0_CLIENT_ID='cid';process.env.AUTH0_CLIENT_SECRET='secret';
try{await auth0.init();check(teststring+' Valid config passes init',auth0._isInitialized(),'initialized','not initialized')}
catch(e){check(teststring+' Valid config passes init',false,'succeeds','threw: '+e.message)}

delete process.env.AUTH0_DOMAIN;delete process.env.AUTH0_CLIENT_ID;delete process.env.AUTH0_CLIENT_SECRET;
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 6: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 5 - code)); FAIL=$((FAIL + code))
}

function test_group_7 {
divider " Group 7: Multi-provider coexistence "
echo ""
echo "  Impact: If these tests fail, adding WorkOS for enterprise"
echo "  SSO breaks Auth0 login. The platform cannot serve both"
echo "  individual and enterprise customers — blocking growth."
echo ""
node --input-type=module -e "
import{_resetForTesting,initRegistry,getProviders,getProvider,getDefaultProvider}from'./src/auth/index.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';

teststring='Test 3.2.7.1';
console.log('Test 3.2.7.1');
try{
console.log('  Configuring both Auth0 and mock providers simultaneously');
_resetForTesting();process.env.AUTH0_DOMAIN='test.auth0.com';process.env.AUTH0_CLIENT_ID='cid';
process.env.AUTH0_CLIENT_SECRET='secret';process.env.MOCK_AUTH_ENABLED='true';
await initRegistry(()=>{});
console.log('  Auth0 priority=10, mock priority=999 — Auth0 should be default');
check(teststring+' Both providers loaded',getProviders().length===2,'2',''+getProviders().length);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.7.2';
console.log('Test 3.2.7.2');
try{
console.log('  Default provider should be Auth0 (priority 10 beats mock\\'s 999)');
check(teststring+' Auth0 is default',getDefaultProvider()?.name==='auth0','auth0',String(getDefaultProvider()?.name));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.7.3';
console.log('Test 3.2.7.3');
try{
console.log('  Mock should still be accessible by name for testing');
check(teststring+' Mock accessible alongside Auth0',getProvider('mock')!==null,'non-null',String(getProvider('mock')));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.7.4';
console.log('Test 3.2.7.4');
try{
check(teststring+' Auth0 accessible by name',getProvider('auth0')!==null,'non-null',String(getProvider('auth0')));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.7.5';
console.log('Test 3.2.7.5');
try{
console.log('  Providers must be sorted by priority for predictable default selection');
check(teststring+' Priority order correct',getProviders()[0].priority<getProviders()[1].priority,
  'ascending',getProviders().map(p=>p.name+'='+p.priority).join(', '));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.7.6';
console.log('Test 3.2.7.6');
try{
console.log('  Disabling mock — Auth0 should operate alone');
_resetForTesting();delete process.env.MOCK_AUTH_ENABLED;await initRegistry(()=>{});
check(teststring+' Auth0 alone when mock unconfigured',getProviders().length===1&&getDefaultProvider()?.name==='auth0',
  'only auth0',getProviders().map(p=>p.name).join(', '));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.7.7';
console.log('Test 3.2.7.7');
try{
console.log('  Disabling Auth0 — mock should operate alone');
_resetForTesting();delete process.env.AUTH0_DOMAIN;delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET;process.env.MOCK_AUTH_ENABLED='true';await initRegistry(()=>{});
check(teststring+' Mock alone when Auth0 unconfigured',getProviders().length===1&&getDefaultProvider()?.name==='mock',
  'only mock',getProviders().map(p=>p.name).join(', '));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.7.8';
console.log('Test 3.2.7.8');
try{
console.log('  Disabling everything — zero providers');
_resetForTesting();delete process.env.MOCK_AUTH_ENABLED;await initRegistry(()=>{});
check(teststring+' No providers when nothing configured',getProviders().length===0,'0',''+getProviders().length);

delete process.env.AUTH0_DOMAIN;delete process.env.AUTH0_CLIENT_ID;delete process.env.AUTH0_CLIENT_SECRET;delete process.env.MOCK_AUTH_ENABLED;
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 7: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 8 - code)); FAIL=$((FAIL + code))
}

function test_group_8 {
divider " Group 8: Shutdown and cleanup "
echo ""
echo "  Impact: If these tests fail, stale CSRF states and cached"
echo "  keys persist after restart. Expired states could be replayed"
echo "  and rotated signing keys never picked up."
echo ""
AUTH0_DOMAIN=test.auth0.com AUTH0_CLIENT_ID=cid AUTH0_CLIENT_SECRET=secret node --input-type=module -e "
import auth0 from'./src/auth/providers/auth0.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';

teststring='Test 3.2.8.1';
console.log('Test 3.2.8.1');
try{
console.log('  Calling auth0.init() to establish provider state');
await auth0.init();
check(teststring+' Provider initialized',auth0._isInitialized(),'true',String(auth0._isInitialized()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.8.2';
console.log('Test 3.2.8.2');
try{
console.log('  Generating 2 CSRF states to populate the state map');
auth0._generateState();auth0._generateState();
check(teststring+' CSRF states exist',auth0._getStateCount()>=2,'≥2',auth0._getStateCount()+' states');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.8.3';
console.log('Test 3.2.8.3');
try{
console.log('  Calling auth0.shutdown() — must clear all state');
await auth0.shutdown();
check(teststring+' Not initialized after shutdown',!auth0._isInitialized(),'false',String(auth0._isInitialized()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.8.4';
console.log('Test 3.2.8.4');
try{
console.log('  CSRF state map should be empty — prevents replay of old states');
check(teststring+' All CSRF states cleared',auth0._getStateCount()===0,'0',auth0._getStateCount()+' states');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.2.8.5';
console.log('Test 3.2.8.5');
try{
console.log('  Discovery cache should be null — forces fresh key fetch on restart');
check(teststring+' Discovery cache cleared',auth0._getDiscoveryCache()===null,'null',String(auth0._getDiscoveryCache()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 8: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 5 - code)); FAIL=$((FAIL + code))
}

######## MAIN
if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> group 1 (env var gating)" x && test_group_1
  read -p "<Enter> group 2 (domain normalization)" x && test_group_2
  read -p "<Enter> group 3 (state management)" x && test_group_3
  read -p "<Enter> group 4 (login URL)" x && test_group_4
  read -p "<Enter> group 5 (logout URL)" x && test_group_5
  read -p "<Enter> group 6 (init validation)" x && test_group_6
  read -p "<Enter> group 7 (multi-provider)" x && test_group_7
  read -p "<Enter> group 8 (shutdown)" x && test_group_8
else test_group_1;test_group_2;test_group_3;test_group_4;test_group_5;test_group_6;test_group_7;test_group_8; fi
divider; echo ""
echo "  ═══════════════════════════════════════"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then echo "  ⚠ ${FAIL} test(s) failed."; else echo "  All tests passed."; fi
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

