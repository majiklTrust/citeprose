#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 3 — JWT Verification + Auth Middleware Test Suite
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
echo "  Phase 3 Step 3 — JWT Verification + Middleware Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/jwt-verifier.js" ]; then echo "  ERROR: src/auth/jwt-verifier.js not found."; exit 1; fi
if [ ! -f "src/auth/middleware.js" ]; then echo "  ERROR: src/auth/middleware.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi
echo -n "  jose dependency check: "
node --input-type=module -e "import 'jose'; console.log('installed');" 2>/dev/null
if [ $? -ne 0 ]; then echo "  ERROR: jose not installed. Run: npm install jose"; exit 1; fi

function test_group_1 {
divider " Group 1: JWT verifier — valid tokens "
echo ""
echo "  Impact: If these tests fail, no user can authenticate."
echo "  Every API request is rejected even with a valid login."
echo "  The entire platform is inaccessible."
echo ""
node --input-type=module -e "
import{createTestJWKS}from'./src/auth/_test-helper.js';
import{verifyToken,clearJwksCache}from'./src/auth/jwt-verifier.js';
import fs from 'node:fs';
var helper=await createTestJWKS();
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
try{
teststring='Test 3.3.1.1';
console.log('Test 3.3.1.1');
try{
console.log('  Signing a JWT with sub=user_001, email=user@test.com, name=Test User');
console.log('  Using local RSA key pair — simulates what Auth0 does in production');
var token=await helper.signToken({sub:'user_001',email:'user@test.com',name:'Test User'});
console.log('  Token generated ('+token.length+' chars). Calling verifyToken()...');
console.log('  verifyToken fetches JWKS from local server, finds matching key by kid,');
console.log('  verifies RSA signature, checks iss/aud/exp claims');
var payload=await verifyToken(token,helper.issuer,helper.jwksUri,helper.audience);
check(teststring+' Valid token accepted by verifier',!!payload,'decoded payload','null/undefined');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.2';
console.log('Test 3.3.1.2');
try{
console.log('  Checking payload.sub — the user\\'s unique identifier');
console.log('  This becomes req.user.sub in the middleware');
check(teststring+' Payload contains user identity (sub)',payload.sub==='user_001','user_001',String(payload.sub));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.3';
console.log('Test 3.3.1.3');
try{
console.log('  Checking payload.email — used for display and notifications');
check(teststring+' Payload contains email',payload.email==='user@test.com','user@test.com',String(payload.email));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.4';
console.log('Test 3.3.1.4');
try{
console.log('  Checking payload.name — displayed in dashboard header');
check(teststring+' Payload contains name',payload.name==='Test User','Test User',String(payload.name));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.5';
console.log('Test 3.3.1.5');
try{
console.log('  Checking payload.iss — must match the issuer we passed to verifyToken');
console.log('  A mismatch here means the token was issued by a different provider');
check(teststring+' Payload issuer matches',payload.iss===helper.issuer,helper.issuer,String(payload.iss));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.6';
console.log('Test 3.3.1.6');
try{
console.log('  Checking payload.aud — must match our API audience');
console.log('  This ensures the token was issued specifically for our API, not another');
check(teststring+' Payload audience matches',payload.aud===helper.audience,helper.audience,String(payload.aud));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.7';
console.log('Test 3.3.1.7');
try{
console.log('  Checking payload.exp exists — tokens must expire');
console.log('  Without expiration, a stolen token grants permanent access');
check(teststring+' Payload has expiration',typeof payload.exp==='number','number',typeof payload.exp);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.8';
console.log('Test 3.3.1.8');
try{
console.log('  Checking payload.iat — issued-at timestamp for age tracking');
check(teststring+' Payload has issued-at',typeof payload.iat==='number','number',typeof payload.iat);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.9';
console.log('Test 3.3.1.9');
try{
console.log('  Signing a token with custom claims: role=admin, orgId=org_123');
console.log('  Custom claims must survive verification — they carry authorization data');
var token2=await helper.signToken({sub:'admin',role:'admin',orgId:'org_123'});
var payload2=await verifyToken(token2,helper.issuer,helper.jwksUri,helper.audience);
check(teststring+' Custom claim preserved (role)',payload2.role==='admin','admin',String(payload2.role));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.10';
console.log('Test 3.3.1.10');
try{
check(teststring+' Custom claim preserved (orgId)',payload2.orgId==='org_123','org_123',String(payload2.orgId));
}finally{await helper.close();clearJwksCache()}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 1: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+10-code)); FAIL=$((FAIL+code))
}

function test_group_2 {
divider " Group 2: JWT verifier — invalid tokens rejected "
echo ""
echo "  Impact: If these tests fail, forged, expired, or tampered"
echo "  tokens are accepted. An attacker fabricates credentials"
echo "  and accesses any user's data or LinkedIn account."
echo ""
node --input-type=module -e "
import{createTestJWKS}from'./src/auth/_test-helper.js';
import{verifyToken,clearJwksCache}from'./src/auth/jwt-verifier.js';
import fs from 'node:fs';
var helper=await createTestJWKS();
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
async function expectError(info,fn,code){
  try{await fn();check(info,false,'throws '+code,'succeeded')}
  catch(e){check(info,e.message===code,code,e.message)}}
try{
teststring='Test 3.3.2.1';
console.log('Test 3.3.2.1');
try{
console.log('  Passing null as token — simulates missing Authorization header');
await expectError('Null token rejected',()=>verifyToken(null,helper.issuer,helper.jwksUri,helper.audience),'TOKEN_MISSING');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.2';
console.log('Test 3.3.2.2');
try{
console.log('  Passing empty string — header present but value extracted as blank');
await expectError('Empty string rejected',()=>verifyToken('',helper.issuer,helper.jwksUri,helper.audience),'TOKEN_MISSING');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.3';
console.log('Test 3.3.2.3');
try{
console.log('  Passing undefined — code path where token variable is never assigned');
await expectError('Undefined rejected',()=>verifyToken(undefined,helper.issuer,helper.jwksUri,helper.audience),'TOKEN_MISSING');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.4';
console.log('Test 3.3.2.4');
try{
console.log('  Passing \"not.a.jwt\" — has 3 dot-separated parts but not base64url encoded');
console.log('  The verifier should fail during decoding, not during signature check');
await expectError('Random string rejected',()=>verifyToken('not.a.jwt',helper.issuer,helper.jwksUri,helper.audience),'TOKEN_INVALID');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.5';
console.log('Test 3.3.2.5');
try{
console.log('  Passing \"justonepart\" — JWTs require exactly 3 dot-separated segments');
await expectError('Single segment rejected',()=>verifyToken('justonepart',helper.issuer,helper.jwksUri,helper.audience),'TOKEN_INVALID');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.6';
console.log('Test 3.3.2.6');
try{
console.log('  Using helper.fabricateToken() — correct header+payload structure but');
console.log('  signature is random bytes, not signed with any known key');
console.log('  This simulates an attacker constructing a token from scratch');
var fake=helper.fabricateToken();
await expectError('Fabricated signature rejected',()=>verifyToken(fake,helper.issuer,helper.jwksUri,helper.audience),'TOKEN_SIGNATURE_INVALID');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.7';
console.log('Test 3.3.2.7');
try{
console.log('  Using signExpiredToken() — valid signature but exp is in the past');
console.log('  Expired tokens must be rejected even if the signature is valid');
var expired=await helper.signExpiredToken();
await expectError('Expired token rejected',()=>verifyToken(expired,helper.issuer,helper.jwksUri,helper.audience),'TOKEN_EXPIRED');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.8';
console.log('Test 3.3.2.8');
try{
console.log('  Using signWrongIssuerToken() — signed by our key but iss claim is wrong');
console.log('  This simulates a token from a different Auth0 tenant');
var wrongIss=await helper.signWrongIssuerToken();
await expectError('Wrong issuer rejected',()=>verifyToken(wrongIss,helper.issuer,helper.jwksUri,helper.audience),'TOKEN_INVALID_ISSUER');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.9';
console.log('Test 3.3.2.9');
try{
console.log('  Using signWrongAudienceToken() — aud claim is for a different API');
console.log('  A token for \"https://other-api\" must not grant access to our API');
var wrongAud=await helper.signWrongAudienceToken();
await expectError('Wrong audience rejected',()=>verifyToken(wrongAud,helper.issuer,helper.jwksUri,helper.audience),'TOKEN_INVALID_AUDIENCE');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.10';
console.log('Test 3.3.2.10');
try{
console.log('  Passing null as issuer config — simulates misconfigured registry');
var vt=await helper.signToken();
await expectError('Null issuer config rejected',()=>verifyToken(vt,null,helper.jwksUri,helper.audience),'VERIFIER_MISCONFIGURED');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.11';
console.log('Test 3.3.2.11');
try{
console.log('  Passing null as JWKS URI — verifier cannot fetch signing keys');
await expectError('Null JWKS URI rejected',()=>verifyToken(vt,helper.issuer,null,helper.audience),'VERIFIER_MISCONFIGURED');
}finally{await helper.close();clearJwksCache()}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 2: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+11-code)); FAIL=$((FAIL+code))
}

function test_group_3 {
divider " Group 3: Middleware — requireAuth blocks unauthorized "
echo ""
echo "  Impact: If these tests fail, API endpoints are accessible"
echo "  without authentication. Anyone who discovers the URL can"
echo "  read data, publish to LinkedIn, and exhaust API credits."
echo ""
node --input-type=module -e "
import{createTestJWKS}from'./src/auth/_test-helper.js';
import{clearJwksCache}from'./src/auth/jwt-verifier.js';
import{_resetForTesting,initRegistry,getProviders,_patchSnapshotForTesting}from'./src/auth/index.js';
import{createAuthMiddleware}from'./src/auth/middleware.js';
import fs from 'node:fs';
var helper=await createTestJWKS({issuer:'https://mock-auth.test/'});
_resetForTesting();process.env.MOCK_AUTH_ENABLED='true';await initRegistry(()=>{});
var mp=getProviders().find(p=>p.name==='mock');
Object.defineProperty(mp,'jwksUri',{get:()=>helper.jwksUri,configurable:true});
Object.defineProperty(mp,'audience',{get:()=>helper.audience,configurable:true});
_patchSnapshotForTesting('mock',{jwksUri:helper.jwksUri,audience:helper.audience});
var logs=[];const{requireAuth}=createAuthMiddleware((l,a,d)=>logs.push({l,a,d}));
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
function mReq(h={}){return{headers:h,path:'/api/test'}}
function mRes(){let _s=null,_j=null;return{status(s){_s=s;return this},json(j){_j=j;return this},getStatus(){return _s},getJson(){return _j}}}
try{
teststring='Test 3.3.3.1';
console.log('Test 3.3.3.1');
try{
console.log('  Sending request with valid Bearer token');
console.log('  The middleware should call next() and attach req.user');
var token=await helper.signToken({sub:'user1',email:'u@test.com'});
var req1=mReq({authorization:'Bearer '+token});var res1=mRes();var nc=false;
await requireAuth(req1,res1,()=>{nc=true});
check(teststring+' Valid token — request passes through',nc,'next() called','blocked');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.2';
console.log('Test 3.3.3.2');
try{
console.log('  Checking req.user.sub — middleware must extract identity from JWT');
check(teststring+' User identity attached',req1.user?.sub==='user1','user1',String(req1.user?.sub));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.3';
console.log('Test 3.3.3.3');
try{
console.log('  Checking req.user.email — from JWT payload');
check(teststring+' User email attached',req1.user?.email==='u@test.com','u@test.com',String(req1.user?.email));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.4';
console.log('Test 3.3.3.4');
try{
console.log('  Checking req.authProvider — identifies which provider validated this token');
check(teststring+' Auth provider identified',req1.authProvider==='mock','mock',String(req1.authProvider));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.5';
console.log('Test 3.3.3.5');
try{
console.log('  Sending request with NO Authorization header');
var req2=mReq({});var res2=mRes();nc=false;
await requireAuth(req2,res2,()=>{nc=true});
check(teststring+' No header — blocked',!nc,'blocked','allowed');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.6';
console.log('Test 3.3.3.6');
try{
check(teststring+' No header — returns 401',res2.getStatus()===401,'401',String(res2.getStatus()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.7';
console.log('Test 3.3.3.7');
try{
console.log('  Error message should tell user to authenticate, not reveal internals');
check(teststring+' Error is user-friendly',res2.getJson()?.error==='Authentication required.','Authentication required.',res2.getJson()?.error);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.8';
console.log('Test 3.3.3.8');
try{
console.log('  Sending \"NotBearer token\" — wrong scheme name');
var req3=mReq({authorization:'NotBearer token'});var res3=mRes();nc=false;
await requireAuth(req3,res3,()=>{nc=true});
check(teststring+' Malformed header — blocked',!nc,'blocked','allowed');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.9';
console.log('Test 3.3.3.9');
try{
check(teststring+' Malformed — returns 401',res3.getStatus()===401,'401',String(res3.getStatus()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.10';
console.log('Test 3.3.3.10');
try{
check(teststring+' Malformed — descriptive message',res3.getJson()?.error==='Invalid authorization header format.','Invalid authorization header format.',res3.getJson()?.error);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.11';
console.log('Test 3.3.3.11');
try{
console.log('  Sending an expired token — valid signature but past exp claim');
var expired=await helper.signExpiredToken();
var req4=mReq({authorization:'Bearer '+expired});var res4=mRes();nc=false;
await requireAuth(req4,res4,()=>{nc=true});
check(teststring+' Expired — blocked',!nc,'blocked','allowed');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.12';
console.log('Test 3.3.3.12');
try{
check(teststring+' Expired — returns 401',res4.getStatus()===401,'401',String(res4.getStatus()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.13';
console.log('Test 3.3.3.13');
try{
console.log('  Expired token message should tell user to log in again');
check(teststring+' Expired — re-login message',res4.getJson()?.error==='Token expired. Please log in again.','Token expired. Please log in again.',res4.getJson()?.error);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.14';
console.log('Test 3.3.3.14');
try{
console.log('  Sending token with fabricated (random) signature');
var fake=helper.fabricateToken();
var req5=mReq({authorization:'Bearer '+fake});var res5=mRes();nc=false;
await requireAuth(req5,res5,()=>{nc=true});
check(teststring+' Forged — blocked',!nc,'blocked','allowed');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.15';
console.log('Test 3.3.3.15');
try{
check(teststring+' Forged — returns 401',res5.getStatus()===401,'401',String(res5.getStatus()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.16';
console.log('Test 3.3.3.16');
try{
console.log('  Forged token message must be generic — not reveal why it failed');
check(teststring+' Forged — generic message',res5.getJson()?.error==='Invalid token.','Invalid token.',res5.getJson()?.error);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.17';
console.log('Test 3.3.3.17');
try{
console.log('  Sending token with issuer not in our registry');
console.log('  This simulates a token from an unregistered IDP');
var wrongIss=await helper.signToken({},{issuer:'https://unknown.com/'});
var req6=mReq({authorization:'Bearer '+wrongIss});var res6=mRes();nc=false;
await requireAuth(req6,res6,()=>{nc=true});
check(teststring+' Unknown issuer — blocked',!nc,'blocked','allowed');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.18';
console.log('Test 3.3.3.18');
try{
check(teststring+' Unknown issuer — returns 401',res6.getStatus()===401,'401',String(res6.getStatus()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.19';
console.log('Test 3.3.3.19');
try{
console.log('  Message must not reveal which issuers ARE trusted');
check(teststring+' Unknown issuer — safe message',res6.getJson()?.error==='Token issuer not recognized.','Token issuer not recognized.',res6.getJson()?.error);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.20';
console.log('Test 3.3.3.20');
try{
console.log('  Sending complete garbage as Bearer value');
var req7=mReq({authorization:'Bearer totalnonsense'});var res7=mRes();nc=false;
await requireAuth(req7,res7,()=>{nc=true});
check(teststring+' Garbage — blocked',!nc,'blocked','allowed');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.21';
console.log('Test 3.3.3.21');
try{
check(teststring+' Garbage — returns 401',res7.getStatus()===401,'401',String(res7.getStatus()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.22';
console.log('Test 3.3.3.22');
try{
console.log('  Verifying no error response contains stack traces, jose errors, or file paths');
console.log('  Checking all 6 error responses from tests above');
var allResponses=[res2,res3,res4,res5,res6,res7];
var leakFound=false;
for(var r of allResponses){const j=r.getJson();if(j?.stack||j?.detail||j?.code)leakFound=true}
check(teststring+' No internal details leaked in any error response',!leakFound,'no stack/detail/code','leak found');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.23';
console.log('Test 3.3.3.23');
try{
console.log('  Additional check: no response body contains \"jose\" or \".js:\"');
var joseLeaked=false;
for(var r of allResponses){const s=JSON.stringify(r.getJson()||{});if(s.includes('jose')||s.includes('.js:'))joseLeaked=true}
check(teststring+' No jose library references in responses',!joseLeaked,'no jose refs','jose reference found');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.24';
console.log('Test 3.3.3.24');
try{
var pathLeaked=false;
for(var r of allResponses){const s=JSON.stringify(r.getJson()||{});if(s.includes('/src/')||s.includes('node_modules'))pathLeaked=true}
check(teststring+' No file paths in responses',!pathLeaked,'no paths','path found');
}finally{await helper.close();clearJwksCache();delete process.env.MOCK_AUTH_ENABLED}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 3: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+24-code)); FAIL=$((FAIL+code))
}

function test_group_4 {
divider " Group 4: Middleware — dev mode passthrough "
echo ""
echo "  Impact: If these tests fail, developers cannot test API"
echo "  endpoints locally without Auth0 credentials. Every code"
echo "  change requires full auth setup — destroying velocity."
echo ""
node --input-type=module -e "
import{_resetForTesting,initRegistry}from'./src/auth/index.js';
import{createAuthMiddleware}from'./src/auth/middleware.js';
import fs from 'node:fs';
_resetForTesting();delete process.env.MOCK_AUTH_ENABLED;delete process.env.AUTH0_DOMAIN;
await initRegistry(()=>{});
const{requireAuth}=createAuthMiddleware(()=>{});
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
function mReq(h={}){return{headers:h,path:'/api/test'}}
function mRes(){let _s=null,_j=null;return{status(s){_s=s;return this},json(j){_j=j;return this},getStatus(){return _s},getJson(){return _j}}}

teststring='Test 3.3.4.1';
console.log('Test 3.3.4.1');
try{
console.log('  No providers configured — this simulates local dev environment');
console.log('  Sending request without Authorization header');
console.log('  Middleware should call next() — not block the request');
var req1=mReq({});var res1=mRes();var nc=false;
await requireAuth(req1,res1,()=>{nc=true});
check(teststring+' Request passes through in dev mode',nc,'next() called','blocked');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.2';
console.log('Test 3.3.4.2');
try{
console.log('  req.user should be null — no identity assumed without a token');
check(teststring+' User is null',req1.user===null,'null',String(req1.user));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.3';
console.log('Test 3.3.4.3');
try{
console.log('  req.authSkipped flag lets downstream code know auth was not enforced');
check(teststring+' authSkipped flag set',req1.authSkipped===true,'true',String(req1.authSkipped));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.4';
console.log('Test 3.3.4.4');
try{
console.log('  Sending a garbage token in dev mode — should still pass through');
console.log('  Dev mode skips ALL token validation, not just missing tokens');
var req2=mReq({authorization:'Bearer garbage'});var res2=mRes();nc=false;
await requireAuth(req2,res2,()=>{nc=true});
check(teststring+' Bad token passes in dev mode',nc,'next() called','blocked');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.5';
console.log('Test 3.3.4.5');
try{
check(teststring+' authSkipped set with bad token',req2.authSkipped===true,'true',String(req2.authSkipped));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 4: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+5-code)); FAIL=$((FAIL+code))
}

function test_group_5 {
divider " Group 5: Middleware — optionalAuth "
echo ""
echo "  Impact: If these tests fail, public endpoints that should"
echo "  work for both logged-in and anonymous users either block"
echo "  everyone or crash on invalid tokens."
echo ""
node --input-type=module -e "
import{createTestJWKS}from'./src/auth/_test-helper.js';
import{clearJwksCache}from'./src/auth/jwt-verifier.js';
import{_resetForTesting,initRegistry,getProviders,_patchSnapshotForTesting}from'./src/auth/index.js';
import{createAuthMiddleware}from'./src/auth/middleware.js';
import fs from 'node:fs';
var helper=await createTestJWKS({issuer:'https://mock-auth.test/'});
_resetForTesting();process.env.MOCK_AUTH_ENABLED='true';await initRegistry(()=>{});
var mp=getProviders().find(p=>p.name==='mock');
Object.defineProperty(mp,'jwksUri',{get:()=>helper.jwksUri,configurable:true});
Object.defineProperty(mp,'audience',{get:()=>helper.audience,configurable:true});
_patchSnapshotForTesting('mock',{jwksUri:helper.jwksUri,audience:helper.audience});
const{optionalAuth}=createAuthMiddleware(()=>{});
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
function mReq(h={}){return{headers:h,path:'/test'}}
function mRes(){let _s=null,_j=null;return{status(s){_s=s;return this},json(j){_j=j;return this},getStatus(){return _s},getJson(){return _j}}}
try{
teststring='Test 3.3.5.1';
console.log('Test 3.3.5.1');
try{
console.log('  Sending valid token to optionalAuth — should attach user identity');
console.log('  Unlike requireAuth, optionalAuth enriches but never blocks');
var token=await helper.signToken({sub:'opt_user'});
var req1=mReq({authorization:'Bearer '+token});var res1=mRes();var nc=false;
await optionalAuth(req1,res1,()=>{nc=true});
check(teststring+' Valid token — passes with user',nc&&req1.user?.sub==='opt_user','next + sub=opt_user','next='+nc+' sub='+String(req1.user?.sub));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.5.2';
console.log('Test 3.3.5.2');
try{
console.log('  Sending request with no token — should pass through with null user');
var req2=mReq({});var res2=mRes();nc=false;
await optionalAuth(req2,res2,()=>{nc=true});
check(teststring+' No token — passes with null user',nc&&req2.user===null,'next + null','next='+nc+' user='+String(req2.user));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.5.3';
console.log('Test 3.3.5.3');
try{
console.log('  Sending a bad token — optionalAuth must NOT return an error');
console.log('  It silently sets user=null and continues');
var req3=mReq({authorization:'Bearer expired_or_bad'});var res3=mRes();nc=false;
await optionalAuth(req3,res3,()=>{nc=true});
check(teststring+' Bad token — passes silently',nc&&req3.user===null,'next + null','next='+nc+' user='+String(req3.user));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.5.4';
console.log('Test 3.3.5.4');
try{
console.log('  Checking that bad token did not trigger an error status on the response');
check(teststring+' No error status set',res3.getStatus()===null,'no status',String(res3.getStatus()));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.5.5';
console.log('Test 3.3.5.5');
try{
console.log('  Sending an expired token — should pass through silently like any bad token');
var expired=await helper.signExpiredToken();
var req4=mReq({authorization:'Bearer '+expired});var res4=mRes();nc=false;
await optionalAuth(req4,res4,()=>{nc=true});
check(teststring+' Expired — passes silently',nc&&req4.user===null,'next + null','next='+nc+' user='+String(req4.user));
}finally{await helper.close();clearJwksCache();delete process.env.MOCK_AUTH_ENABLED}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 5: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+5-code)); FAIL=$((FAIL+code))
}

function test_group_6 {
divider " Group 6: Error message safety "
echo ""
echo "  Impact: If these tests fail, auth error responses leak"
echo "  file paths, library names, or stack traces. Attackers"
echo "  use this to map internals and craft targeted exploits."
echo ""
node --input-type=module -e "
import{verifyToken}from'./src/auth/jwt-verifier.js';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
var codes=[];
var tests=[[null,'x','x','x'],['bad','x','x','x'],['a.b.c','iss','http://localhost:1/j','aud']];
for(var args of tests){try{await verifyToken(...args)}catch(e){codes.push(e.message)}}

for(const[i,code]of codes.entries()){
  teststring='Test 3.3.6.'+(i*3+1);
  console.log('Test 3.3.6.'+(i*3+1));
  try{
  console.log('  Error code: '+code);
  console.log('  Checking for file path characters (/ or \\\\) — these reveal server structure');
  check(teststring+' No file paths: '+code,!code.includes('/')&&!code.includes('\\\\'),'no path chars',code);

  }catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
  teststring='Test 3.3.6.'+(i*3+2);
  console.log('Test 3.3.6.'+(i*3+2));
  try{
  console.log('  Checking for stack trace fragments (\"at \" or \".js:\") — reveal source files');
  check(teststring+' No stack traces: '+code,!code.includes('at ')&&!code.includes('.js:'),'no traces',code);

  }catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
  teststring='Test 3.3.6.'+(i*3+3);
  console.log('Test 3.3.6.'+(i*3+3));
  try{
  console.log('  Error codes must be UPPER_SNAKE_CASE constants — no prose, no details');
  check(teststring+' Uppercase constant format: '+code,/^[A-Z_]+$/.test(code),'UPPER_SNAKE_CASE',code);
}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('');console.log('  Group 6: '+pass+' passed, '+fail+' failed');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+9-code)); FAIL=$((FAIL+code))
}

function test_group_7 {
divider " Group 7: jose library isolation "
echo ""
echo "  Impact: If jose is imported in multiple files, replacing"
echo "  it with hand-coded crypto requires editing every file —"
echo "  multiplying regression risk."
echo ""
local jose_in_verifier=$(grep -c "from ['\"]jose['\"]" src/auth/jwt-verifier.js)
local jose_in_middleware=$(grep -c "from ['\"]jose['\"]" src/auth/middleware.js)
local jose_in_registry=$(grep -c "from ['\"]jose['\"]" src/auth/index.js)
local jose_in_auth0=$(grep -c "from ['\"]jose['\"]" src/auth/providers/auth0.js)
local jose_in_mock=$(grep -c "from ['\"]jose['\"]" src/auth/providers/mock.js)
local p=0 f=0

echo "Test 3.3.7.1"
echo "  Searching src/auth/jwt-verifier.js for import from 'jose'"
echo "  This file should be the SINGLE jose import point in the codebase"
if [ "$jose_in_verifier" -ge 1 ]; then echo "  ✓ jwt-verifier.js is the single jose import point"; p=$((p+1))
else echo "  ✗ jwt-verifier.js does not import jose"; echo "Test 3.3.7.1 jwt-verifier.js does not import jose" >> "$FAILURE_LOG"; echo "    Expected: ≥1 import"; echo "    Actual:   0 imports"; f=$((f+1)); fi

echo "Test 3.3.7.2"
echo "  Searching src/auth/middleware.js for import from 'jose'"
echo "  Middleware delegates to jwt-verifier.js — must not import jose directly"
if [ "$jose_in_middleware" -eq 0 ]; then echo "  ✓ middleware.js does not import jose"; p=$((p+1))
else echo "  ✗ middleware.js imports jose directly"; echo "Test 3.3.7.2 middleware.js imports jose directly" >> "$FAILURE_LOG"; echo "    Expected: 0"; echo "    Actual:   $jose_in_middleware"; f=$((f+1)); fi

echo "Test 3.3.7.3"
echo "  Searching src/auth/index.js (registry) for jose imports"
if [ "$jose_in_registry" -eq 0 ]; then echo "  ✓ registry does not import jose"; p=$((p+1))
else echo "  ✗ registry imports jose"; echo "Test 3.3.7.3 registry imports jose" >> "$FAILURE_LOG"; echo "    Expected: 0"; echo "    Actual:   $jose_in_registry"; f=$((f+1)); fi

echo "Test 3.3.7.4"
echo "  Searching src/auth/providers/auth0.js for jose imports"
echo "  Auth0 provider handles OAuth flows — jose is for JWT verification only"
if [ "$jose_in_auth0" -eq 0 ]; then echo "  ✓ Auth0 provider does not import jose"; p=$((p+1))
else echo "  ✗ Auth0 provider imports jose"; echo "Test 3.3.7.4 Auth0 provider imports jose" >> "$FAILURE_LOG"; echo "    Expected: 0"; echo "    Actual:   $jose_in_auth0"; f=$((f+1)); fi

echo "Test 3.3.7.5"
echo "  Searching src/auth/providers/mock.js for jose imports"
if [ "$jose_in_mock" -eq 0 ]; then echo "  ✓ Mock provider does not import jose"; p=$((p+1))
else echo "  ✗ Mock provider imports jose"; echo "Test 3.3.7.5 Mock provider imports jose" >> "$FAILURE_LOG"; echo "    Expected: 0"; echo "    Actual:   $jose_in_mock"; f=$((f+1)); fi

PASS=$((PASS+p)); FAIL=$((FAIL+f))
echo ""; echo "  Group 7: $p passed, $f failed"
}

######## MAIN
if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> group 1 (valid tokens)" x && test_group_1
  read -p "<Enter> group 2 (rejections)" x && test_group_2
  read -p "<Enter> group 3 (requireAuth)" x && test_group_3
  read -p "<Enter> group 4 (dev mode)" x && test_group_4
  read -p "<Enter> group 5 (optionalAuth)" x && test_group_5
  read -p "<Enter> group 6 (error safety)" x && test_group_6
  read -p "<Enter> group 7 (jose isolation)" x && test_group_7
else test_group_1;test_group_2;test_group_3;test_group_4;test_group_5;test_group_6;test_group_7; fi
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

