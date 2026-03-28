// ═══════════════════════════════════════════════════════════════
// Step 1 Design Groups 3, 4: Registry State Design
//
// The registry holds mutable state: active providers, snapshots,
// and initialization flags. If this state leaks, mutates
// unexpectedly, or fails to reset cleanly, authentication
// becomes unpredictable across server restarts, test runs,
// and provider hot-reloads.
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';
import { _resetForTesting, initRegistry, getProviders, getProvider,
         getJwksMap, getIssuers, getSnapshotByIssuer, isAuthEnabled,
         shutdownRegistry, _patchSnapshotForTesting } from '../../../src/auth/index.js';

// ── Group 3: Lifecycle semantics ─────────────────────────────

group('Group 3: Registry lifecycle semantics', `
  If these tests fail, the registry does not transition cleanly
  between states. A server restart leaves stale providers.
  A shutdown leaves dangling references. A re-init silently
  uses cached state instead of rescanning.
`);

var before3 = getCounters();

await testAsync('3.1.3.1-D', '', async () => {
  console.log('  _resetForTesting must clear ALL state to pristine');
  console.log('  After reset: no providers, no snapshots, not initialized, auth not required');
  _resetForTesting();
  check('getProviders() empty after reset', getProviders().length === 0, '0', String(getProviders().length));
  check('isAuthEnabled() false after reset', !isAuthEnabled(), 'false', String(isAuthEnabled()));
  check('getJwksMap() empty after reset', getJwksMap().size === 0, '0', String(getJwksMap().size));
  check('getIssuers() empty after reset', getIssuers().length === 0, '0', String(getIssuers().length));
});

await testAsync('3.1.3.2-D', '', async () => {
  console.log('  initRegistry must be callable after reset');
  console.log('  Reset → init is the test isolation pattern');
  console.log('  If init refuses to run after reset, tests cannot isolate');
  _resetForTesting();
  process.env.MOCK_AUTH_ENABLED = 'true';
  var result = await initRegistry(() => {});
  check('Init succeeds after reset', result.authEnabled === true, 'true', String(result.authEnabled));
});

await testAsync('3.1.3.3-D', '', async () => {
  console.log('  Calling initRegistry twice without reset must return cached result');
  console.log('  The registry should not rescan providers on every call');
  console.log('  This prevents duplicate providers and wasted I/O');
  var r1 = await initRegistry(() => {});
  var r2 = await initRegistry(() => {});
  check('Double init returns same providers Map', r1.providers === r2.providers,
    'same reference', 'different references');
});

await testAsync('3.1.3.4-D', '', async () => {
  console.log('  shutdownRegistry must clear providers');
  console.log('  After shutdown, no provider should be accessible');
  await shutdownRegistry(() => {});
  check('Providers cleared after shutdown', getProviders().length === 0, '0', String(getProviders().length));
  check('Auth disabled after shutdown', !isAuthEnabled(), 'false', String(isAuthEnabled()));
});

await testAsync('3.1.3.5-D', '', async () => {
  console.log('  initRegistry must be callable after shutdown (not just reset)');
  console.log('  Shutdown → init is the graceful restart pattern');
  _resetForTesting();
  process.env.MOCK_AUTH_ENABLED = 'true';
  await initRegistry(() => {});
  await shutdownRegistry(() => {});
  var r = await initRegistry(() => {});
  check('Init succeeds after shutdown', r.authEnabled === true, 'true', String(r.authEnabled));
});

await testAsync('3.1.3.6-D', '', async () => {
  console.log('  initRegistry must return a structured result object');
  console.log('  The result tells the caller what happened during scan');
  console.log('  Without this, initialization failures are silent');
  _resetForTesting();
  process.env.MOCK_AUTH_ENABLED = 'true';
  var r = await initRegistry(() => {});
  check('Result has providers field', r.providers instanceof Map, 'Map', typeof r.providers);
  check('Result has authEnabled field', typeof r.authEnabled === 'boolean', 'boolean', typeof r.authEnabled);
  check('Result has results array', Array.isArray(r.results), 'array', typeof r.results);
});

await testAsync('3.1.3.7-D', '', async () => {
  console.log('  Each result entry must include filename and status');
  console.log('  The operator needs to see which files loaded and which failed');
  _resetForTesting();
  process.env.MOCK_AUTH_ENABLED = 'true';
  var r = await initRegistry(() => {});
  for (var entry of r.results) {
    check('Result entry has filename', typeof entry.filename === 'string' && entry.filename.length > 0,
      'non-empty string', String(entry.filename));
    check('Result entry has status', typeof entry.status === 'string',
      'string', typeof entry.status);
  }
});

await testAsync('3.1.3.8-D', '', async () => {
  console.log('  shutdownRegistry must accept a logger parameter');
  console.log('  Same dependency injection pattern as initRegistry');
  check('shutdownRegistry takes at least 1 parameter',
    shutdownRegistry.length >= 1, '≥1', String(shutdownRegistry.length));
});

delete process.env.MOCK_AUTH_ENABLED;
var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

// ── Group 4: Snapshot isolation and immutability ─────────────

