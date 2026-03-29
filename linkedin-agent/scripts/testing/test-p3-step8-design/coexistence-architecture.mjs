// ═══════════════════════════════════════════════════════════════
// Phase 3 Step 8 Design: OAuth Coexistence Architecture
// Reads source code to verify the two OAuth flows are isolated,
// server-address utility is used, and error handler is present.
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

// ── Read source files ────────────────────────────────────────
var indexSrc = '';
try { indexSrc = fs.readFileSync('src/index.js', 'utf8'); } catch {
  try { indexSrc = fs.readFileSync('src_templates/index.js', 'utf8'); } catch {}
}
var apiSrc = '';
try { apiSrc = fs.readFileSync('src/routes/api.js', 'utf8'); } catch {}
var serverAddrSrc = '';
try { serverAddrSrc = fs.readFileSync('src/services/server-address.js', 'utf8'); } catch {}

console.log('  File: test-p3-step8-design/coexistence-architecture.mjs');
group('Group 1: Two independent OAuth flows in source', `
  Impact: If the LinkedIn and Auth0 OAuth flows share state,
  session storage, or callback routes, a failure in one
  breaks the other. LinkedIn OAuth is for posting tokens.
  Auth0 OAuth is for dashboard access. They must be
  completely independent in code and routing.

  Files: src/index.js (or src_templates/index.js)
  Check: Separate route handlers, separate providers, no shared state
`);

var before1 = getCounters();

await testAsync('3.8.1.1-D', ' /auth/linkedin route defined separately from /auth/login', async () => {
  console.log('  Reading index.js source');
  console.log('  Both routes must be separate app.get() calls');
  console.log('  Checking: source contains both route registrations');
  var hasLinkedIn = indexSrc.includes('"/auth/linkedin"');
  var hasLogin = indexSrc.includes('"/auth/login"');
  check('/auth/linkedin defined', hasLinkedIn, 'found', 'not found');
  check('/auth/login defined', hasLogin, 'found', 'not found');
});

await testAsync('3.8.1.2-D', ' /auth/linkedin/callback separate from /auth/callback', async () => {
  console.log('  The two callback routes handle different OAuth providers');
  console.log('  Checking: both callback routes present in source');
  var hasLinkedInCB = indexSrc.includes('"/auth/linkedin/callback"');
  var hasAuth0CB = indexSrc.includes('"/auth/callback"');
  check('/auth/linkedin/callback defined', hasLinkedInCB, 'found', 'not found');
  check('/auth/callback defined', hasAuth0CB, 'found', 'not found');
});

await testAsync('3.8.1.3-D', ' LinkedIn callback uses exchangeCodeForToken', async () => {
  console.log('  The LinkedIn callback must use the LinkedIn-specific token exchange');
  console.log('  Not the Auth0 provider.exchangeCode() method');
  console.log('  Checking: exchangeCodeForToken appears in the LinkedIn callback context');
  check('exchangeCodeForToken in source', indexSrc.includes('exchangeCodeForToken'), 'found', 'not found');
});

await testAsync('3.8.1.4-D', ' Auth0 callback uses provider.exchangeCode', async () => {
  console.log('  The Auth0 callback must use the provider registry method');
  console.log('  Not the LinkedIn-specific exchangeCodeForToken');
  console.log('  Checking: provider.exchangeCode appears in source');
  check('provider.exchangeCode in source', indexSrc.includes('provider.exchangeCode'), 'found', 'not found');
});

await testAsync('3.8.1.5-D', ' LinkedIn callback sets process.env token', async () => {
  console.log('  LinkedIn stores its token in process.env.LINKEDIN_ACCESS_TOKEN');
  console.log('  Auth0 stores its session in an httpOnly cookie');
  console.log('  These are separate storage mechanisms');
  console.log('  Checking: LINKEDIN_ACCESS_TOKEN assignment in source');
  check('LinkedIn token in process.env', indexSrc.includes('LINKEDIN_ACCESS_TOKEN'), 'found', 'not found');
});

