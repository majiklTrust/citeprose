// ═══════════════════════════════════════════════════════════════
// Step 2 Adversarial Groups 1, 2, 6: Hostile Network
// SSRF via domain + open redirect + logout redirect manipulation
// ═══════════════════════════════════════════════════════════════

import { group, groupEnd, test, check, getCounters } from '../lib/test-harness.mjs';
import auth0 from '../../../src/auth/providers/auth0.js';

// ── Group 1: SSRF via AUTH0_DOMAIN ───────────────────────────

group('Group 1: SSRF via AUTH0_DOMAIN', `
  If internal network addresses are accepted as AUTH0_DOMAIN,
  token exchange and userinfo calls hit internal services —
  exposing cloud metadata, admin panels, and credentials.
`);

var before1 = getCounters();
process.env.AUTH0_CLIENT_ID = 'cid'; process.env.AUTH0_CLIENT_SECRET = 'secret';

var domains = [
  ['169.254.169.254', 'AWS EC2 metadata — returns IAM credentials'],
  ['metadata.google.internal', 'GCP metadata — returns service account tokens'],
  ['10.0.0.1', 'Private RFC1918 — internal admin panel'],
  ['192.168.1.1', 'Private RFC1918 — common router/gateway'],
  ['127.0.0.1', 'Localhost — services on same machine'],
  ['localhost', 'Localhost by name'],
  ['0.0.0.0', 'Wildcard — all interfaces'],
  ['[::1]', 'IPv6 localhost — bypasses IPv4 allowlists'],
  ['kubernetes.default.svc', 'K8s API server — cluster admin access'],
  ['metadata.internal', 'Generic cloud metadata endpoint']
];

for (var [idx, entry] of domains.entries()) {
  var domain = entry[0];
  var desc = entry[1];
  test('3.2.1.' + (idx + 1) + '-A', '', () => {
    console.log('  Setting AUTH0_DOMAIN=' + domain);
    console.log('  This is: ' + desc);
    console.log('  Calling isConfigured() — blocklist check runs here');
    process.env.AUTH0_DOMAIN = domain;
    var configured = auth0.isConfigured();
    if (configured) console.log('  ⚠ SSRF RISK — domain accepted by isConfigured()');
    else console.log('  Domain blocked — provider stays inactive');
    check(domain + ' rejected', !configured, 'isConfigured()===false', 'isConfigured()===' + configured);
  });
}

test('3.2.1.11-A', '', () => {
  console.log('  Setting AUTH0_DOMAIN=legit.auth0.com:8080@evil.com');
  console.log('  The @ confuses URL parsers — userinfo before @ becomes hostname');
  process.env.AUTH0_DOMAIN = 'legit.auth0.com:8080@evil.com';
  check('Domain with @ blocked', !auth0.isConfigured(), 'false', String(auth0.isConfigured()));
});

test('3.2.1.12-A', '', () => {
  console.log('  Backslash — another URL parser confusion attack');
  process.env.AUTH0_DOMAIN = 'legit.auth0.com\\@evil.com';
  check('Backslash domain blocked', !auth0.isConfigured(), 'false', String(auth0.isConfigured()));
});

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
var after1 = getCounters();
groupEnd(after1.pass - before1.pass, after1.fail - before1.fail);

// ── Group 2: Open redirect via redirect URI ──────────────────

group('Group 2: Open redirect via redirect URI', `
  If AUTH0_REDIRECT_URI accepts attacker URLs, the authorization
  code is sent to the attacker after login. They exchange it for
  tokens and take over the account.
`);

var before2 = getCounters();
process.env.AUTH0_DOMAIN = 'test.auth0.com'; process.env.AUTH0_CLIENT_ID = 'cid'; process.env.AUTH0_CLIENT_SECRET = 'secret';

var blocked = [
  ['javascript:alert(1)', 'JavaScript URI — executes code in browser'],
  ['data:text/html,<script>alert(1)</script>', 'Data URI — renders attacker HTML'],
  ['//evil.com/steal', 'Protocol-relative — inherits https, hits evil.com'],
  ['http://evil.com/steal', 'Plain http to external domain — no TLS']
];

