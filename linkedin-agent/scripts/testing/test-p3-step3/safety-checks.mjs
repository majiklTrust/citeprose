// ═══════════════════════════════════════════════════════════════
// Step 3 Group 6: Error Message Safety
// Verify error codes are safe constants with no internal leakage
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { verifyToken } from '../../../src/auth/jwt-verifier.js';

console.log('  File: test-p3-step3/safety-checks.mjs');
group('Group 6: Error message safety', `
  If these tests fail, auth error responses leak file paths,
  library names, or stack traces. Attackers use this to map
  internals and craft targeted exploits.
`);

var before6 = getCounters();
var codes = [];
var tests = [[null, 'x', 'x', 'x'], ['bad', 'x', 'x', 'x'], ['a.b.c', 'iss', 'http://localhost:1/j', 'aud']];

for (var args of tests) {
  try { await verifyToken(...args); }
  catch (e) { codes.push(e.message); }
}

for (var [i, code] of codes.entries()) {
  test('3.3.6.' + (i * 3 + 1), '', () => {
    console.log('  Error code: ' + code);
    console.log('  Checking for file path chars (/ or \\) — reveal server structure');
    check('No file paths: ' + code, !code.includes('/') && !code.includes('\\'), 'no path chars', code);
  });
  test('3.3.6.' + (i * 3 + 2), '', () => {
    console.log('  Checking for stack trace fragments');
    check('No stack traces: ' + code, !code.includes('at ') && !code.includes('.js:'), 'no traces', code);
  });
  test('3.3.6.' + (i * 3 + 3), '', () => {
    console.log('  Error codes must be UPPER_SNAKE_CASE — no prose, no details');
    check('Uppercase constant: ' + code, /^[A-Z_]+$/.test(code), 'UPPER_SNAKE_CASE', code);
  });
}

var after6 = getCounters();
groupEnd(after6.pass - before6.pass, after6.fail - before6.fail);

var summary = getCounters();
process.exit(summary.fail);
