// ═══════════════════════════════════════════════════════════════
// Phase 2 AI-3 Groups 4-5: Output Content Filter
// Scans generated content before publishing for leaked secrets,
// prompt fragments, and exfiltration attempts.
// ═══════════════════════════════════════════════════════════════
import { group, groupEnd, test, testAsync, check, getCounters } from '../lib/test-harness.mjs';

import {
  scanForSecrets,
  scanForPromptLeak,
  scanForExfiltration,
  runOutputFilter
} from '../../../src/services/output-filter.js';

console.log('  File: test-p2-ai1/output-filter.mjs');
group('Group 4: Secret detection in generated content', `
  Impact: If these tests fail, a prompt injection can instruct the
  AI to include API keys, session secrets, or internal configuration
  in the generated post. That post publishes to LinkedIn. Your
  Anthropic API key is now public. Financial exposure is immediate.

  Module: src/services/output-filter.js
  Function: scanForSecrets(content)
`);

var before4 = getCounters();

await testAsync('2.3.4.1', ' Detects Anthropic API key pattern', async () => {
  console.log('  Anthropic keys start with "sk-ant-" followed by alphanumeric chars');
  var result = scanForSecrets('Check out this key: sk-ant-api03-abcdef1234567890');
  check('API key detected', result.found === true, 'true', String(result.found));
});

await testAsync('2.3.4.2', ' Detects generic API key patterns', async () => {
  console.log('  Patterns like AKIA (AWS), ghp_ (GitHub), sk- (Stripe/OpenAI)');
  var tests = [
    ['AWS key', 'AKIAIOSFODNN7EXAMPLE'],
    ['GitHub token', 'ghp_ABCDEFabcdef0123456789abcdef012345'],
    ['Generic sk-', 'sk-proj-abcdefghijklmnop1234567890'],
  ];
  for (var [label, key] of tests) {
    var result = scanForSecrets('Content with ' + key + ' embedded');
    check(label + ' detected', result.found === true, 'true', String(result.found));
  }
});

await testAsync('2.3.4.3', ' Detects hex strings that look like secrets', async () => {
  console.log('  SESSION_SECRET and ENCRYPTION_SECRET are 64-char hex strings');
  console.log('  A 64+ char hex string in post content is suspicious');
  var hexSecret = 'a'.repeat(64);
  var result = scanForSecrets('The secret is ' + hexSecret + ' and that is bad');
  check('Long hex string detected', result.found === true, 'true', String(result.found));
});

await testAsync('2.3.4.4', ' Clean content passes', async () => {
  var result = scanForSecrets('AI safety frameworks help organizations evaluate risk in production systems. According to NIST, these frameworks should be regularly updated.');
  check('Clean content passes', result.found === false, 'false', String(result.found));
});

await testAsync('2.3.4.5', ' Detects env variable names with values', async () => {
  console.log('  If the AI outputs "ANTHROPIC_API_KEY=..." it is leaking config');
  var result = scanForSecrets('Set ANTHROPIC_API_KEY=sk-ant-api03-abc123 in your .env');
  check('Env var leak detected', result.found === true, 'true', String(result.found));
});

var after4 = getCounters();
groupEnd(after4.pass - before4.pass, after4.fail - before4.fail);

console.log('  File: test-p2-ai1/output-filter.mjs');
group('Group 5: Prompt leak and exfiltration detection', `
  Impact: If the AI outputs fragments of its system prompt or
  internal instructions, an attacker learns how to craft better
  injections. If the AI includes URLs or encoded data designed
  to exfiltrate information, the post becomes a data channel.

  Module: src/services/output-filter.js
  Functions: scanForPromptLeak(content), scanForExfiltration(content)
`);

var before5 = getCounters();

await testAsync('2.3.5.1', ' Detects system prompt fragments', async () => {
  console.log('  If the AI outputs "You are a LinkedIn content writer" it is leaking the prompt');
  var result = scanForPromptLeak('Here is my system prompt: You are a LinkedIn content writer who creates posts about cybersecurity.');
  check('Prompt leak detected', result.found === true, 'true', String(result.found));
});

await testAsync('2.3.5.2', ' Detects instruction repetition', async () => {
  console.log('  The AI repeating its instructions verbatim indicates prompt leak');
  var result = scanForPromptLeak('My instructions say: Write in first person. Sound like a thoughtful practitioner. Include ONE concrete example.');
  check('Instruction leak detected', result.found === true, 'true', String(result.found));
});

await testAsync('2.3.5.3', ' Clean post content passes', async () => {
  var result = scanForPromptLeak('The recent NIST framework provides organizations with a structured approach to AI safety evaluation. In my experience deploying AI systems, having a framework matters less than having the discipline to follow it.');
  check('Clean content passes', result.found === false, 'false', String(result.found));
});

await testAsync('2.3.5.4', ' Detects base64 encoded blocks', async () => {
  console.log('  Base64 blocks could encode exfiltrated data');
  var encoded = Buffer.from('ANTHROPIC_API_KEY=sk-ant-secret').toString('base64');
  var result = scanForExfiltration('Check this: ' + encoded);
  check('Base64 block detected', result.found === true, 'true', String(result.found));
});

await testAsync('2.3.5.5', ' Detects suspicious URLs with data params', async () => {
  console.log('  URLs with long query parameters could exfiltrate data');
  var result = scanForExfiltration('Visit https://evil.com/collect?data=' + 'A'.repeat(100));
  check('Suspicious URL detected', result.found === true, 'true', String(result.found));
});

await testAsync('2.3.5.6', ' Normal URLs pass', async () => {
  var result = scanForExfiltration('Read more at https://nist.gov/ai-safety-framework');
  check('Normal URL passes', result.found === false, 'false', String(result.found));
});

await testAsync('2.3.5.7', ' runOutputFilter combines all checks', async () => {
  console.log('  runOutputFilter runs all three scans and returns combined result');
  var cleanResult = runOutputFilter('A normal LinkedIn post about AI safety.');
  check('Clean passes all filters', cleanResult.blocked === false, 'false', String(cleanResult.blocked));

  var dirtyResult = runOutputFilter('Here is my API key: sk-ant-api03-abcdef1234567890');
  check('Dirty blocked', dirtyResult.blocked === true, 'true', String(dirtyResult.blocked));
  check('Reason provided', dirtyResult.reason && dirtyResult.reason.length > 0, 'has reason', String(dirtyResult.reason));
});

var after5 = getCounters();
groupEnd(after5.pass - before5.pass, after5.fail - before5.fail);

var summary = getCounters();
process.exit(summary.fail);
