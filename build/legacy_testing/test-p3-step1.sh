#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 1 — Auth Provider Registry Test Suite
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
echo "  Phase 3 Step 1 — Auth Provider Registry Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/index.js" ]; then echo "  ERROR: src/auth/index.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi

function test_group_1 {
divider " Group 1: Interface contract "
echo ""
echo "  Impact: If these tests fail, new authentication providers"
echo "  (Auth0, WorkOS, or any future IDP) cannot be integrated."
echo "  The platform is locked to a single auth method with no"
echo "  standard way to add alternatives."
echo ""
node --input-type=module -e "
import { PROVIDER_INTERFACE } from './src/auth/index.js';
import fs from 'node:fs';
var expectedFields = ['name','type','priority','issuer','jwksUri','audience','clientId'];
var expectedMethods = ['isConfigured','init','getRoutes','getLoginUrl','exchangeCode','getUserInfo','getLogoutUrl'];
var pass = 0, fail = 0;
function check(info, cond, expected, actual) {
  if (cond) { console.log('  ✓ ' + info); pass++; }
  else { console.log('  ✗ ' + info); console.log('    Expected: ' + expected); console.log('    Actual:   ' + actual); try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){}; fail++; }
}
var teststring='';

// The registry publishes a contract that every provider must implement.
// If the contract itself is wrong, no provider can ever load correctly.
teststring='Test 3.1.1.1';
console.log('Test 3.1.1.1');
try{
console.log('  Reading PROVIDER_INTERFACE.fields from registry export');
console.log('  The contract must define exactly 7 fields for provider identity and config');
check(teststring+' Contract defines exactly 7 required fields',
  PROVIDER_INTERFACE.fields.length === 7, '7 fields', PROVIDER_INTERFACE.fields.length + ' fields');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.1.2';
console.log('Test 3.1.1.2');
try{
console.log('  Reading PROVIDER_INTERFACE.methods from registry export');
console.log('  The contract must define exactly 7 methods for auth lifecycle');
check(teststring+' Contract defines exactly 7 required methods',
  PROVIDER_INTERFACE.methods.length === 7, '7 methods', PROVIDER_INTERFACE.methods.length + ' methods');

// Each field is a piece of information the registry and middleware need
// to validate tokens and route auth flows. Missing any one means the
// middleware cannot verify tokens from that provider.
for (var [i, f] of expectedFields.entries()) {
  }catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
  teststring='Test 3.1.1.' + (3 + i);
  console.log('Test 3.1.1.' + (3 + i));
  try{
  console.log('  Checking if field \"' + f + '\" exists in the contract');
  console.log('  This field is required for: ' + ({
    name: 'unique provider identification in the registry',
    type: 'protocol detection (oidc vs saml)',
    priority: 'default provider selection when multiple are active',
    issuer: 'JWT iss claim validation — must match token issuer',
    jwksUri: 'public key retrieval for signature verification',
    audience: 'JWT aud claim validation — ensures token is for our API',
    clientId: 'OAuth client identification with the IDP'
  }[f]));
  check(teststring+' Required field present: ' + f, PROVIDER_INTERFACE.fields.includes(f), f + ' in list', 'missing');
}

for (var [i, m] of expectedMethods.entries()) {
  }catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
  teststring='Test 3.1.1.' + (10 + i);
  console.log('Test 3.1.1.' + (10 + i));
  try{
  console.log('  Checking if method \"' + m + '\" exists in the contract');
  console.log('  This method is required for: ' + ({
    isConfigured: 'env var gating — prevents activation without credentials',
    init: 'startup validation and cache warming',
    getRoutes: 'mounting provider-specific Express routes (login, callback, logout)',
    getLoginUrl: 'generating the IDP redirect URL for user login',
    exchangeCode: 'swapping auth code for access tokens after callback',
    getUserInfo: 'retrieving user profile (sub, email, name) from IDP',
    getLogoutUrl: 'generating the IDP logout redirect URL'
  }[m]));
  check(teststring+' Required method present: ' + m, PROVIDER_INTERFACE.methods.includes(m), m + ' in list', 'missing');
}

console.log('');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 1: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 16 - code)); FAIL=$((FAIL + code))
}

