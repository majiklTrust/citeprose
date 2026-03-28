// ═══════════════════════════════════════════════════════════════
// Step 5 Design Groups 1-2: Module Architecture and Crypto
// Reads source code to verify export contracts, import boundaries,
// and cryptographic implementation choices
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

// ── Read source files ────────────────────────────────────────
var sessionSrc = '';
var middlewareSrc = '';
try { sessionSrc = fs.readFileSync('src/auth/session.js', 'utf8'); } catch {}
try { middlewareSrc = fs.readFileSync('src/auth/middleware.js', 'utf8'); } catch {}

// Import the module to check exports
var sessionModule = null;
try { sessionModule = await import('../../../src/auth/session.js'); } catch {}

// ── Group 1: Module export contracts ─────────────────────────
group('Group 1: Session module export contracts', `
  Impact: If these tests fail, consumers of session.js cannot rely
  on a stable API. The middleware imports specific named exports —
  if they are renamed, moved, or changed to a default export,
  the middleware breaks and every request gets 500.

  Module under test: src/auth/session.js
  Check method: dynamic import + typeof inspection
`);

var before1 = getCounters();

await testAsync('3.5.1.1-D', 'createSession is a named function export', async () => {
  console.log('  Importing src/auth/session.js via dynamic import');
  console.log('  Checking: module has a named export "createSession"');
  console.log('  typeof must be "function" — not a class, not an object');
  console.log('  The middleware calls createSession(res, tokens) during the login callback');
  check('createSession is named export', typeof sessionModule?.createSession === 'function',
    'function', typeof sessionModule?.createSession);
});

await testAsync('3.5.1.2-D', 'readSession is a named function export', async () => {
  console.log('  Checking: module has a named export "readSession"');
  console.log('  The middleware calls readSession(req) on every request to check for a session');
  check('readSession is named export', typeof sessionModule?.readSession === 'function',
    'function', typeof sessionModule?.readSession);
});

await testAsync('3.5.1.3-D', 'clearSession is a named function export', async () => {
  console.log('  Checking: module has a named export "clearSession"');
  console.log('  The logout route calls clearSession(res) to expire the cookie');
  check('clearSession is named export', typeof sessionModule?.clearSession === 'function',
    'function', typeof sessionModule?.clearSession);
});

await testAsync('3.5.1.4-D', 'isSessionExpiring is a named function export', async () => {
  console.log('  Checking: module has a named export "isSessionExpiring"');
  console.log('  The middleware uses this to decide whether to attempt a token refresh');
  check('isSessionExpiring is named export', typeof sessionModule?.isSessionExpiring === 'function',
    'function', typeof sessionModule?.isSessionExpiring);
});

await testAsync('3.5.1.5-D', 'SESSION_COOKIE_NAME is a named string constant', async () => {
  console.log('  Checking: module exports SESSION_COOKIE_NAME as a string');
  console.log('  This constant must be the same value used in createSession, readSession, clearSession');
  console.log('  A mismatch means cookies are set under one name and read under another');
  check('SESSION_COOKIE_NAME is string', typeof sessionModule?.SESSION_COOKIE_NAME === 'string' &&
    sessionModule.SESSION_COOKIE_NAME.length > 0,
    'non-empty string', typeof sessionModule?.SESSION_COOKIE_NAME + ': ' + String(sessionModule?.SESSION_COOKIE_NAME));
});

await testAsync('3.5.1.6-D', 'SESSION_MAX_AGE_MS is a named number constant', async () => {
  console.log('  Checking: module exports SESSION_MAX_AGE_MS as a number');
  console.log('  This value sets the cookie maxAge — must be a positive number');
  console.log('  A negative or zero value would create a session-only cookie (deleted on browser close)');
  check('SESSION_MAX_AGE_MS is positive number',
    typeof sessionModule?.SESSION_MAX_AGE_MS === 'number' && sessionModule.SESSION_MAX_AGE_MS > 0,
    'positive number', typeof sessionModule?.SESSION_MAX_AGE_MS + ': ' + String(sessionModule?.SESSION_MAX_AGE_MS));
});

await testAsync('3.5.1.7-D', 'No default export', async () => {
  console.log('  session.js must not have a default export');
  console.log('  Default exports allow import-as-anything: import foo from "./session.js"');
  console.log('  Named exports enforce consistent naming across the codebase');
  var hasDefault = sessionModule?.default !== undefined;
  check('No default export', !hasDefault, 'no default', 'default export found');
});

