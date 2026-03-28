#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Phase 3 Step 3 — JWT + Middleware ADVERSARIAL Tests
# ═══════════════════════════════════════════════════════════════
# Requires: npm install jose
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
echo "  Phase 3 Step 3 — JWT + Middleware ADVERSARIAL Test Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
if [ ! -f "src/auth/jwt-verifier.js" ]; then echo "  ERROR: src/auth/jwt-verifier.js not found."; exit 1; fi
if ! command -v node > /dev/null 2>&1; then echo "  ERROR: node not in PATH."; exit 1; fi
echo -n "  jose check: "
node --input-type=module -e "import'jose';console.log('installed');" 2>/dev/null
if [ $? -ne 0 ]; then echo "  ERROR: npm install jose"; exit 1; fi

function test_group_1 {
divider " Group 1: Algorithm confusion "
echo ""
echo "  Impact: This is the #1 JWT attack in the wild. If alg:none"
echo "  or alg:HS256 tokens are accepted, ANY person can forge a"
echo "  valid-looking token without the signing key. Complete"
echo "  authentication bypass — every account compromised."
echo ""
node --input-type=module -e "
import{createTestJWKS}from'./src/auth/_test-helper.js';
import{verifyToken,clearJwksCache}from'./src/auth/jwt-verifier.js';
import crypto from'node:crypto';
import fs from 'node:fs';
var helper=await createTestJWKS();
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
async function expectReject(label,token){
  try{await verifyToken(token,helper.issuer,helper.jwksUri,helper.audience);
    check(label,false,'token rejected','TOKEN ACCEPTED — CRITICAL VULNERABILITY');
  }catch(e){check(label+' → '+e.message,true,'rejected','rejected')}}
try{
var pl=Buffer.from(JSON.stringify({sub:'attacker',iss:helper.issuer,aud:helper.audience,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');

teststring='Test 3.3.1.1-A';
console.log('\nTest 3.3.1.1-A');
try{
console.log('  Constructing JWT with alg:none and an empty signature');
console.log('  alg:none means \"no signature required\" — the token is self-asserted');
console.log('  If the verifier accepts this, anyone can forge any identity');
var noneH=Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url');
await expectReject('alg:none with empty signature',noneH+'.'+pl+'.');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.2-A';
console.log('\nTest 3.3.1.2-A');
try{
console.log('  Same alg:none but with the signature segment omitted entirely');
console.log('  Some JWT libraries treat missing segments differently from empty ones');
await expectReject('alg:none with no signature segment',noneH+'.'+pl);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.3-A';
console.log('\nTest 3.3.1.3-A');
try{
console.log('  alg:none but with the kid header set to our legitimate key ID');
console.log('  The kid might cause the verifier to look up a key, but alg:none');
console.log('  tells it not to verify — a contradictory state that must be rejected');
var noneKid=Buffer.from(JSON.stringify({alg:'none',kid:helper.kid})).toString('base64url');
await expectReject('alg:none with legitimate kid',noneKid+'.'+pl+'.');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.4-A';
console.log('\nTest 3.3.1.4-A');
try{
console.log('  Constructing JWT with alg:HS256 signed with an arbitrary HMAC secret');
console.log('  HS256 is symmetric — if the verifier uses the RSA public key as the');
console.log('  HMAC secret (a known attack), any attacker who has the public key');
console.log('  (which is public by definition) can forge tokens');
var hs256H=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
var hs256Sig=crypto.createHmac('sha256','any-secret').update(hs256H+'.'+pl).digest('base64url');
await expectReject('alg:HS256 with arbitrary HMAC secret',hs256H+'.'+pl+'.'+hs256Sig);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.5-A';
console.log('\nTest 3.3.1.5-A');
try{
console.log('  Trying HS384 — another symmetric algorithm the verifier must reject');
var hs384H=Buffer.from(JSON.stringify({alg:'HS384'})).toString('base64url');
var hs384Sig=crypto.createHmac('sha384','secret').update(hs384H+'.'+pl).digest('base64url');
await expectReject('alg:HS384 rejected',hs384H+'.'+pl+'.'+hs384Sig);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.6-A';
console.log('\nTest 3.3.1.6-A');
try{
console.log('  Trying HS512 — same class of attack, different key length');
var hs512H=Buffer.from(JSON.stringify({alg:'HS512'})).toString('base64url');
var hs512Sig=crypto.createHmac('sha512','secret').update(hs512H+'.'+pl).digest('base64url');
await expectReject('alg:HS512 rejected',hs512H+'.'+pl+'.'+hs512Sig);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.7-A';
console.log('\nTest 3.3.1.7-A');
try{
console.log('  Trying RS384 — valid RSA algorithm but our JWKS only has RS256 keys');
console.log('  The verifier must not use an RS256 key to verify an RS384 signature');
var rs384H=Buffer.from(JSON.stringify({alg:'RS384',kid:helper.kid})).toString('base64url');
await expectReject('alg:RS384 with RS256 JWKS key',rs384H+'.'+pl+'.'+crypto.randomBytes(64).toString('base64url'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.1.8-A';
console.log('\nTest 3.3.1.8-A');
try{
console.log('  Trying PS256 (RSA-PSS) — different padding scheme than RS256');
console.log('  Even though both use RSA, PS256 signatures are not valid RS256');
var ps256H=Buffer.from(JSON.stringify({alg:'PS256',kid:helper.kid})).toString('base64url');
await expectReject('alg:PS256 with RS256 key',ps256H+'.'+pl+'.'+crypto.randomBytes(64).toString('base64url'));

}finally{await helper.close();clearJwksCache()}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 1: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+8-code)); FAIL=$((FAIL+code))
}

function test_group_2 {
divider " Group 2: JWT header injection (jku/jwk/x5u) "
echo ""
echo "  Impact: If the verifier follows jku or jwk headers in the"
echo "  token, an attacker signs with their own keys and tells"
echo "  the verifier where to find them. Complete bypass without"
echo "  touching our JWKS endpoint."
echo ""
node --input-type=module -e "
import{createTestJWKS}from'./src/auth/_test-helper.js';
import{verifyToken,clearJwksCache}from'./src/auth/jwt-verifier.js';
import{generateKeyPair,exportJWK,SignJWT}from'jose';
import fs from 'node:fs';
var helper=await createTestJWKS();
var attacker=await generateKeyPair('RS256');
var attackerJwk=await exportJWK(attacker.publicKey);
attackerJwk.kid='attacker-kid';attackerJwk.use='sig';attackerJwk.alg='RS256';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
async function expectReject(label,token){
  try{await verifyToken(token,helper.issuer,helper.jwksUri,helper.audience);
    check(label,false,'rejected','ACCEPTED — attacker keys trusted');
  }catch(e){check(label+' → '+e.message,true,'rejected','rejected')}}
try{
var now=Math.floor(Date.now()/1000);

teststring='Test 3.3.2.1-A';
console.log('\nTest 3.3.2.1-A');
try{
console.log('  Token signed with attacker\\'s private key');
console.log('  Header includes jku: \"https://evil.com/.well-known/jwks.json\"');
console.log('  If the verifier fetches this URL instead of the registered JWKS,');
console.log('  it downloads the attacker\\'s public key and the signature validates');
var jkuT=await new SignJWT({sub:'attacker',iss:helper.issuer,aud:helper.audience}).setProtectedHeader({alg:'RS256',kid:'attacker-kid',jku:'https://evil.com/.well-known/jwks.json'}).setIssuedAt(now).setExpirationTime(now+3600).sign(attacker.privateKey);
await expectReject('jku header injection (remote attacker JWKS)',jkuT);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.2-A';
console.log('\nTest 3.3.2.2-A');
try{
console.log('  Token with jwk header containing the attacker\\'s public key directly');
console.log('  The key is embedded in the token itself — no external fetch needed');
console.log('  If the verifier trusts the embedded key, any token self-validates');
var jwkT=await new SignJWT({sub:'attacker',iss:helper.issuer,aud:helper.audience}).setProtectedHeader({alg:'RS256',kid:'attacker-kid',jwk:attackerJwk}).setIssuedAt(now).setExpirationTime(now+3600).sign(attacker.privateKey);
await expectReject('jwk header injection (embedded attacker key)',jwkT);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.3-A';
console.log('\nTest 3.3.2.3-A');
try{
console.log('  Token with x5u header pointing to attacker\\'s X.509 certificate');
console.log('  x5u is the certificate equivalent of jku — same attack, different format');
var x5uT=await new SignJWT({sub:'attacker',iss:helper.issuer,aud:helper.audience}).setProtectedHeader({alg:'RS256',kid:'attacker-kid',x5u:'https://evil.com/cert.pem'}).setIssuedAt(now).setExpirationTime(now+3600).sign(attacker.privateKey);
await expectReject('x5u header injection (attacker certificate URL)',x5uT);

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.2.4-A';
console.log('\nTest 3.3.2.4-A');
try{
console.log('  Token signed with attacker\\'s key but using OUR legitimate kid');
console.log('  The kid matches a key in our JWKS, but the signature was made');
console.log('  with a completely different private key — must fail signature check');
var spoofT=await new SignJWT({sub:'attacker',iss:helper.issuer,aud:helper.audience}).setProtectedHeader({alg:'RS256',kid:helper.kid}).setIssuedAt(now).setExpirationTime(now+3600).sign(attacker.privateKey);
await expectReject('Spoofed kid with attacker signing key',spoofT);

}finally{await helper.close();clearJwksCache()}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 2: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+4-code)); FAIL=$((FAIL+code))
}

function test_group_3 {
divider " Group 3: Token manipulation "
echo ""
echo "  Impact: If tampered tokens pass verification, an attacker"
echo "  modifies their valid token to escalate privileges, change"
echo "  identity, or extend expiration indefinitely."
echo ""
node --input-type=module -e "
import{createTestJWKS}from'./src/auth/_test-helper.js';
import{verifyToken,clearJwksCache}from'./src/auth/jwt-verifier.js';
import crypto from'node:crypto';
import fs from 'node:fs';
var helper=await createTestJWKS();
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
async function expectReject(label,token){
  try{await verifyToken(token,helper.issuer,helper.jwksUri,helper.audience);
    check(label,false,'rejected','accepted')
  }catch(e){check(label+' → '+e.message,true,'rejected','rejected')}}
try{
teststring='Test 3.3.3.1-A';
console.log('\nTest 3.3.3.1-A');
try{
console.log('  Signing a valid token, then changing sub from \"legit_user\" to \"attacker\"');
console.log('  The signature was computed over the original payload — changing any byte');
console.log('  invalidates it. If this passes, the verifier is not checking signatures');
var valid=await helper.signToken({sub:'legit_user'});
var parts=valid.split('.');
var pl=JSON.parse(Buffer.from(parts[1],'base64url').toString());
pl.sub='attacker';parts[1]=Buffer.from(JSON.stringify(pl)).toString('base64url');
await expectReject('Tampered payload (sub changed)',parts.join('.'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.2-A';
console.log('\nTest 3.3.3.2-A');
try{
console.log('  Token with multiple audiences: [\"https://linkedin-agent-api\", \"https://other-api\"]');
console.log('  The OIDC spec allows array aud — documenting whether our verifier accepts it');
var multiAud=await helper.signToken({},{audience:['https://linkedin-agent-api','https://other-api']});
try{await verifyToken(multiAud,helper.issuer,helper.jwksUri,helper.audience);
  console.log('  ℹ Multiple audiences accepted (array contains valid value)');
  check(teststring+' Multiple aud behavior documented',true,'documented','documented');
}catch(e){check(teststring+' Multiple aud rejected: '+e.message,true,'documented','documented')}

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.3-A';
console.log('\nTest 3.3.3.3-A');
try{
console.log('  Creating a 1MB token — oversized payload as DoS vector');
console.log('  The verifier should reject or error, not consume unbounded memory');
try{const huge=await helper.signToken({sub:'a',data:'x'.repeat(1000000)});
  await expectReject('1MB oversized token',huge);
}catch(e){check(teststring+' 1MB token errored: '+e.message?.substring(0,40),true,'rejected or errored','rejected or errored')}

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.4-A';
console.log('\nTest 3.3.3.4-A');
try{
console.log('  Empty JSON as both header and payload: {}.{}.<random>');
console.log('  No alg, no iss, no aud — the verifier must reject early');
var emptyH=Buffer.from('{}').toString('base64url');var emptyP=Buffer.from('{}').toString('base64url');
await expectReject('Empty JSON header and payload',emptyH+'.'+emptyP+'.'+crypto.randomBytes(32).toString('base64url'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.5-A';
console.log('\nTest 3.3.3.5-A');
try{
console.log('  Valid token with the kid header removed');
console.log('  Without kid, the verifier cannot select the correct key from JWKS');
console.log('  It should reject, not try every key (which would be a timing oracle)');
var noKidParts=valid.split('.');
var hdr=JSON.parse(Buffer.from(noKidParts[0],'base64url').toString());
delete hdr.kid;noKidParts[0]=Buffer.from(JSON.stringify(hdr)).toString('base64url');
await expectReject('Token with kid removed (tampered header)',noKidParts.join('.'));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.6-A';
console.log('\nTest 3.3.3.6-A');
try{
console.log('  Token containing null bytes — binary injection');
await expectReject('Null bytes in token','eyJ\\x00.eyJ\\x00.sig');

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.3.7-A';
console.log('\nTest 3.3.3.7-A');
try{
console.log('  Token with 4 dot-separated segments instead of 3');
console.log('  JWTs must have exactly 3 segments: header.payload.signature');
await expectReject('Four-segment token','a.b.c.d');

}finally{await helper.close();clearJwksCache()}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 3: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+7-code)); FAIL=$((FAIL+code))
}

function test_group_4 {
divider " Group 4: Middleware bypass attempts "
echo ""
echo "  Impact: If the middleware can be bypassed through header"
echo "  tricks, case sensitivity, or token placement in cookies,"
echo "  authentication is decorative. Protected endpoints are"
echo "  accessible to anyone who knows the right trick."
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
const{requireAuth}=createAuthMiddleware(()=>{});
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
function mReq(h,x={}){return{headers:h,path:'/api/test',query:x.query||{},cookies:x.cookies||{}}}
function mRes(){let _s=null,_j=null;return{status(s){_s=s;return this},json(j){_j=j;return this},getStatus(){return _s},getJson(){return _j}}}
async function expectBlock(label,req){const res=mRes();var next=false;await requireAuth(req,res,()=>{next=true});
  check(label,!next&&res.getStatus()===401,'blocked 401','next='+next+' status='+res.getStatus())}
async function expectPass(label,req){const res=mRes();var next=false;await requireAuth(req,res,()=>{next=true});
  check(label,next&&req.user?.sub,'pass with user','next='+next+' sub='+String(req.user?.sub))}
try{
var vt=await helper.signToken({sub:'user1'});

teststring='Test 3.3.4.1-A';
console.log('\nTest 3.3.4.1-A');
try{
console.log('  Sending \"Bearer <token>\" — correct case, should pass');
await expectPass('Bearer (correct case)',mReq({authorization:'Bearer '+vt}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.2-A';
console.log('\nTest 3.3.4.2-A');
try{
console.log('  Sending \"bearer <token>\" — lowercase. RFC 7235 says scheme comparison');
console.log('  is case-insensitive. Both must work.');
await expectPass('bearer (lowercase)',mReq({authorization:'bearer '+vt}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.3-A';
console.log('\nTest 3.3.4.3-A');
try{
console.log('  Sending \"BEARER <token>\" — uppercase variant');
await expectPass('BEARER (uppercase)',mReq({authorization:'BEARER '+vt}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.4-A';
console.log('\nTest 3.3.4.4-A');
try{
console.log('  Sending \"Bearer  <token>\" with double space after Bearer');
console.log('  The split(\" \") would produce 3 parts instead of 2');
console.log('  Middleware should reject — only exactly 2 parts is valid');
await expectBlock('Double space after Bearer',mReq({authorization:'Bearer  '+vt}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.5-A';
console.log('\nTest 3.3.4.5-A');
try{
console.log('  Sending \" Bearer <token>\" with leading space');
console.log('  Leading space means parts[0] is empty, parts[1] is \"Bearer\"');
await expectBlock('Leading space before Bearer',mReq({authorization:' Bearer '+vt}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.6-A';
console.log('\nTest 3.3.4.6-A');
try{
console.log('  Sending \"Basic <token>\" — wrong auth scheme');
console.log('  Basic auth is for username:password, not JWT tokens');
await expectBlock('Basic scheme rejected',mReq({authorization:'Basic '+vt}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.7-A';
console.log('\nTest 3.3.4.7-A');
try{
console.log('  Sending \"Token <token>\" — some frameworks use this non-standard scheme');
await expectBlock('Token scheme rejected',mReq({authorization:'Token '+vt}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.8-A';
console.log('\nTest 3.3.4.8-A');
try{
console.log('  Sending \"MAC <token>\" — OAuth 1.0 style, not applicable');
await expectBlock('MAC scheme rejected',mReq({authorization:'MAC '+vt}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.9-A';
console.log('\nTest 3.3.4.9-A');
try{
console.log('  Token placed in query string as ?access_token= instead of header');
console.log('  Query string tokens appear in server logs, browser history, and referrer headers');
console.log('  The middleware must only accept Authorization header');
await expectBlock('Token in query string rejected',mReq({},{query:{access_token:vt}}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.10-A';
console.log('\nTest 3.3.4.10-A');
try{
console.log('  Token placed in a cookie instead of header');
console.log('  Cookie-based tokens are vulnerable to CSRF — we use Bearer for a reason');
await expectBlock('Token in cookie rejected',mReq({},{cookies:{access_token:vt}}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.11-A';
console.log('\nTest 3.3.4.11-A');
try{
console.log('  Sending \"Bearer \" with nothing after it — empty token value');
await expectBlock('Empty bearer value rejected',mReq({authorization:'Bearer '}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.12-A';
console.log('\nTest 3.3.4.12-A');
try{
console.log('  Sending \"Bearer    \" — spaces only after Bearer');
await expectBlock('Bearer with spaces only rejected',mReq({authorization:'Bearer    '}));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.13-A';
console.log('\nTest 3.3.4.13-A');
try{
console.log('  Pre-setting req.user before middleware runs');
console.log('  A previous middleware or proxy could inject a fake user object');
console.log('  requireAuth must overwrite it with the verified token payload');
var preReq=mReq({authorization:'Bearer '+vt});
preReq.user={sub:'pre-existing-attacker',isAdmin:true};
var preRes=mRes();var preNext=false;
await requireAuth(preReq,preRes,()=>{preNext=true});
check(teststring+' Pre-set req.user overwritten by verified token',preReq.user?.sub==='user1','sub=user1','sub='+String(preReq.user?.sub));

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.4.14-A';
console.log('\nTest 3.3.4.14-A');
try{
console.log('  Checking that the pre-set isAdmin:true was NOT preserved');
console.log('  Only claims from the verified JWT should appear in req.user');
check(teststring+' Pre-set isAdmin not preserved',preReq.user?.isAdmin===undefined,'undefined',String(preReq.user?.isAdmin));

}finally{await helper.close();clearJwksCache();delete process.env.MOCK_AUTH_ENABLED}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 4: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+16-code)); FAIL=$((FAIL+code))
}

function test_group_5 {
divider " Group 5: Error response information leakage "
echo ""
echo "  Impact: If different failures produce different messages"
echo "  or status codes, attackers enumerate valid tokens, identify"
echo "  the JWT library, and map internal error handling."
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
const{requireAuth}=createAuthMiddleware(()=>{});
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
function mReq(h){return{headers:h,path:'/api/test'}}
function mRes(){let _s=null,_j=null;return{status(s){_s=s;return this},json(j){_j=j;return this},getStatus(){return _s},getJson(){return _j}}}
try{
var scenarios=[
  ['No header',{}],
  ['Fabricated token',{authorization:'Bearer '+helper.fabricateToken()}],
  ['Expired token',{authorization:'Bearer '+(await helper.signExpiredToken())}],
  ['Wrong issuer',{authorization:'Bearer '+(await helper.signToken({},{issuer:'https://other.com/'}))}],
  ['Garbage string',{authorization:'Bearer not-a-jwt'}],
  ['Empty bearer',{authorization:'Bearer '}]
];
var responses=[];
for(const[label,headers]of scenarios){const res=mRes();await requireAuth(mReq(headers),res,()=>{});responses.push({label,status:res.getStatus(),json:res.getJson()})}

teststring='Test 3.3.5.1-A';
console.log('\nTest 3.3.5.1-A');
try{
console.log('  Checking that ALL 6 invalid token scenarios return HTTP 401');
console.log('  A mix of 401/403/500 would tell attackers which failures are \"closer\" to valid');
var statuses=responses.map(r=>r.label+'='+r.status).join(', ');
check(teststring+' All invalid tokens return 401',responses.every(r=>r.status===401),'all 401',statuses);

var tn=2;
for(var r of responses){
  var j=JSON.stringify(r.json||{});

  }catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
  teststring='Test 3.3.5.'+tn+'-A';
  console.log('\nTest 3.3.5.'+tn+'-A');
  try{
  console.log('  Checking \"'+r.label+'\" response for stack trace fragments');
  console.log('  Stack traces reveal file names, line numbers, and function names');
  check(r.label+' — no stack traces',!j.includes('at ')&&!j.includes('.js:'),'no traces',j.substring(0,60));
  tn++;

  }catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
  teststring='Test 3.3.5.'+tn+'-A';
  console.log('\nTest 3.3.5.'+tn+'-A');
  try{
  console.log('  Checking for jose library references (JWS, JWK, jose)');
  console.log('  Library names help attackers identify the implementation and known CVEs');
  check(r.label+' — no jose references',!j.includes('JWS')&&!j.includes('JWK')&&!j.includes('jose'),'no jose refs',j.substring(0,60));
  tn++;

  }catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
  teststring='Test 3.3.5.'+tn+'-A';
  console.log('\nTest 3.3.5.'+tn+'-A');
  try{
  console.log('  Checking for file paths (/src/, node_modules)');
  console.log('  File paths reveal the server directory structure');
  check(r.label+' — no file paths',!j.includes('/src/')&&!j.includes('node_modules'),'no paths',j.substring(0,60));
  tn++;
}
}finally{await helper.close();clearJwksCache();delete process.env.MOCK_AUTH_ENABLED}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 5: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+19-code)); FAIL=$((FAIL+code))
}

function test_group_6 {
divider " Group 6: JWKS endpoint abuse "
echo ""
echo "  Impact: If a compromised JWKS endpoint returns empty keys"
echo "  or errors and the verifier fails open (accepts tokens),"
echo "  every token passes. If it crashes, every request 500s."
echo ""
node --input-type=module -e "
import{verifyToken,clearJwksCache}from'./src/auth/jwt-verifier.js';
import{createTestJWKS}from'./src/auth/_test-helper.js';
import http from'node:http';
import fs from 'node:fs';
var pass=0,fail=0;
function check(info,cond,expected,actual){if(cond){console.log('  ✓ '+info);pass++}else{console.log('  ✗ '+info);console.log('    Expected: '+expected);console.log('    Actual:   '+actual);try{fs.appendFileSync(process.env.FAILURE_LOG,info+'\n    Expected: '+expected+'\n    Actual:   '+actual+'\n\n')}catch(e){};fail++}}
var teststring='';
var helper=await createTestJWKS();
var vt=await helper.signToken({sub:'user1'});
try{

teststring='Test 3.3.6.1-A';
console.log('\nTest 3.3.6.1-A');
try{
console.log('  JWKS endpoint returns {keys:[]} — valid JSON but zero signing keys');
console.log('  The verifier has no key to check the signature against');
console.log('  Must reject the token, not skip verification');
var empty=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({keys:[]}))});
await new Promise(r=>empty.listen(0,'127.0.0.1',r));
clearJwksCache();
try{await verifyToken(vt,helper.issuer,'http://127.0.0.1:'+empty.address().port+'/.well-known/jwks.json',helper.audience);
  check(teststring+' Empty JWKS rejects token',false,'rejected','accepted')}
catch(e){check(teststring+' Empty JWKS rejects token → '+e.message,true,'rejected','rejected')}
empty.close();

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.6.2-A';
console.log('\nTest 3.3.6.2-A');
try{
console.log('  JWKS endpoint returns non-JSON garbage text');
console.log('  The verifier cannot parse keys — must fail closed');
var bad=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end('not json')});
await new Promise(r=>bad.listen(0,'127.0.0.1',r));
clearJwksCache();
try{await verifyToken(vt,helper.issuer,'http://127.0.0.1:'+bad.address().port+'/.well-known/jwks.json',helper.audience);
  check(teststring+' Malformed JWKS rejects token',false,'rejected','accepted')}
catch(e){check(teststring+' Malformed JWKS rejects token → '+e.message,true,'rejected','rejected')}
bad.close();

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.6.3-A';
console.log('\nTest 3.3.6.3-A');
try{
console.log('  JWKS endpoint returns HTTP 500');
console.log('  Server error at the key source — verifier cannot get keys');
var err=http.createServer((q,r)=>{r.writeHead(500);r.end('Internal Server Error')});
await new Promise(r=>err.listen(0,'127.0.0.1',r));
clearJwksCache();
try{await verifyToken(vt,helper.issuer,'http://127.0.0.1:'+err.address().port+'/.well-known/jwks.json',helper.audience);
  check(teststring+' 500 JWKS rejects token',false,'rejected','accepted')}
catch(e){check(teststring+' 500 JWKS rejects token → '+e.message,true,'rejected','rejected')}
err.close();

}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
teststring='Test 3.3.6.4-A';
console.log('\nTest 3.3.6.4-A');
try{
console.log('  JWKS endpoint is unreachable (connection refused on port 1)');
console.log('  Network failure must result in token rejection, not acceptance');
clearJwksCache();
try{await verifyToken(vt,helper.issuer,'http://127.0.0.1:1/.well-known/jwks.json',helper.audience);
  check(teststring+' Unreachable JWKS rejects token',false,'rejected','accepted')}
catch(e){check(teststring+' Unreachable JWKS rejects token → '+e.message,true,'rejected','rejected')}

}finally{await helper.close();clearJwksCache()}
}catch(e){console.log('  ✗ '+teststring+' ABORTED — '+e.message);try{fs.appendFileSync(process.env.FAILURE_LOG,teststring+' ABORTED — '+e.message+'\n\n')}catch(x){};fail++}
console.log('  Group 6: '+pass+' passed, '+fail+' failed\n');
process.exit(fail);
" 2>&1
local code=$?; PASS=$((PASS+4-code)); FAIL=$((FAIL+code))
}

######## MAIN
if [ -z "$RUN_ALL" ]; then
  read -p "<Enter> group 1 (algorithm confusion)" x && test_group_1
  read -p "<Enter> group 2 (header injection)" x && test_group_2
  read -p "<Enter> group 3 (token manipulation)" x && test_group_3
  read -p "<Enter> group 4 (middleware bypass)" x && test_group_4
  read -p "<Enter> group 5 (error leakage)" x && test_group_5
  read -p "<Enter> group 6 (JWKS abuse)" x && test_group_6
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