function test_group_2 {
divider " Group 2: Dev mode — no providers "
echo ""
echo "  Impact: If these tests fail, developers cannot run the"
echo "  application locally without configuring a full auth provider."
echo "  This blocks all local development and testing workflows."
echo ""
node --input-type=module -e "
import { initRegistry, getProviders, getDefaultProvider, getJwksMap, getIssuers, isAuthEnabled, isAuthRequired, _resetForTesting } from './src/auth/index.js';
import fs from 'node:fs';
_resetForTesting();
delete process.env.MOCK_AUTH_ENABLED;
delete process.env.NODE_ENV;
var pass = 0, fail = 0;
function check(info, cond, expected, actual) {
  if (cond) { console.log('  ✓ ' + info); pass++; }
  else { console.log('  ✗ ' + info); console.log('    Expected: ' + expected); console.log('    Actual:   ' + actual); try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){}; fail++; }
}
var teststring='';

// With no provider env vars set, the registry should initialize
// successfully but with auth disabled. This is the local dev experience.
teststring='Test 3.1.2.1';
console.log('Test 3.1.2.1');
try{
console.log('  Initializing registry with no provider env vars set');
console.log('  In dev mode, the app should start with auth off — not crash');
var result = await initRegistry(() => {});
check(teststring+' App starts without auth when no providers configured',
  result.authEnabled === false, 'authEnabled === false', 'authEnabled === ' + result.authEnabled);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.2.2';
console.log('Test 3.1.2.2');
try{
console.log('  Checking providers map size — should be empty');
check(teststring+' No providers in the registry',
  result.providers.size === 0, '0 providers', result.providers.size + ' providers');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.2.3';
console.log('Test 3.1.2.3');
try{
console.log('  Calling isAuthEnabled() — returns the runtime auth enforcement state');
console.log('  With no providers, this must be false so middleware passes requests through');
check(teststring+' isAuthEnabled() confirms auth is off',
  isAuthEnabled() === false, 'false', String(isAuthEnabled()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.2.4';
console.log('Test 3.1.2.4');
try{
console.log('  Calling isAuthRequired() — reflects NODE_ENV enforcement policy');
console.log('  Without NODE_ENV=production, auth should not be mandatory');
check(teststring+' isAuthRequired() confirms auth is not mandatory',
  isAuthRequired() === false, 'false', String(isAuthRequired()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.2.5';
console.log('Test 3.1.2.5');
try{
console.log('  Calling getProviders() — sorted list of active providers');
check(teststring+' getProviders() returns empty list',
  getProviders().length === 0, 'empty array', getProviders().length + ' providers');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.2.6';
console.log('Test 3.1.2.6');
try{
console.log('  Calling getDefaultProvider() — the highest-priority active provider');
console.log('  With no providers loaded, this must return null (not undefined or throw)');
check(teststring+' getDefaultProvider() returns null',
  getDefaultProvider() === null, 'null', String(getDefaultProvider()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.2.7';
console.log('Test 3.1.2.7');
try{
console.log('  Calling getJwksMap() — maps issuers to their JWKS endpoints');
console.log('  Empty map means the middleware has no keys to validate against');
check(teststring+' getJwksMap() returns empty map',
  getJwksMap().size === 0, 'empty map', getJwksMap().size + ' entries');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.2.8';
console.log('Test 3.1.2.8');
try{
console.log('  Calling getIssuers() — list of trusted token issuers');
console.log('  Empty list means no issuer is trusted — all tokens are rejected if auth is on');
check(teststring+' getIssuers() returns empty list',
  getIssuers().length === 0, 'empty array', getIssuers().length + ' issuers');

console.log('');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 2: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 8 - code)); FAIL=$((FAIL + code))
}

function test_group_3 {
divider " Group 3: Mock provider activation "
echo ""
echo "  Impact: If these tests fail, the test infrastructure is"
echo "  broken. No automated auth testing can run without external"
echo "  IDP credentials, slowing every dev cycle."
echo ""
MOCK_AUTH_ENABLED=true node --input-type=module -e "
import { initRegistry, getProviders, getProvider, getDefaultProvider, getJwksMap, getIssuers, isAuthEnabled, _resetForTesting } from './src/auth/index.js';
import fs from 'node:fs';
_resetForTesting();
var pass = 0, fail = 0;
function check(info, cond, expected, actual) {
  if (cond) { console.log('  ✓ ' + info); pass++; }
  else { console.log('  ✗ ' + info); console.log('    Expected: ' + expected); console.log('    Actual:   ' + actual); try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){}; fail++; }
}
var teststring='';
var result = await initRegistry(() => {});

teststring='Test 3.1.3.1';
console.log('Test 3.1.3.1');
try{
console.log('  MOCK_AUTH_ENABLED=true set — registry should discover and load mock.js');
check(teststring+' Auth enabled with provider configured',
  result.authEnabled === true, 'true', String(result.authEnabled));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.2';
console.log('Test 3.1.3.2');
try{
console.log('  Checking providers map — should contain exactly 1 provider');
check(teststring+' Exactly 1 provider loaded',
  result.providers.size === 1, '1', String(result.providers.size));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.3';
console.log('Test 3.1.3.3');
try{
console.log('  isAuthEnabled() should now be true — middleware will enforce tokens');
check(teststring+' Auth enforcement is active',
  isAuthEnabled() === true, 'true', String(isAuthEnabled()));

var mock = getProvider('mock');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.4';
console.log('Test 3.1.3.4');
try{
console.log('  Calling getProvider(\"mock\") — lookup by registered name');
check(teststring+' Provider retrievable by name', mock !== null, 'non-null', String(mock));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.5';
console.log('Test 3.1.3.5');
try{
console.log('  Verifying the returned provider name matches what was registered');
check(teststring+' Provider name matches', mock?.name === 'mock', 'mock', String(mock?.name));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.6';
console.log('Test 3.1.3.6');
try{
console.log('  Provider type determines which protocol the middleware uses');
check(teststring+' Provider type is OIDC', mock?.type === 'oidc', 'oidc', String(mock?.type));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.7';
console.log('Test 3.1.3.7');
try{
console.log('  The issuer URL is compared against the iss claim in every JWT');
console.log('  A mismatch means all tokens from this provider are rejected');
check(teststring+' Issuer URL set', mock?.issuer === 'https://mock-auth.test/', 'https://mock-auth.test/', String(mock?.issuer));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.8';
console.log('Test 3.1.3.8');
try{
console.log('  The JWKS URI is where the middleware fetches public keys to verify signatures');
check(teststring+' JWKS URI set', mock?.jwksUri === 'https://mock-auth.test/.well-known/jwks.json',
  'https://mock-auth.test/.well-known/jwks.json', String(mock?.jwksUri));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.9';
console.log('Test 3.1.3.9');
try{
console.log('  The audience must match the aud claim — ensures token was issued for our API');
check(teststring+' Audience set', mock?.audience === 'https://linkedin-agent-api',
  'https://linkedin-agent-api', String(mock?.audience));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.10';
console.log('Test 3.1.3.10');
try{
console.log('  Client ID identifies our application to the IDP during OAuth flows');
check(teststring+' Client ID set', mock?.clientId === 'mock_client_001', 'mock_client_001', String(mock?.clientId));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.11';
console.log('Test 3.1.3.11');
try{
console.log('  Priority determines which provider is the default when multiple are active');
console.log('  Mock uses 999 (low priority) so real providers always take precedence');
check(teststring+' Priority is 999', mock?.priority === 999, '999', String(mock?.priority));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.12';
console.log('Test 3.1.3.12');
try{
console.log('  getDefaultProvider() returns the highest-priority (lowest number) provider');
check(teststring+' Default provider is mock', getDefaultProvider()?.name === 'mock', 'mock', String(getDefaultProvider()?.name));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.13';
console.log('Test 3.1.3.13');
try{
console.log('  getIssuers() builds the allowlist the middleware checks tokens against');
check(teststring+' Issuers list includes mock', getIssuers().includes('https://mock-auth.test/'),
  'includes mock issuer', JSON.stringify(getIssuers()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.14';
console.log('Test 3.1.3.14');
try{
console.log('  getJwksMap() maps each issuer to its JWKS endpoint for key retrieval');
check(teststring+' JWKS map contains mock issuer', getJwksMap().has('https://mock-auth.test/'),
  'has mock issuer', JSON.stringify([...getJwksMap().keys()]));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.3.15';
console.log('Test 3.1.3.15');
try{
console.log('  Looking up a provider name that was never registered — must return null');
check(teststring+' Unknown provider returns null', getProvider('nonexistent') === null, 'null', String(getProvider('nonexistent')));

console.log('');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 3: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 15 - code)); FAIL=$((FAIL + code))
}

function test_group_4 {
divider " Group 4: Provider method validation "
echo ""
echo "  Impact: If these tests fail, login, token exchange,"
echo "  user identity retrieval, or logout do not work."
echo "  The dashboard is inaccessible to all customers."
echo ""
MOCK_AUTH_ENABLED=true node --input-type=module -e "
import { initRegistry, getProvider, _resetForTesting } from './src/auth/index.js';
import fs from 'node:fs';
_resetForTesting();
await initRegistry(() => {});
var mock = getProvider('mock');
var pass = 0, fail = 0;
function check(info, cond, expected, actual) {
  if (cond) { console.log('  ✓ ' + info); pass++; }
  else { console.log('  ✗ ' + info); console.log('    Expected: ' + expected); console.log('    Actual:   ' + actual); try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){}; fail++; }
}
var teststring='';

// exchangeCode simulates what happens after Auth0 redirects back with an auth code.
// The provider swaps that code for tokens via the IDP's token endpoint.
teststring='Test 3.1.4.1';
console.log('Test 3.1.4.1');
try{
console.log('  Calling mock.exchangeCode(\"test_code_123\")');
console.log('  This simulates the OAuth code→token exchange after login callback');
var tokens = await mock.exchangeCode('test_code_123');
check(teststring+' Token exchange returns an access token',
  typeof tokens.accessToken === 'string' && tokens.accessToken.startsWith('mock_access_'),
  'string starting with mock_access_', String(tokens.accessToken?.substring(0, 20)));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.2';
console.log('Test 3.1.4.2');
try{
console.log('  The ID token contains identity claims — used server-side for validation');
check(teststring+' Token exchange returns an ID token',
  typeof tokens.idToken === 'string', 'string', typeof tokens.idToken);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.3';
console.log('Test 3.1.4.3');
try{
console.log('  expiresIn tells the session manager when to refresh or force re-login');
check(teststring+' Token exchange returns expiry duration',
  tokens.expiresIn === 86400, '86400 (24 hours)', String(tokens.expiresIn));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.4';
console.log('Test 3.1.4.4');
try{
console.log('  tokenType must be Bearer — the middleware expects this in the Authorization header');
check(teststring+' Token exchange returns type Bearer',
  tokens.tokenType === 'Bearer', 'Bearer', String(tokens.tokenType));

// getUserInfo retrieves the user profile from the IDP. This data
// populates req.user on every authenticated request.
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.5';
console.log('Test 3.1.4.5');
try{
console.log('  Calling mock.getUserInfo() with the access token');
console.log('  This retrieves the user profile the dashboard displays');
var user = await mock.getUserInfo(tokens.accessToken);
check(teststring+' User profile contains a unique subject ID',
  user.sub === 'mock_user_001', 'mock_user_001', String(user.sub));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.6';
console.log('Test 3.1.4.6');
try{
console.log('  Display name is shown in the dashboard header after login');
check(teststring+' User profile contains a display name',
  user.name === 'Test User', 'Test User', String(user.name));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.7';
console.log('Test 3.1.4.7');
try{
console.log('  Email is used for user identification and notification');
check(teststring+' User profile contains an email',
  user.email === 'test@example.com', 'test@example.com', String(user.email));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.8';
console.log('Test 3.1.4.8');
try{
console.log('  emailVerified flag — unverified emails should not grant full access');
check(teststring+' User profile confirms email verified',
  user.emailVerified === true, 'true', String(user.emailVerified));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.9';
console.log('Test 3.1.4.9');
try{
console.log('  provider field identifies which IDP authenticated this user');
check(teststring+' User profile identifies auth provider',
  user.provider === 'mock', 'mock', String(user.provider));

// getLoginUrl generates the redirect URL that sends users to the IDP login page.
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.10';
console.log('Test 3.1.4.10');
try{
console.log('  Calling mock.getLoginUrl(\"state_abc\")');
console.log('  The state parameter is the CSRF token that prevents auth hijacking');
var loginUrl = mock.getLoginUrl('state_abc');
check(teststring+' Login URL includes the auth route',
  loginUrl.includes('/auth/mock/login'), 'contains /auth/mock/login', loginUrl);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.11';
console.log('Test 3.1.4.11');
try{
console.log('  The state param must appear in the URL so it round-trips through the IDP');
check(teststring+' Login URL includes CSRF state',
  loginUrl.includes('state_abc'), 'contains state_abc', loginUrl);

// getLogoutUrl generates the redirect that clears the IDP session.
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.12';
console.log('Test 3.1.4.12');
try{
console.log('  Calling mock.getLogoutUrl(\"https://example.com\")');
console.log('  After logout, the user should land on the specified return page');
var logoutUrl = mock.getLogoutUrl('https://example.com');
check(teststring+' Logout URL includes logout route',
  logoutUrl.includes('/auth/mock/logout'), 'contains /auth/mock/logout', logoutUrl);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.4.13';
console.log('Test 3.1.4.13');
try{
console.log('  The returnTo param tells the IDP where to redirect after clearing the session');
check(teststring+' Logout URL includes return destination',
  logoutUrl.includes('example.com'), 'contains example.com', logoutUrl);

console.log('');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 4: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 13 - code)); FAIL=$((FAIL + code))
}

function test_group_5 {
divider " Group 5: Production mode enforcement "
echo ""
echo "  Impact: If these tests fail, the application could deploy"
echo "  to production with no authentication. Every API endpoint"
echo "  and all customer data would be publicly accessible."
echo ""
node --input-type=module -e "
import { initRegistry, isAuthRequired, _resetForTesting } from './src/auth/index.js';
import fs from 'node:fs';
var pass = 0, fail = 0;
function check(info, cond, expected, actual) {
  if (cond) { console.log('  ✓ ' + info); pass++; }
  else { console.log('  ✗ ' + info); console.log('    Expected: ' + expected); console.log('    Actual:   ' + actual); try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){}; fail++; }
}
var teststring='';

// In production, starting without auth must be fatal. This is the single
// most important safety check in the entire auth layer.
teststring='Test 3.1.5.1';
console.log('Test 3.1.5.1');
try{
console.log('  Setting NODE_ENV=production, clearing all provider env vars');
console.log('  Calling initRegistry() — this MUST throw, not succeed silently');
_resetForTesting();
process.env.NODE_ENV = 'production';
delete process.env.MOCK_AUTH_ENABLED;
var threw = false, errMsg = '';
try { await initRegistry(() => {}); }
catch (e) { threw = true; errMsg = e.message; }
check(teststring+' Server refuses to start without auth in production',
  threw, 'initRegistry() throws', 'initRegistry() succeeded silently');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.5.2';
console.log('Test 3.1.5.2');
try{
console.log('  The error message should tell the operator exactly what to configure');
console.log('  Checking for \"No auth providers configured\" in the error');
check(teststring+' Error message names the problem',
  errMsg.includes('No auth providers configured'), 'mentions missing providers', errMsg.substring(0, 60));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.5.3';
console.log('Test 3.1.5.3');
try{
console.log('  The error should mention specific env vars so the fix is obvious');
check(teststring+' Error tells operator what env vars to set',
  errMsg.includes('AUTH0_DOMAIN') || errMsg.includes('WORKOS_API_KEY'),
  'mentions AUTH0_DOMAIN or WORKOS_API_KEY', errMsg.substring(0, 60));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.5.4';
console.log('Test 3.1.5.4');
try{
console.log('  isAuthRequired() reflects the NODE_ENV policy independent of provider state');
check(teststring+' Registry knows auth is mandatory',
  isAuthRequired(), 'true', String(isAuthRequired()));

// The mock provider deliberately blocks itself in production.
// This prevents test infrastructure from accidentally satisfying
// the production auth requirement.
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.5.5';
console.log('Test 3.1.5.5');
try{
console.log('  Setting MOCK_AUTH_ENABLED=true in production');
console.log('  The mock provider returns false from isConfigured() when NODE_ENV=production');
console.log('  This means production still has zero providers — startup must fail');
_resetForTesting();
process.env.NODE_ENV = 'production';
process.env.MOCK_AUTH_ENABLED = 'true';
var threw2 = false;
try { await initRegistry(() => {}); }
catch { threw2 = true; }
check(teststring+' Mock provider refuses to load in production',
  threw2, 'mock blocks itself → startup fails', 'mock loaded in production');

delete process.env.NODE_ENV;
delete process.env.MOCK_AUTH_ENABLED;
console.log('');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 5: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 5 - code)); FAIL=$((FAIL + code))
}

function test_group_6 {
divider " Group 6: Shutdown and reset "
echo ""
echo "  Impact: If these tests fail, the server cannot restart"
echo "  cleanly. Stale auth state persists across restarts,"
echo "  causing lockouts or incorrect access grants."
echo ""
MOCK_AUTH_ENABLED=true node --input-type=module -e "
import { initRegistry, getProviders, isAuthEnabled, shutdownRegistry, _resetForTesting } from './src/auth/index.js';
import fs from 'node:fs';
var pass = 0, fail = 0;
function check(info, cond, expected, actual) {
  if (cond) { console.log('  ✓ ' + info); pass++; }
  else { console.log('  ✗ ' + info); console.log('    Expected: ' + expected); console.log('    Actual:   ' + actual); try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){}; fail++; }
}
var teststring='';

_resetForTesting();
await initRegistry(() => {});

teststring='Test 3.1.6.1';
console.log('Test 3.1.6.1');
try{
console.log('  Confirming mock provider is loaded before we test shutdown');
check(teststring+' Provider loaded before shutdown',
  getProviders().length === 1, '1 provider', getProviders().length + ' providers');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.6.2';
console.log('Test 3.1.6.2');
try{
console.log('  Calling shutdownRegistry() — should clear all providers');
console.log('  After shutdown, no provider should be active and no keys cached');
await shutdownRegistry(() => {});
check(teststring+' All providers cleared after shutdown',
  getProviders().length === 0, '0 providers', getProviders().length + ' providers');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.6.3';
console.log('Test 3.1.6.3');
try{
console.log('  isAuthEnabled() should now be false — no providers means no enforcement');
check(teststring+' Auth disabled after shutdown',
  isAuthEnabled() === false, 'false', String(isAuthEnabled()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.6.4';
console.log('Test 3.1.6.4');
try{
console.log('  Calling initRegistry() again after shutdown');
console.log('  The registry should re-discover and reload providers from disk');
var r = await initRegistry(() => {});
check(teststring+' Registry re-initializes after shutdown',
  r.authEnabled === true, 'true', String(r.authEnabled));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.6.5';
console.log('Test 3.1.6.5');
try{
console.log('  Provider should be available again after re-init');
check(teststring+' Provider reloaded after re-init',
  getProviders().length === 1, '1 provider', getProviders().length + ' providers');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.6.6';
console.log('Test 3.1.6.6');
try{
console.log('  Calling initRegistry() a second time without shutdown');
console.log('  Should return the cached result — not re-scan the directory');
var r2 = await initRegistry(() => {});
check(teststring+' Double init returns cached result',
  r.providers === r2.providers, 'same Map reference', 'different reference');

console.log('');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 6: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 6 - code)); FAIL=$((FAIL + code))
}

function test_group_7 {
divider " Group 7: Env var gating "
echo ""
echo "  Impact: If these tests fail, providers activate or"
echo "  deactivate unpredictably. A misconfigured deployment"
echo "  could silently run without auth or with the wrong provider."
echo ""
node --input-type=module -e "
import { initRegistry, isAuthEnabled, _resetForTesting } from './src/auth/index.js';
import fs from 'node:fs';
var pass = 0, fail = 0;
function check(info, cond, expected, actual) {
  if (cond) { console.log('  ✓ ' + info); pass++; }
  else { console.log('  ✗ ' + info); console.log('    Expected: ' + expected); console.log('    Actual:   ' + actual); try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){}; fail++; }
}
var teststring='';

// mock.js exists on disk but should only activate when MOCK_AUTH_ENABLED=true.
// File presence alone must never trigger activation.
teststring='Test 3.1.7.1';
console.log('Test 3.1.7.1');
try{
console.log('  mock.js exists in providers/ but MOCK_AUTH_ENABLED is not set');
console.log('  The file should be discovered but reported as inactive');
_resetForTesting();
delete process.env.MOCK_AUTH_ENABLED;
var r1 = await initRegistry(() => {});
check(teststring+' Provider file exists but stays inactive without env var',
  !isAuthEnabled(), 'auth disabled', 'auth enabled');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.7.2';
console.log('Test 3.1.7.2');
try{
console.log('  Checking the discovery result status for mock.js');
console.log('  Should be \"inactive\" (not \"error\" or \"ready\")');
check(teststring+' Discovery reports provider as inactive',
  r1.results[0]?.status === 'inactive', 'inactive', String(r1.results[0]?.status));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.7.3';
console.log('Test 3.1.7.3');
try{
console.log('  Setting MOCK_AUTH_ENABLED=false — explicit false should not activate');
_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'false';
await initRegistry(() => {});
check(teststring+' Provider stays inactive with env var set to false',
  !isAuthEnabled(), 'auth disabled', 'auth enabled');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.1.7.4';
console.log('Test 3.1.7.4');
try{
console.log('  Setting MOCK_AUTH_ENABLED=true — now the provider should activate');
_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});
check(teststring+' Provider activates with env var set to true',
  isAuthEnabled(), 'auth enabled', 'auth disabled');

delete process.env.MOCK_AUTH_ENABLED;
console.log('');
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 7: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS + 4 - code)); FAIL=$((FAIL + code))
}

######## MAIN
if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> group 1 (interface contract)" x && test_group_1
  read -p "<Enter> group 2 (dev mode)" x && test_group_2
  read -p "<Enter> group 3 (mock activation)" x && test_group_3
  read -p "<Enter> group 4 (provider methods)" x && test_group_4
  read -p "<Enter> group 5 (production enforcement)" x && test_group_5
  read -p "<Enter> group 6 (shutdown)" x && test_group_6
  read -p "<Enter> group 7 (env var gating)" x && test_group_7
else test_group_1;test_group_2;test_group_3;test_group_4;test_group_5;test_group_6;test_group_7; fi
divider
echo ""
echo "  ═══════════════════════════════════════"
echo "  Results:  ${PASS} PASSED  ${FAIL} FAILED"
echo "  ═══════════════════════════════════════"
echo ""
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

