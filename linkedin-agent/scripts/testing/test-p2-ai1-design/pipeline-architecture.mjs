// ═══════════════════════════════════════════════════════════════
// Phase 2 AI-1/AI-3 Design: Module Architecture
// Verifies the three new modules exist, export the right API,
// and are integrated into the pipeline at the correct points.
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

// ── Read source files ────────────────────────────────────────
var sanitizeSrc = '';
try { sanitizeSrc = fs.readFileSync('src/services/sanitize-content.js', 'utf8'); } catch {}
var framingSrc = '';
try { framingSrc = fs.readFileSync('src/services/prompt-framing.js', 'utf8'); } catch {}
var filterSrc = '';
try { filterSrc = fs.readFileSync('src/services/output-filter.js', 'utf8'); } catch {}
var monitorSrc = '';
try { monitorSrc = fs.readFileSync('src/services/news-monitor.js', 'utf8'); } catch {}
var generatorSrc = '';
try { generatorSrc = fs.readFileSync('src/services/content-generator.js', 'utf8'); } catch {}
var schedulerSrc = '';
try { schedulerSrc = fs.readFileSync('src/services/scheduler.js', 'utf8'); } catch {}

console.log('  File: test-p2-ai1-design/pipeline-architecture.mjs');
group('Group 1: New module structure', `
  Impact: If these modules don't exist or export the wrong API,
  the pipeline cannot call them. The sanitization, framing,
  and filtering simply don't run.

  Files: src/services/sanitize-content.js
         src/services/prompt-framing.js
         src/services/output-filter.js
`);

var before1 = getCounters();

await testAsync('2.0.1.1-D', ' sanitize-content.js exists', async () => {
  check('File exists', sanitizeSrc.length > 0, 'found', 'not found');
});

await testAsync('2.0.1.2-D', ' sanitize-content.js exports sanitizeTitle', async () => {
  check('sanitizeTitle exported', sanitizeSrc.includes('export function sanitizeTitle') ||
    sanitizeSrc.includes('export { sanitizeTitle'), 'found', 'not found');
});

await testAsync('2.0.1.3-D', ' sanitize-content.js exports sanitizeSummary', async () => {
  check('sanitizeSummary exported', sanitizeSrc.includes('export function sanitizeSummary') ||
    sanitizeSrc.includes('export { sanitizeSummary'), 'found', 'not found');
});

await testAsync('2.0.1.4-D', ' sanitize-content.js exports detectPromptInjection', async () => {
  check('detectPromptInjection exported', sanitizeSrc.includes('export function detectPromptInjection') ||
    sanitizeSrc.includes('export { detectPromptInjection'), 'found', 'not found');
});

await testAsync('2.0.1.5-D', ' prompt-framing.js exists', async () => {
  check('File exists', framingSrc.length > 0, 'found', 'not found');
});

await testAsync('2.0.1.6-D', ' prompt-framing.js exports frameUntrustedContent', async () => {
  check('frameUntrustedContent exported', framingSrc.includes('export function frameUntrustedContent') ||
    framingSrc.includes('export { frameUntrustedContent'), 'found', 'not found');
});

await testAsync('2.0.1.7-D', ' prompt-framing.js exports boundary constants', async () => {
  check('PREFIX constant', framingSrc.includes('UNTRUSTED_CONTENT_PREFIX'), 'found', 'not found');
  check('SUFFIX constant', framingSrc.includes('UNTRUSTED_CONTENT_SUFFIX'), 'found', 'not found');
});

await testAsync('2.0.1.8-D', ' output-filter.js exists', async () => {
  check('File exists', filterSrc.length > 0, 'found', 'not found');
});

await testAsync('2.0.1.9-D', ' output-filter.js exports scanForSecrets', async () => {
  check('scanForSecrets exported', filterSrc.includes('export function scanForSecrets') ||
    filterSrc.includes('export { scanForSecrets'), 'found', 'not found');
});

await testAsync('2.0.1.10-D', ' output-filter.js exports runOutputFilter', async () => {
  check('runOutputFilter exported', filterSrc.includes('export function runOutputFilter') ||
    filterSrc.includes('export { runOutputFilter'), 'found', 'not found');
});

await testAsync('2.0.1.11-D', ' sanitize-content.js exports sanitizeLink', async () => {
  check('sanitizeLink exported', sanitizeSrc.includes('export function sanitizeLink') ||
    sanitizeSrc.includes('export { sanitizeLink'), 'found', 'not found');
});

var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

console.log('  File: test-p2-ai1-design/pipeline-architecture.mjs');
group('Group 2: Pipeline integration points', `
  Impact: If the new modules are not integrated into the existing
  pipeline, they exist as dead code. RSS content flows unsanitized,
  prompts include unframed content, and posts publish unfiltered.

  Integration points:
  - news-monitor.js must call sanitizeTitle/sanitizeSummary
  - content-generator.js must call frameUntrustedContent
  - scheduler.js must call runOutputFilter before publishPost
`);

var before2 = getCounters();

await testAsync('2.0.2.1-D', ' news-monitor.js imports sanitize-content', async () => {
  console.log('  news-monitor.js must import sanitization functions');
  console.log('  Checking: import from sanitize-content.js in source');
  check('Sanitization import', monitorSrc.includes('sanitize-content'),
    'found', 'not found');
});

await testAsync('2.0.2.2-D', ' news-monitor.js calls sanitizeTitle', async () => {
  console.log('  Feed titles must be sanitized before database insertion');
  console.log('  Checking: sanitizeTitle call in source');
  check('sanitizeTitle called', monitorSrc.includes('sanitizeTitle'),
    'found', 'not found');
});