group('Group 4: Snapshot isolation and immutability', `
  If these tests fail, a malicious or buggy provider can
  redirect token validation after initialization. The snapshot
  system exists to freeze provider identity at registration
  time. If snapshots are mutable, bypassable, or incomplete,
  the entire auth layer is undermined.
`);

var before4 = getCounters();

_resetForTesting();
process.env.MOCK_AUTH_ENABLED = 'true';
await initRegistry(() => {});

test('3.1.4.1-D', '', () => {
  console.log('  getSnapshotByIssuer must return a frozen object');
  console.log('  Frozen = Object.isFrozen. Cannot add, remove, or change properties');
  var snap = getSnapshotByIssuer('https://mock-auth.test/');
  check('Snapshot exists', snap !== null, 'non-null', 'null');
  check('Snapshot is frozen', Object.isFrozen(snap), 'frozen', 'not frozen');
});

test('3.1.4.2-D', '', () => {
  console.log('  Snapshot must contain all security-critical fields');
  console.log('  issuer, jwksUri, audience — these determine token validation');
  console.log('  If any is missing from the snapshot, middleware falls through to live object');
  var snap = getSnapshotByIssuer('https://mock-auth.test/');
  if (!snap) { check('Snapshot exists', false, 'exists', 'null'); return; }
  check('Snapshot has issuer', typeof snap.issuer === 'string', 'string', typeof snap.issuer);
  check('Snapshot has jwksUri', typeof snap.jwksUri === 'string', 'string', typeof snap.jwksUri);
  check('Snapshot has audience', typeof snap.audience === 'string', 'string', typeof snap.audience);
  check('Snapshot has name', typeof snap.name === 'string', 'string', typeof snap.name);
  check('Snapshot has type', typeof snap.type === 'string', 'string', typeof snap.type);
  check('Snapshot has priority', typeof snap.priority === 'number', 'number', typeof snap.priority);
});

test('3.1.4.3-D', '', () => {
  console.log('  getJwksMap must read from snapshots, not live providers');
  console.log('  Checking: the returned Map keys match snapshot issuers');
  var map = getJwksMap();
  var snap = getSnapshotByIssuer('https://mock-auth.test/');
  check('JWKS map contains snapshot issuer', map.has(snap.issuer),
    'has ' + snap.issuer, 'missing');
  check('JWKS map value matches snapshot jwksUri', map.get(snap.issuer) === snap.jwksUri,
    snap.jwksUri, map.get(snap.issuer));
});

test('3.1.4.4-D', '', () => {
  console.log('  getJwksMap must return a NEW Map on each call');
  console.log('  If it returns the internal Map, consumers can inject fake JWKS endpoints');
  var m1 = getJwksMap();
  var m2 = getJwksMap();
  check('Different Map references', m1 !== m2, 'different', 'same reference');
});

test('3.1.4.5-D', '', () => {
  console.log('  Mutating the returned Map must not affect the registry');
  var map = getJwksMap();
  map.set('https://evil.com/', 'https://evil.com/jwks');
  var fresh = getJwksMap();
  check('Evil entry not in fresh Map', !fresh.has('https://evil.com/'),
    'absent', 'injected');
});

test('3.1.4.6-D', '', () => {
  console.log('  getIssuers must return a NEW array on each call');
  var a1 = getIssuers();
  var a2 = getIssuers();
  check('Different array references', a1 !== a2, 'different', 'same reference');
});

test('3.1.4.7-D', '', () => {
  console.log('  Mutating the returned array must not affect the registry');
  var arr = getIssuers();
  arr.push('https://evil.com/');
  var fresh = getIssuers();
  check('Evil issuer not in fresh array', !fresh.includes('https://evil.com/'),
    'absent', 'injected');
});

test('3.1.4.8-D', '', () => {
  console.log('  getSnapshotByIssuer for unknown issuer must return null');
  console.log('  Not undefined, not throw — null signals "not found" cleanly');
  var result = getSnapshotByIssuer('https://nonexistent.com/');
  check('Unknown issuer returns null', result === null, 'null', String(result));
});

test('3.1.4.9-D', '', () => {
  console.log('  _patchSnapshotForTesting must refuse to run in production');
  console.log('  This is a test-only escape hatch — it must not exist in prod');
  var orig = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    _patchSnapshotForTesting('mock', { jwksUri: 'https://evil.com/' });
    check('Patch blocked in production', false, 'throws', 'succeeded — CRITICAL');
  } catch (e) {
    check('Patch blocked in production', true, 'throws', 'throws');
  }
  process.env.NODE_ENV = orig;
});

test('3.1.4.10-D', '', () => {
  console.log('  _patchSnapshotForTesting for nonexistent provider must throw');
  console.log('  Silently accepting a bad name would create confusion in test failures');
  try {
    _patchSnapshotForTesting('nonexistent_provider', { jwksUri: 'x' });
    check('Patch for unknown provider throws', false, 'throws', 'succeeded');
  } catch (e) {
    check('Patch for unknown provider throws', true, 'throws', 'throws');
  }
});

delete process.env.MOCK_AUTH_ENABLED;
var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
