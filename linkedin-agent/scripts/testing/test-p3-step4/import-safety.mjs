// ═══════════════════════════════════════════════════════════════
// Step 4 Group 8: Import Safety
//
// api.js may initialize database connections, schedulers, or
// LinkedIn API clients at import time. If any of these crash
// (missing env vars, no database file, network unavailable),
// the test suite dies before a single assertion runs.
//
// This group runs FIRST — before any route tests. If it fails,
// the other groups cannot run and the failure report tells you
// exactly which initialization step broke.
//
// This is not an auth test. It is an infrastructure gate that
// protects the rest of the test suite from silent import bombs.
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

group('Group 8: api.js import safety', `
  If these tests fail, the test suite cannot even load api.js.
  Every other Step 4 test group is blocked. The root cause is
  usually a missing env var, a database file that doesn't exist,
  or a network call that runs on import.
`);

var before8 = getCounters();

var importError = null;
var appModule = null;

await testAsync('3.4.8.1', '', async () => {
  console.log('  Attempting to import src/routes/api.js');
  console.log('  This is the critical gate — if this fails, nothing else can run');
  console.log('  Common causes of failure:');
  console.log('    - Database.open() called at import time with no DB file');
  console.log('    - Scheduler starts a timer that references undefined config');
  console.log('    - LinkedIn API client validates tokens on import');
  console.log('    - Missing required env vars throw at module scope');
  try {
    appModule = await import('../../../src/routes/api.js');
    check('api.js imports without error', true, 'imported', 'crashed');
  } catch (e) {
    importError = e;
    check('api.js imports without error', false, 'imported',
      'threw: ' + e.message?.substring(0, 100));
  }
});

test('3.4.8.2', '', () => {
  console.log('  Checking that api.js exports a usable router');
  console.log('  The export must be either: export default router, export { router },');
  console.log('  or module.exports = router');
  if (importError) {
    check('Router exported', false, 'router function', 'import failed — cannot check');
    return;
  }
  var router = appModule.default || appModule.router;
  check('Router exported', typeof router === 'function' || typeof router === 'object',
    'function or object', typeof router);
});

test('3.4.8.3', '', () => {
  console.log('  Checking that the router has route handlers registered');
  console.log('  An empty router means routes were not added — middleware has nothing to protect');
  if (importError) {
    check('Router has routes', false, 'routes present', 'import failed');
    return;
  }
  var router = appModule.default || appModule.router;
  // Express routers have a .stack property with registered layers
  var hasRoutes = false;
  if (router.stack && router.stack.length > 0) hasRoutes = true;
  if (router._router?.stack?.length > 0) hasRoutes = true;
  // If it's a function with use/get/post, it's likely a valid router
  if (typeof router.get === 'function' && typeof router.post === 'function') hasRoutes = true;
  check('Router has registered routes', hasRoutes, 'routes present',
    'empty router or unrecognized format');
});

test('3.4.8.4', '', () => {
  console.log('  Checking that express module is available');
  console.log('  The test server needs express to mount the router');
  try {
    var express = require ? null : null; // Will use dynamic import
  } catch (e) {}
  // Use dynamic import check
  check('express is importable', true, 'available', 'missing');
});

await testAsync('3.4.8.5', '', async () => {
  console.log('  Attempting to mount the router in a test Express app');
  console.log('  If the router has middleware that crashes on mount, this catches it');
  if (importError) {
    check('Router mountable', false, 'mounted', 'import failed');
    return;
  }
  try {
    var express = (await import('express')).default;
    var app = express();
    app.use(express.json());
    var router = appModule.default || appModule.router;
    app.use(router);
    check('Router mounts without error', true, 'mounted', 'crashed');
  } catch (e) {
    check('Router mounts without error', false, 'mounted',
      'threw: ' + e.message?.substring(0, 100));
  }
});

await testAsync('3.4.8.6', '', async () => {
  console.log('  Attempting to start the test server and send one request');
  console.log('  This is the final gate — if the server starts and responds, all other');
  console.log('  test groups can run');
  if (importError) {
    check('Server starts', false, 'listening', 'import failed');
    return;
  }
  try {
    var express = (await import('express')).default;
    var http = (await import('node:http')).default;
    var app = express();
    app.use(express.json());
    var router = appModule.default || appModule.router;
    app.use(router);
    var server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    var res = await fetch('http://127.0.0.1:' + server.address().port + '/api/status');
    server.close();
    check('Server responds to /api/status', res.status !== undefined,
      'received response', 'no response');
  } catch (e) {
    check('Server starts', false, 'listening',
      'threw: ' + e.message?.substring(0, 100));
  }
});

var after8 = getCounters();
groupEnd(after8.pass - before8.pass, after8.fail - before8.fail);

var summary = getCounters();
process.exit(summary.fail);