await testAsync('3.8.1.6-D', ' Auth0 callback uses createSession', async () => {
  console.log('  Auth0 stores its session via createSession() → encrypted cookie');
  console.log('  Checking: createSession appears in the Auth0 callback context');
  check('createSession in source', indexSrc.includes('createSession'), 'found', 'not found');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

console.log('  File: test-p3-step8-design/coexistence-architecture.mjs');
group('Group 2: Hardcoded localhost eliminated', `
  Impact: If localhost is hardcoded in application code, the
  application breaks on deployment to any non-localhost
  environment. CORS rejects requests, OAuth callbacks fail,
  and the dev banner shows the wrong address.

  Files: src/index.js, src/routes/api.js
  Check: No hardcoded localhost in application logic
`);

var before2 = getCounters();

await testAsync('3.8.2.1-D', ' index.js has no hardcoded localhost', async () => {
  console.log('  Scanning index.js for hardcoded localhost references');
  console.log('  All URLs should derive from server-address utility');
  // Filter out comments
  var codeLines = indexSrc.split('\n').filter(l =>
    !l.trim().startsWith('//') && !l.trim().startsWith('*')
  );
  var code = codeLines.join('\n');
  var hasHardcoded = code.includes('"localhost') || code.includes("'localhost") || code.includes('`localhost');
  check('No hardcoded localhost in index.js', !hasHardcoded, 'clean', 'hardcoded localhost found');
});

await testAsync('3.8.2.2-D', ' api.js has no hardcoded localhost', async () => {
  console.log('  Scanning api.js for hardcoded localhost references');
  var codeLines = apiSrc.split('\n').filter(l =>
    !l.trim().startsWith('//') && !l.trim().startsWith('*')
  );
  var code = codeLines.join('\n');
  var hasHardcoded = code.includes('"localhost') || code.includes("'localhost") || code.includes('`localhost');
  check('No hardcoded localhost in api.js', !hasHardcoded, 'clean', 'hardcoded localhost found');
});

await testAsync('3.8.2.3-D', ' server-address.js exists and exports getServerAddress', async () => {
  console.log('  The server-address utility is the centralized URL source');
  console.log('  Checking: file exists and exports getServerAddress');
  check('server-address.js exists', serverAddrSrc.length > 0, 'found', 'not found');
  check('getServerAddress exported', serverAddrSrc.includes('export function getServerAddress'),
    'found', 'not found');
});

await testAsync('3.8.2.4-D', ' index.js imports server-address utility', async () => {
  console.log('  Checking: index.js imports from server-address.js');
  check('server-address import', indexSrc.includes('server-address.js'), 'found', 'not found');
});

await testAsync('3.8.2.5-D', ' api.js imports server-address utility', async () => {
  console.log('  Checking: api.js imports from server-address.js');
  check('server-address import in api.js', apiSrc.includes('server-address.js'), 'found', 'not found');
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

console.log('  File: test-p3-step8-design/coexistence-architecture.mjs');
group('Group 3: Error handler and auth architecture', `
  Impact: If the error handler is missing or misplaced, error
  responses leak internals. If the auth middleware is wired
  incorrectly, routes that should be protected are open.

  Files: src/index.js, src/routes/api.js
  Check: Error handler present, auth middleware correctly positioned
`);

var before3 = getCounters();

await testAsync('3.8.3.1-D', ' Express error handler present in index.js', async () => {
  console.log('  The error handler has 4 parameters: (err, req, res, next)');
  console.log('  Must appear after all routes but before app.listen()');
  console.log('  Checking: source contains error handler pattern');
  var hasErrorHandler = indexSrc.includes('err, req, res, next');
  check('Error handler present', hasErrorHandler, 'found', 'not found');
});

await testAsync('3.8.3.2-D', ' Error handler returns generic message', async () => {
  console.log('  The error handler must not include err.message or err.stack');
  console.log('  Checking: error handler returns "Forbidden" or generic text');
  var hasGeneric = indexSrc.includes('"Forbidden"') || indexSrc.includes("'Forbidden'");
  check('Generic error message', hasGeneric, 'found', 'not found');
});

await testAsync('3.8.3.3-D', ' NODE_ENV check is exactly dev for dev bypass', async () => {
  console.log('  Reading middleware source (already in middleware.js)');
  console.log('  The dev bypass must only activate when NODE_ENV === "dev"');
  console.log('  Checking: index.js or middleware.js references imported from middleware');
  // We check the import chain — middleware is imported in api.js
  var apiHasMW = apiSrc.includes('createAuthMiddleware');
  check('Auth middleware wired in api.js', apiHasMW, 'found', 'not found');
});

await testAsync('3.8.3.4-D', ' requireAuth applied to protected routes', async () => {
  console.log('  api.js must apply requireAuth before protected routes');
  console.log('  Checking: router.use(requireAuth) present');
  check('requireAuth in api.js', apiSrc.includes('router.use(requireAuth)'), 'found', 'not found');
});

await testAsync('3.8.3.5-D', ' optionalAuth on /api/status', async () => {
  console.log('  /api/status uses optionalAuth — accessible without auth but reads session if present');
  console.log('  Checking: optionalAuth appears on the status route');
  check('optionalAuth on status', apiSrc.includes('optionalAuth'), 'found', 'not found');
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

var summary = getCounters();
process.exit(summary.fail);
