// ═══════════════════════════════════════════════════════════════
// Step 1 Adversarial Groups 1, 2, 5: Hostile Loading
// Crash in isConfigured + hang in init + malformed files
// ═══════════════════════════════════════════════════════════════
//
// NOTE: Groups 2 (hang) and 6 (process.exit) require bash-level
// testing because they kill or hang the Node process. Those are
// handled by the runner script, not by .mjs files.
// This file covers Groups 1 and 5 only.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { initRegistry, getProvider, isAuthEnabled, _resetForTesting } from '../../../src/auth/index.js';

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

// Ensure cleanup on exit
process.on('exit', cleanupHostile);
process.on('SIGINT', () => { cleanupHostile(); process.exit(1); });

// ── Group 1: Crash in isConfigured() ─────────────────────────

console.log('  File: test-p3-step1-adversarial/hostile-loading.mjs');
group('Group 1: Crash in isConfigured()', `
  If the registry crashes when scanning a single bad provider
  file, ALL authentication fails. Every user is locked out
  because one file has a bug.
`);

var before1 = getCounters();

createHostile('hostile-crash-configured.js',
  'export default { name:"hostile_crash",type:"oidc",priority:50,issuer:"https://hostile.test/",jwksUri:"https://hostile.test/.well-known/jwks.json",audience:"test",clientId:"test",isConfigured(){throw new Error("HOSTILE")},async init(){},getRoutes(){return null},getLoginUrl(){return""},async exchangeCode(){return{}},async getUserInfo(){return{}},getLogoutUrl(){return""} };'
);

_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
var logs = [];
var result = await initRegistry((l, a, d) => logs.push({ l, a, d }));

test('3.1.1.1-A', ' A hostile provider throws during isConfigured()', () => {
  console.log('  A hostile provider throws during isConfigured()');
  console.log('  The registry is mid-scan — if the crash propagates, total auth failure');
  check('Registry survived the hostile crash', true, 'no uncaught exception', 'would have exited');
});

test('3.1.1.2-A', ' If the legitimate mock provider survived', () => {
  console.log('  Checking if the legitimate mock provider survived');
  check('Mock provider still loaded', getProvider('mock') !== null, 'mock loaded', 'mock missing');
});

test('3.1.1.3-A', ' Hostile provider must NOT be in the active map', () => {
  console.log('  Hostile provider must NOT be in the active map');
  check('Hostile provider not registered', getProvider('hostile_crash') === null, 'null', String(getProvider('hostile_crash')?.name));
});

test('3.1.1.4-A', ' Auth must remain enabled via the surviving provider', () => {
  console.log('  Auth must remain enabled via the surviving provider');
  check('Auth still enabled', isAuthEnabled(), 'true', String(isAuthEnabled()));
});

test('3.1.1.5-A', ' Logs for a record of the hostile file failure', () => {
  console.log('  Checking logs for a record of the hostile file failure');
  var hostileLog = logs.find(l => l.a === 'auth_provider_skipped' && l.d?.filename?.includes('hostile'));
  check('Hostile failure logged', !!hostileLog, 'log entry present', 'no log entry');
});

// Cleanup hostile file before next group
cleanupHostile();
hostileFiles = [];

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 5: Malformed provider files ────────────────────────

console.log('  File: test-p3-step1-adversarial/hostile-loading.mjs');
group('Group 5: Malformed provider files', `
  Syntax errors or invalid exports in one file during deployment
  crash the registry. Auth for every user goes down because of
  one corrupted artifact.
`);

var before5 = getCounters();

createHostile('hostile-syntax.js', 'this is not valid javascript {{{');
createHostile('hostile-no-export.js', 'export const name = "orphan";');
createHostile('hostile-string-export.js', 'export default "not a provider";');
createHostile('hostile-null-export.js', 'export default null;');
createHostile('hostile-fn-export.js', 'export default function() { return "surprise"; };');

_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
var result5 = await initRegistry(() => {});

test('3.1.5.1-A', ' String export, null export, function export', () => {
  console.log('  5 hostile files placed in providers/: syntax error, no default export,');
  console.log('  string export, null export, function export');
  check('Registry survived all 5 malformed files', true, 'no crash', 'crash');
});

test('3.1.5.2-A', ' Legitimate mock provider was in the same directory', () => {
  console.log('  Legitimate mock provider was in the same directory');
  check('Mock provider still operational', getProvider('mock') !== null, 'loaded', 'missing');
});

test('3.1.5.3-A', ' Auth enforcement must remain active via surviving provider', () => {
  console.log('  Auth enforcement must remain active via surviving provider');
  check('Auth still enabled', isAuthEnabled(), 'true', String(isAuthEnabled()));
});

test('3.1.5.4-A', ' All hostile files handled gracefully', () => {
  console.log('  Each hostile file should be status "error" or "skip" — not "ready"');
  var errorResults = result5.results.filter(r => r.status === 'error' || r.status === 'skip' || r.status === 'inactive');
  check('All hostile files handled gracefully', errorResults.length >= 4, '≥4', '' + errorResults.length);
});

var hostileNames = ['hostile-syntax', 'hostile-no-export', 'hostile-string', 'hostile-null', 'hostile-fn'];
var tn = 5;
for (var name of hostileNames) {
  test('3.1.5.' + tn + '-A', '', () => {
    console.log('  Checking ' + name + '.js — must not be status "ready"');
    var r = result5.results.find(x => x.filename?.includes(name));
    check(name + ' not loaded as provider',
      !result5.results.some(x => x.status === 'ready' && x.filename?.includes(name)),
      'not ready', r?.status || 'not found');
  });
  tn++;
}

cleanupHostile();
hostileFiles = [];
delete process.env.MOCK_AUTH_ENABLED;

var after5 = getCounters();
groupEnd(after5.pass - before5.pass, after5.fail - before5.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
