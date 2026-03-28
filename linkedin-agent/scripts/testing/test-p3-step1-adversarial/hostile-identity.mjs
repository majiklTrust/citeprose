// ═══════════════════════════════════════════════════════════════
// Step 1 Adversarial Groups 3, 4: Hostile Identity
// Duplicate provider names + interface mutation after loading
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { initRegistry, getProvider, getJwksMap, getIssuers,
         isAuthEnabled, _resetForTesting } from '../../../src/auth/index.js';

var PROVIDERS_DIR = 'src/auth/providers';
var hostileFiles = [];

function createHostile(filename, content) {
  var filepath = PROVIDERS_DIR + '/' + filename;
  fs.writeFileSync(filepath, content);
  hostileFiles.push(filepath);
}

function cleanupHostile() {
  for (var f of hostileFiles) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}

process.on('exit', cleanupHostile);
process.on('SIGINT', () => { cleanupHostile(); process.exit(1); });

// ── Group 3: Duplicate provider names ────────────────────────

group('Group 3: Duplicate provider names', `
  If a hostile file uses the same name as a legitimate provider,
  it could silently replace it. All tokens would validate
  against attacker-controlled keys.
`);

var before3 = getCounters();

createHostile('hostile-dupe-name.js',
  'export default { name:"mock",type:"oidc",priority:1,issuer:"https://evil-mock.test/",jwksUri:"https://evil-mock.test/.well-known/jwks.json",audience:"test",clientId:"evil",isConfigured(){return process.env.HOSTILE_DUPE==="true"},async init(){},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""} };'
);

_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
process.env.HOSTILE_DUPE = 'true';
var logs3 = [];
await initRegistry((l, a, d) => logs3.push({ l, a, d }));

test('3.1.3.1-A', '', () => {
  console.log('  Two files both export name:"mock" — hostile-dupe-name.js and mock.js');
  console.log('  Files load alphabetically, so hostile loads first and registers as "mock"');
  console.log('  When real mock.js arrives, the registry detects the duplicate');
  console.log('  Safe response: evict BOTH — neither can be trusted');
  var mock = getProvider('mock');
  check('Neither provider registered (both evicted)',
    mock === null, 'null (both evicted)', mock === null ? 'null' : mock.issuer);
});

test('3.1.3.2-A', '', () => {
  console.log('  With both evicted, auth should be disabled');
  console.log('  Forces operator to resolve the naming conflict manually');
  check('Auth disabled after eviction', !isAuthEnabled(), 'false', String(isAuthEnabled()));
});

test('3.1.3.3-A', '', () => {
  console.log('  Checking logs for duplicate name detection');
  console.log('  The log entry is the operator\'s signal that something is wrong');
  var dw = logs3.find(l => l.d?.reason?.includes('duplicate') || l.a?.includes('duplicate'));
  check('Duplicate name detected and logged', !!dw, 'log entry present', 'no detection');
});

cleanupHostile();
hostileFiles = [];
delete process.env.HOSTILE_DUPE;
delete process.env.MOCK_AUTH_ENABLED;

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Group 4: Interface mutation after loading ────────────────

group('Group 4: Interface mutation after loading', `
  A provider that changes its issuer or JWKS URL after init()
  redirects token validation to attacker-controlled keys.
  Forged tokens pass verification for all accounts.
`);

var before4 = getCounters();

createHostile('hostile-mutate.js',
  'var _i="https://legit.test/",_j="https://legit.test/.well-known/jwks.json";export default{name:"hostile_mutate",type:"oidc",priority:5,get issuer(){return _i},get jwksUri(){return _j},audience:"test",clientId:"test",isConfigured(){return process.env.HOSTILE_MUTATE==="true"},async init(){setTimeout(()=>{_i="https://evil-attacker.com/";_j="https://evil-attacker.com/.well-known/jwks.json"},100)},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""}};'
);

_resetForTesting();
process.env.HOSTILE_MUTATE = 'true';
await initRegistry(() => {});
var prov = getProvider('hostile_mutate');

test('3.1.4.1-A', '', () => {
  console.log('  The hostile provider scheduled a setTimeout in init()');
  console.log('  It will change issuer from legit.test to evil-attacker.com after 100ms');
  check('Hostile provider loaded for test', prov !== null, 'loaded', 'null');
});

test('3.1.4.2-A', '', () => {
  console.log('  Reading issuer immediately — setTimeout has not fired yet');
  var issuerBefore = prov.issuer;
  check('Initial issuer is legitimate', issuerBefore === 'https://legit.test/', 'https://legit.test/', issuerBefore);
});

await testAsync('3.1.4.3-A', '', async () => {
  console.log('  Waiting 200ms for the mutation timer to fire');
  console.log('  The LIVE provider object will mutate — we cannot prevent that');
  console.log('  What matters: the FROZEN SNAPSHOT the middleware uses did not change');
  console.log('  Checking getJwksMap() — reads from snapshot, not live object');
  await new Promise(r => setTimeout(r, 200));
  var liveIssuer = prov.issuer;
  console.log('  Live provider issuer is now: ' + liveIssuer);
  console.log('  (Expected to mutate — the getter follows the mutable variable)');
  var jwksMap = getJwksMap();
  check('Snapshot JWKS map still has legit.test',
    jwksMap.has('https://legit.test/'), 'legit.test in map', JSON.stringify([...jwksMap.keys()]));
});

test('3.1.4.4-A', '', () => {
  console.log('  Attacker URL must NOT appear in the JWKS map');
  console.log('  If it did, middleware would fetch attacker-controlled signing keys');
  var jwksMap = getJwksMap();
  var hasEvil = jwksMap.has('https://evil-attacker.com/');
  if (hasEvil) console.log('  ⚠ CRITICAL — JWKS map poisoned with attacker endpoint');
  check('JWKS map not poisoned', !hasEvil, 'no evil-attacker.com', 'evil-attacker.com found');
});

test('3.1.4.5-A', '', () => {
  console.log('  Checking getIssuers() — the trusted issuer allowlist');
  console.log('  Must contain legit.test, must NOT contain evil-attacker.com');
  var issuers = getIssuers();
  check('Issuer allowlist not poisoned',
    issuers.includes('https://legit.test/') && !issuers.includes('https://evil-attacker.com/'),
    'only legit.test', JSON.stringify(issuers));
});

cleanupHostile();
hostileFiles = [];
delete process.env.HOSTILE_MUTATE;

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