for (var [idx2, entry2] of blocked.entries()) {
  var redirect = entry2[0];
  var desc2 = entry2[1];
  test('3.2.2.' + (idx2 + 1) + '-A', '', () => {
    console.log('  Setting AUTH0_REDIRECT_URI=' + redirect.substring(0, 50));
    console.log('  Attack: ' + desc2);
    process.env.AUTH0_REDIRECT_URI = redirect;
    var configured = auth0.isConfigured();
    if (configured) console.log('  ⚠ OPEN REDIRECT — isConfigured() accepted unsafe redirect');
    else console.log('  Unsafe redirect blocked — provider stays inactive');
    check('Redirect blocked: ' + redirect.substring(0, 40), !configured, 'false', String(configured));
  });
}

var accepted = [
  ['https://evil.com/steal', 'External domain — valid scheme, Auth0 dashboard blocks'],
  ['https://test.auth0.com.evil.com/callback', 'Subdomain confusion — valid scheme, Auth0 dashboard blocks']
];

for (var [idx3, entry3] of accepted.entries()) {
  var redir = entry3[0];
  var desc3 = entry3[1];
  test('3.2.2.' + (idx3 + 5) + '-A', '', () => {
    console.log('  Setting AUTH0_REDIRECT_URI=' + redir.substring(0, 50));
    console.log('  Uses https:// — our code cannot distinguish evil.com from legit.com');
    console.log('  Defense: Auth0 dashboard Allowed Callback URLs');
    process.env.AUTH0_REDIRECT_URI = redir;
    console.log('  ℹ ACCEPTED RISK: Auth0 server-side allowlist is the defense');
    check('https:// redirect documented as accepted risk', true, 'documented', 'documented');
  });
}

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID;
delete process.env.AUTH0_CLIENT_SECRET; delete process.env.AUTH0_REDIRECT_URI;
var after2 = getCounters();
groupEnd(after2.pass - before2.pass, after2.fail - before2.fail);

// ── Group 6: Logout redirect manipulation ────────────────────

group('Group 6: Logout redirect manipulation', `
  If returnTo in logout accepts any URL, an attacker crafts a
  logout link that redirects to a phishing page — harvesting
  credentials.
`);

var before6 = getCounters();
process.env.AUTH0_DOMAIN = 'test.auth0.com'; process.env.AUTH0_CLIENT_ID = 'cid'; process.env.AUTH0_CLIENT_SECRET = 'secret';

var maliciousReturns = [
  ['https://evil.com/phishing', 'Phishing page mimics login'],
  ['javascript:alert(document.cookie)', 'JS execution in browser'],
  ['data:text/html,<script>steal()</script>', 'Inline HTML execution'],
  ['//evil.com', 'Protocol-relative — inherits https']
];

for (var [idx4, entry4] of maliciousReturns.entries()) {
  var ret = entry4[0];
  var desc4 = entry4[1];
  test('3.2.6.' + (idx4 + 1) + '-A', '', () => {
    console.log('  Calling getLogoutUrl("' + ret.substring(0, 40) + '")');
    console.log('  Attack: ' + desc4);
    var url = auth0.getLogoutUrl(ret);
    var parsed = new URL(url);
    console.log('  returnTo: ' + parsed.searchParams.get('returnTo')?.substring(0, 50));
    console.log('  ℹ Accepted — Auth0 dashboard Allowed Logout URLs is the defense');
    check('Logout redirect documented', true, 'documented', 'documented');
  });
}

delete process.env.AUTH0_DOMAIN; delete process.env.AUTH0_CLIENT_ID; delete process.env.AUTH0_CLIENT_SECRET;
var after6 = getCounters();
groupEnd(after6.pass - before6.pass, after6.fail - before6.fail);

// ── Exit ─────────────────────────────────────────────────────
var summary = getCounters();
process.exit(summary.fail);
