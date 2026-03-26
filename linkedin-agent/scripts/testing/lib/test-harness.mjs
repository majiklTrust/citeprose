// ═══════════════════════════════════════════════════════════════
// Test Harness — shared by all Phase 3 test scripts
// ═══════════════════════════════════════════════════════════════
//
// Usage in group files:
//   import { group, test, check, getSummary } from '../lib/test-harness.mjs';
//
//   group('Group 1: Interface contract', `
//     Impact: If these tests fail, ...
//   `);
//
//   test('3.1.1.1', () => {
//     console.log('  Narration about what we are checking');
//     check('Label', condition, 'expected', 'actual');
//   });
//
//   export default getSummary;
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';

var _pass = 0;
var _fail = 0;
var _currentTest = '';
var _currentGroup = '';
var _failureLog = process.env.FAILURE_LOG || '';

// ── Group header ─────────────────────────────────────────────

export function group(title, impact) {
  _currentGroup = title;
  console.log('━━ ' + title + ' ━━');
  console.log('');
  if (impact) {
    console.log('  Impact: ' + impact.trim().split('\n').map(l => l.trim()).join('\n  '));
    console.log('');
  }
}

// ── Group summary ────────────────────────────────────────────

export function groupEnd(groupPass, groupFail) {
  console.log('\n  ' + _currentGroup + ': ' + groupPass + ' passed, ' + groupFail + ' failed');
  console.log('━━━━━━\n');
}

// ── Test wrapper ─────────────────────────────────────────────
// Sets teststring, wraps body in try/catch, reports ABORTED on throw.

export function test(id, suffix, fn) {
  _currentTest = 'Test ' + id + (suffix ? suffix : '');
  console.log('\n' + _currentTest);
  try {
    fn();
  } catch (e) {
    var msg = _currentTest + ' ABORTED — ' + e.message;
    console.log('  ✗ ' + msg);
    _logFailure(msg);
    _fail++;
  }
}

// ── Async test wrapper ───────────────────────────────────────

export async function testAsync(id, suffix, fn) {
  _currentTest = 'Test ' + id + (suffix ? suffix : '');
  console.log('\n' + _currentTest);
  try {
    await fn();
  } catch (e) {
    var msg = _currentTest + ' ABORTED — ' + e.message;
    console.log('  ✗ ' + msg);
    _logFailure(msg);
    _fail++;
  }
}

// ── Assertion ────────────────────────────────────────────────

export function check(label, condition, expected, actual) {
  var fullLabel = _currentTest + ' ' + label;
  if (condition) {
    console.log('  ✓ ' + fullLabel);
    _pass++;
  } else {
    console.log('  ✗ ' + fullLabel);
    console.log('    Expected: ' + expected);
    console.log('    Actual:   ' + actual);
    _logFailure(fullLabel + '\n    Expected: ' + expected + '\n    Actual:   ' + actual);
    _fail++;
  }
}

// ── Summary ──────────────────────────────────────────────────

export function getSummary() {
  return { pass: _pass, fail: _fail };
}

export function resetCounters() {
  _pass = 0;
  _fail = 0;
}

export function getCounters() {
  return { pass: _pass, fail: _fail };
}

// ── Failure log ──────────────────────────────────────────────

function _logFailure(msg) {
  if (_failureLog) {
    try {
      fs.appendFileSync(_failureLog, msg + '\n\n');
    } catch (e) {
      // Silently ignore log write failures
    }
  }
}

// ── Async expectError helper ─────────────────────────────────

export async function expectError(label, fn, expectedCode) {
  try {
    await fn();
    check(label, false, 'throws ' + expectedCode, 'succeeded');
  } catch (e) {
    check(label, e.message === expectedCode, expectedCode, e.message);
  }
}