await testAsync('2.0.2.3-D', ' news-monitor.js calls sanitizeSummary', async () => {
  console.log('  Feed summaries must be sanitized before database insertion');
  check('sanitizeSummary called', monitorSrc.includes('sanitizeSummary'),
    'found', 'not found');
});

await testAsync('2.0.2.3b-D', ' news-monitor.js calls sanitizeLink', async () => {
  console.log('  Feed links must be sanitized before database insertion');
  console.log('  Rejects javascript:, data:, and excessively long URLs');
  check('sanitizeLink called', monitorSrc.includes('sanitizeLink'),
    'found', 'not found');
});

await testAsync('2.0.2.4-D', ' content-generator.js imports prompt-framing', async () => {
  console.log('  Research context must be framed before prompt injection');
  check('Framing import', generatorSrc.includes('prompt-framing'),
    'found', 'not found');
});

await testAsync('2.0.2.5-D', ' content-generator.js calls frameUntrustedContent', async () => {
  console.log('  Research brief context must be wrapped with untrusted markers');
  check('frameUntrustedContent called', generatorSrc.includes('frameUntrustedContent'),
    'found', 'not found');
});

await testAsync('2.0.2.6-D', ' scheduler.js imports output-filter', async () => {
  console.log('  Generated content must be filtered before publishing');
  check('Filter import', schedulerSrc.includes('output-filter'),
    'found', 'not found');
});

await testAsync('2.0.2.7-D', ' scheduler.js calls runOutputFilter', async () => {
  console.log('  runOutputFilter must be called before publishPost');
  check('runOutputFilter called', schedulerSrc.includes('runOutputFilter'),
    'found', 'not found');
});

await testAsync('2.0.2.8-D', ' Filter runs BEFORE publishPost', async () => {
  console.log('  In scheduler.js, runOutputFilter must appear before publishPost call');
  console.log('  If filter runs after publish, the post is already public');
  var filterPos = schedulerSrc.indexOf('runOutputFilter');
  var publishPos = schedulerSrc.indexOf('publishPost');
  if (filterPos < 0 || publishPos < 0) {
    check('Both present in scheduler', false, 'both found',
      'filter=' + (filterPos >= 0) + ' publish=' + (publishPos >= 0));
    return;
  }
  check('Filter before publish', filterPos < publishPos,
    'filter first', 'filterPos=' + filterPos + ' publishPos=' + publishPos);
});

var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

console.log('  File: test-p2-ai1-design/pipeline-architecture.mjs');
group('Group 3: Security properties of new modules', `
  Impact: If the modules have poor security properties —
  no error handling, console.log of content, or regex that
  catastrophically backtracks — they become vulnerabilities
  rather than defenses.
`);

var before3 = getCounters();

await testAsync('2.0.3.1-D', ' sanitize-content.js has no console.log', async () => {
  console.log('  Sanitized content may contain sensitive data — never log it');
  var codeLines = sanitizeSrc.split('\n').filter(l =>
    !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  var hasLog = codeLines.some(l => l.includes('console.log'));
  check('No console.log', !hasLog, 'clean', 'console.log found');
});

await testAsync('2.0.3.2-D', ' output-filter.js has no console.log', async () => {
  var codeLines = filterSrc.split('\n').filter(l =>
    !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  var hasLog = codeLines.some(l => l.includes('console.log'));
  check('No console.log', !hasLog, 'clean', 'console.log found');
});

await testAsync('2.0.3.3-D', ' No hardcoded API key patterns used as examples', async () => {
  console.log('  The modules should not contain example API keys in source');
  var allSrc = sanitizeSrc + framingSrc + filterSrc;
  var hasExampleKey = allSrc.includes('sk-ant-api03-abc') || allSrc.includes('AKIAIOSFODNN7');
  check('No example keys in source', !hasExampleKey, 'clean', 'example key found');
});

await testAsync('2.0.3.4-D', ' detectPromptInjection returns structured result', async () => {
  console.log('  Must return { detected: boolean, patterns: string[] }');
  console.log('  Not just a boolean — the caller needs to know which pattern matched');
  check('Returns detected field', sanitizeSrc.includes('detected'), 'found', 'not found');
});

await testAsync('2.0.3.5-D', ' runOutputFilter returns structured result', async () => {
  console.log('  Must return { blocked: boolean, reason: string, checks: [] }');
  check('Returns blocked field', filterSrc.includes('blocked'), 'found', 'not found');
  check('Returns reason field', filterSrc.includes('reason'), 'found', 'not found');
});

await testAsync('2.0.3.6-D', ' Modules use named exports only', async () => {
  console.log('  No default exports — named exports are explicit and grep-friendly');
  var hasDefault = sanitizeSrc.includes('export default') ||
    framingSrc.includes('export default') ||
    filterSrc.includes('export default');
  check('No default exports', !hasDefault, 'named only', 'has default export');
});

await testAsync('2.0.3.7-D', ' news-monitor.js calls detectPromptInjection', async () => {
  console.log('  Feed content should be checked for injection before database storage');
  console.log('  Flagged articles can be logged and excluded from research briefs');
  check('detectPromptInjection called', monitorSrc.includes('detectPromptInjection'),
    'found', 'not found');
});

var after3 = getCounters();
groupEnd(after3.pass - before3.pass, after3.fail - before3.fail);

var summary = getCounters();
process.exit(summary.fail);