await testAsync('3.5.1.8-D', 'session.js does not export encryption internals', async () => {
  console.log('  Checking that encrypt/decrypt helper functions are not exported');
  console.log('  Internal functions like encrypt(), decrypt(), deriveKey() must stay private');
  console.log('  Exporting them would allow consumers to bypass the session abstraction');
  var hasEncrypt = typeof sessionModule?.encrypt === 'function';
  var hasDecrypt = typeof sessionModule?.decrypt === 'function';
  var hasDeriveKey = typeof sessionModule?.deriveKey === 'function';
  check('No encrypt export', !hasEncrypt, 'not exported', 'exported');
  check('No decrypt export', !hasDecrypt, 'not exported', 'exported');
  check('No deriveKey export', !hasDeriveKey, 'not exported', 'exported');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: Import boundaries and dependencies ──────────────
group('Group 2: Import boundaries and dependencies', `
  Impact: If these tests fail, session.js has upward or circular
  dependencies. A change to the database, routes, or providers
  breaks the session layer. session.js should depend only on
  Node crypto and environment variables — nothing application-specific.

  Check method: grep source code for import statements
`);

var before2 = getCounters();

await testAsync('3.5.2.1-D', 'session.js imports only from Node built-ins', async () => {
  console.log('  Reading src/auth/session.js source code');
  console.log('  Scanning all import lines for non-Node dependencies');
  console.log('  session.js should import from "node:crypto" or "crypto" — nothing else');
  console.log('  It must NOT import from express, jose, database, routes, or providers');
  var importLines = sessionSrc.split('\n').filter(l => l.match(/^\s*import\s/));
  console.log('  Found ' + importLines.length + ' import line(s)');
  var badImports = importLines.filter(l =>
    !l.includes('node:crypto') && !l.includes("'crypto'") && !l.includes('"crypto"')
  );
  check('Only crypto imports', badImports.length === 0,
    '0 non-crypto imports', badImports.length + ' non-crypto: ' + badImports.join('; ').substring(0, 80));
});

await testAsync('3.5.2.2-D', 'session.js does not import jose', async () => {
  console.log('  jose is the JWT library — session.js handles encryption, not JWT verification');
  console.log('  JWT verification belongs in jwt-verifier.js (single jose import point)');
  console.log('  Checking: no import/require of "jose" in session.js');
  var hasJose = sessionSrc.includes("from 'jose'") || sessionSrc.includes('from "jose"') ||
    sessionSrc.includes("require('jose')");
  check('No jose import', !hasJose, 'no jose', 'jose found');
});

await testAsync('3.5.2.3-D', 'session.js does not import from routes or services', async () => {
  console.log('  session.js is a foundational auth layer — no business logic dependencies');
  console.log('  Checking: no imports from ../routes/, ../services/, or ./providers/');
  var hasRoutes = sessionSrc.includes('/routes/');
  var hasServices = sessionSrc.includes('/services/');
  var hasProviders = sessionSrc.includes('/providers/');
  check('No routes import', !hasRoutes, 'clean', 'imports routes');
  check('No services import', !hasServices, 'clean', 'imports services');
  check('No providers import', !hasProviders, 'clean', 'imports providers');
});

await testAsync('3.5.2.4-D', 'session.js does not import from the registry', async () => {
  console.log('  session.js must not import from ./index.js (the auth registry)');
  console.log('  The session layer encrypts/decrypts — it does not know about providers');
  console.log('  The middleware orchestrates between session.js and the registry');
  var hasRegistry = sessionSrc.includes("from './index.js'") ||
    sessionSrc.includes('from "./index.js"') ||
    sessionSrc.includes("from '../auth/index.js'");
  check('No registry import', !hasRegistry, 'clean', 'imports registry');
});

await testAsync('3.5.2.5-D', 'middleware.js imports readSession from session.js', async () => {
  console.log('  Reading src/auth/middleware.js source code');
  console.log('  The middleware needs readSession to check session cookies');
  console.log('  Checking: middleware.js has an import from "./session.js" or "../auth/session.js"');
  var hasSessionImport = middlewareSrc.includes('session.js');
  check('Middleware imports session', hasSessionImport,
    'imports session.js', 'no session import');
});

await testAsync('3.5.2.6-D', 'SESSION_SECRET referenced in source', async () => {
  console.log('  Checking that session.js reads SESSION_SECRET from process.env');
  console.log('  The secret must come from environment, not hardcoded');
  console.log('  Checking: source contains "SESSION_SECRET"');
  var hasSecret = sessionSrc.includes('SESSION_SECRET');
  check('SESSION_SECRET in source', hasSecret, 'found', 'not found');
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Cleanup ──────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
