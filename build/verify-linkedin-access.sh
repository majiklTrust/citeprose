#!/bin/bash

set -a
. .env.linkedin-mdp.local
. .env.pgsql-marketing_ai_instance.local
set +a

node --input-type=module -e "
// ═══════════════════════════════════════════════════════════════
// build/verify-linkedin-access.mjs
// LinkedIn Marketing Developer Platform — Access Verification
// ═══════════════════════════════════════════════════════════════
//
// # From project root
// node build/verify-linkedin-access.mjs

// # From linkedin-agent/
// node ../build/verify-linkedin-access.mjs

// Verifies which MDP API products are provisioned and functional
// for the configured LinkedIn developer application.
//
// Designed for Developer Portal token generator (Option A):
//   1. Go to developer.linkedin.com → your app → Auth → OAuth 2.0 tools
//   2. Generate a 3-legged token requesting the scopes you want to test
//      (e.g., r_ads, w_organization_social, r_organization_social)
//   3. Run this script with that token
//
// Architecture:
//   Config      — single loadConfig() validates env, returns frozen object
//   HttpClient  — thin wrapper around fetch with LinkedIn headers + timeout
//   ScopeCatalog — maps product names → scope strings (single source of truth)
//   ProbeRegistry — data-driven: each probe declares its label, URL, required
//                   scopes, and result interpreter. Adding a product = one entry.
//   Reporter    — formats results for console output
//
// Exit codes:
//   0 — all probes passed
//   1 — configuration error (missing env vars)
//   2 — token inactive (expired or revoked)
//   3 — one or more probes failed
//
// Required env:
//   LINKEDIN_ACCESS_TOKEN   3-legged OAuth token (from Developer Portal)
//   LINKEDIN_CLIENT_ID      Developer application client ID
//   LINKEDIN_CLIENT_SECRET  Developer application client secret
//
// Optional env:
//   LINKEDIN_VERSION        API version header, YYYYMM (default: 202509)
//   PROBE_TIMEOUT_MS        Per-request timeout in ms (default: 15000)
//
// Usage:
//   LINKEDIN_ACCESS_TOKEN=<token> \
//   LINKEDIN_CLIENT_ID=<id> \
//   LINKEDIN_CLIENT_SECRET=<secret> \
//   node build/verify-linkedin-access.mjs
// ═══════════════════════════════════════════════════════════════

// ── Exit codes ───────────────────────────────────────────────
const EXIT = Object.freeze({
  OK:             0,
  CONFIG_ERROR:   1,
  TOKEN_INACTIVE: 2,
  PROBE_FAILED:   3,
});

// ── Probe result statuses ────────────────────────────────────
const STATUS = Object.freeze({
  CONFIRMED:  "CONFIRMED",   // scope present + endpoint returned 200
  SCOPE_ONLY: "SCOPE_ONLY",  // scope present but endpoint errored
  DENIED:     "DENIED",      // scope missing or endpoint returned 403
  SKIPPED:    "SKIPPED",     // prerequisite scope absent, probe not attempted
  ERROR:      "ERROR",       // network or unexpected failure
});

// ── Scope catalog ────────────────────────────────────────────
// Single source of truth for LinkedIn API product → scope mappings.
// Each product lists the scopes LinkedIn assigns when approved.
// Used by introspection classification AND probe gating.

const SCOPE_CATALOG = Object.freeze({
  "OpenID / Profile": Object.freeze({
    scopes: ["openid", "profile", "email"],
  }),
  "Community Management": Object.freeze({
    scopes: [
      "w_organization_social",
      "r_organization_social",
      "w_member_social",
      "r_member_social",
    ],
  }),
  "Advertising": Object.freeze({
    scopes: ["r_ads", "rw_ads", "r_ads_reporting"],
  }),
  "Lead Sync": Object.freeze({
    scopes: [
      "r_marketing_leadgen_automation",
      "rw_marketing_leadgen_automation",
    ],
  }),
  "Conversions": Object.freeze({
    scopes: ["rw_conversions"],
  }),
  "Live Events": Object.freeze({
    scopes: ["r_events", "w_events", "rw_events"],
  }),
});

// ── Configuration ────────────────────────────────────────────

function loadConfig() {
  const required = {
    accessToken:  process.env.LINKEDIN_ACCESS_TOKEN,
    clientId:     process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    const envNames = {
      accessToken:  "LINKEDIN_ACCESS_TOKEN",
      clientId:     "LINKEDIN_CLIENT_ID",
      clientSecret: "LINKEDIN_CLIENT_SECRET",
    };
    console.error("\n  Missing required environment variables:");
    missing.forEach(k => console.error(`    ${envNames[k]}`));
    console.error("\n  Usage:");
    console.error("    LINKEDIN_ACCESS_TOKEN=<token> \\");
    console.error("    LINKEDIN_CLIENT_ID=<id> \\");
    console.error("    LINKEDIN_CLIENT_SECRET=<secret> \\");
    console.error("    node build/verify-linkedin-access.mjs\n");
    process.exit(EXIT.CONFIG_ERROR);
  }

  return Object.freeze({
    ...required,
    apiVersion:   process.env.LINKEDIN_VERSION || "202509",
    timeoutMs:    parseInt(process.env.PROBE_TIMEOUT_MS, 10) || 15000,
    restBase:     "https://api.linkedin.com/rest",
    v2Base:       "https://api.linkedin.com/v2",
    introspectUrl:"https://www.linkedin.com/oauth/v2/introspectToken",
  });
}

// ── HTTP Client ──────────────────────────────────────────────
// Thin wrapper: adds LinkedIn headers, enforces timeout, returns
// a normalized { status, body, elapsed, error } — never throws.

function createHttpClient(config) {
  function linkedInHeaders() {
    return {
      Authorization:             `Bearer ${config.accessToken}`,
      "LinkedIn-Version":        config.apiVersion,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type":            "application/json",
    };
  }

  async function request(method, url, options = {}) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: options.headers || linkedInHeaders(),
        body:    options.body || undefined,
        signal:  controller.signal,
      });
      const body = await res.json().catch(() => null);
      return {
        status:  res.status,
        body,
        elapsed: Date.now() - start,
        error:   null,
      };
    } catch (err) {
      const message = err.name === "AbortError"
        ? `Request timed out (${config.timeoutMs}ms)`
        : err.message;
      return {
        status:  0,
        body:    null,
        elapsed: Date.now() - start,
        error:   message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    get:  (url) => request("GET", url),
    post: (url, body, headers) => request("POST", url, { body, headers }),
  });
}

// ── Token Introspection ──────────────────────────────────────
// Returns { active, scopes[], expiresAt, clientId } or throws
// if the request itself fails. An inactive token exits the process.

async function introspectToken(config, client) {
  const params = new URLSearchParams({
    client_id:     config.clientId,
    client_secret: config.clientSecret,
    token:         config.accessToken,
  });

  const res = await client.post(
    config.introspectUrl,
    params.toString(),
    { "Content-Type": "application/x-www-form-urlencoded" }
  );

  if (res.error) {
    return { active: false, scopes: [], error: res.error };
  }

  const data = res.body || {};

  if (!data.active) {
    return { active: false, scopes: [], error: null };
  }

  const scopes = data.scope
    ? data.scope.split(/[\s,]+/).filter(Boolean)
    : [];

  return Object.freeze({
    active:    true,
    scopes,
    clientId:  data.client_id || null,
    createdAt: data.created_at
      ? new Date(data.created_at * 1000).toISOString()
      : null,
    expiresAt: data.expires_at
      ? new Date(data.expires_at * 1000).toISOString()
      : null,
    error:     null,
  });
}

// ── Scope Helpers ────────────────────────────────────────────

function hasAnyScope(grantedScopes, requiredScopes) {
  return requiredScopes.some(s => grantedScopes.includes(s));
}

function matchedScopes(grantedScopes, requiredScopes) {
  return requiredScopes.filter(s => grantedScopes.includes(s));
}

// ── Probe Registry ───────────────────────────────────────────
// Data-driven: each entry declares what it tests, how to build
// the URL, which scopes gate it, and how to interpret a 200.
// Adding a new API product is a single entry here.

function buildProbeRegistry(config) {
  return [
    {
      id:       "profile",
      label:    "Profile (OpenID)",
      product:  "OpenID / Profile",
      // userinfo is on /v2, not /rest — does not need LinkedIn-Version
      url:      `${config.v2Base}/userinfo`,
      // No gating scopes — always attempt (baseline check)
      gateScopes: [],
      interpret(body) {
        if (!body) return "200 OK (empty body)";
        return body.sub
          ? `Authenticated as: ${body.name || body.sub} (${body.sub})`
          : "200 OK";
      },
    },
    {
      id:       "community_mgmt",
      label:    "Community Mgmt — Org Roles",
      product:  "Community Management",
      url:      `${config.restBase}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`,
      gateScopes: ["w_organization_social", "r_organization_social"],
      interpret(body) {
        const elements = body?.elements || [];
        if (elements.length === 0) {
          return "200 OK — no organizations found for this member";
        }
        const orgs = elements.map(e => {
          const orgId = (e.organization || "").split(":").pop();
          return `org:${orgId} [${e.role}]`;
        });
        return `Found ${elements.length} org role(s): ${orgs.join(", ")}`;
      },
    },
    {
      id:       "advertising",
      label:    "Advertising — Ad Accounts",
      product:  "Advertising",
      url:      `${config.restBase}/adAccounts?q=search&search=(status:(values:List(ACTIVE)))`,
      gateScopes: ["r_ads", "rw_ads"],
      interpret(body) {
        const elements = body?.elements || [];
        if (elements.length === 0) {
          return "200 OK — no ad accounts found for this member";
        }
        const accounts = elements.map(e => {
          const acctId = (e.id ?? e.reference ?? "?").toString();
          return `${acctId} [${e.status || "?"}]`;
        });
        return `Found ${elements.length} ad account(s): ${accounts.join(", ")}`;
      },
    },
  ];
}

// ── Run Probes ───────────────────────────────────────────────

async function runProbes(probes, grantedScopes, client) {
  const results = [];

  for (const probe of probes) {
    // Gate check: if the probe requires scopes and none are present,
    // skip the HTTP call entirely — the token can't access it.
    if (probe.gateScopes.length > 0 && !hasAnyScope(grantedScopes, probe.gateScopes)) {
      results.push({
        id:      probe.id,
        label:   probe.label,
        product: probe.product,
        status:  STATUS.SKIPPED,
        http:    null,
        detail:  `Skipped — token lacks required scope(s): ${probe.gateScopes.join(", ")}`,
      });
      continue;
    }

    const res = await client.get(probe.url);

    if (res.error) {
      results.push({
        id:      probe.id,
        label:   probe.label,
        product: probe.product,
        status:  STATUS.ERROR,
        http:    res.status,
        detail:  res.error,
        elapsed: res.elapsed,
      });
      continue;
    }

    const httpStatus = res.status;
    let probeStatus;
    let detail;

    switch (httpStatus) {
      case 200:
        probeStatus = STATUS.CONFIRMED;
        detail = probe.interpret(res.body);
        break;
      case 401:
        probeStatus = STATUS.ERROR;
        detail = "Token invalid or expired";
        break;
      case 403:
        probeStatus = hasAnyScope(grantedScopes, probe.gateScopes)
          ? STATUS.SCOPE_ONLY
          : STATUS.DENIED;
        detail = probeStatus === STATUS.SCOPE_ONLY
          ? "Scope granted but access denied — check member role or product tier"
          : "Access denied — product not provisioned for this application";
        break;
      case 404:
        probeStatus = STATUS.ERROR;
        detail = `Endpoint not found — verify API version (${res.body?.message || "no details"})`;
        break;
      default:
        probeStatus = STATUS.ERROR;
        detail = `Unexpected HTTP ${httpStatus}: ${JSON.stringify(res.body?.message || res.body)}`;
    }

    results.push({
      id:      probe.id,
      label:   probe.label,
      product: probe.product,
      status:  probeStatus,
      http:    httpStatus,
      detail,
      elapsed: res.elapsed,
    });
  }

  return results;
}

// ── Reporter ─────────────────────────────────────────────────

const ICONS = Object.freeze({
  [STATUS.CONFIRMED]: "✅",
  [STATUS.SCOPE_ONLY]:"⚠️ ",
  [STATUS.DENIED]:    "❌",
  [STATUS.SKIPPED]:   "⏭️ ",
  [STATUS.ERROR]:     "💥",
});

function reportBanner(config) {
  const line = "═".repeat(64);
  console.log(`\n╔${line}╗`);
  console.log(`║  LinkedIn MDP — Access Verification${" ".repeat(28)}║`);
  console.log(`╠${line}╣`);
  console.log(`║  API Version:  ${config.apiVersion}${" ".repeat(64 - 17 - config.apiVersion.length)}║`);
  const prefix = config.accessToken.substring(0, 8);
  console.log(`║  Token prefix: ${prefix}...${" ".repeat(64 - 20 - prefix.length)}║`);
  console.log(`╚${line}╝`);
}

function reportIntrospection(intro, grantedScopes) {
  console.log("\n─── Phase 1: Token Introspection ───────────────────────────────\n");

  if (!intro.active) {
    console.log("  ❌  Token is INACTIVE (expired or revoked).");
    if (intro.error) console.log(`      Error: ${intro.error}`);
    console.log("      Generate a fresh token via Developer Portal and re-run.\n");
    return;
  }

  console.log(`  Active:      ${intro.active}`);
  console.log(`  Client ID:   ${intro.clientId || "(not returned)"}`);
  console.log(`  Created:     ${intro.createdAt || "(not returned)"}`);
  console.log(`  Expires:     ${intro.expiresAt || "(not returned)"}`);
  console.log(`  Scopes:      ${grantedScopes.length > 0 ? grantedScopes.join(", ") : "(none)"}`);

  console.log("\n  Scope-to-product mapping:\n");

  for (const [product, def] of Object.entries(SCOPE_CATALOG)) {
    const matched = matchedScopes(grantedScopes, def.scopes);
    const icon = matched.length > 0 ? "✅" : "⬜";
    const detail = matched.length > 0 ? matched.join(", ") : "(none)";
    console.log(`    ${icon}  ${product.padEnd(24)} ${detail}`);
  }

  // Flag scopes not in the catalog
  const knownScopes = Object.values(SCOPE_CATALOG).flatMap(d => d.scopes);
  const unknown = grantedScopes.filter(s => !knownScopes.includes(s));
  if (unknown.length > 0) {
    console.log(`\n    ⚠️   Unrecognized scopes: ${unknown.join(", ")}`);
    console.log("        These may be newer products or custom grants.");
  }
}

function reportProbes(results) {
  console.log("\n─── Phase 2: Endpoint Probes ────────────────────────────────────\n");

  for (const r of results) {
    const icon = ICONS[r.status] || "?";
    const httpLabel = r.http != null ? `HTTP ${r.http}` : "";
    const timing = r.elapsed != null ? `(${r.elapsed}ms)` : "";
    console.log(`  ${icon} ${r.label.padEnd(35)} ${httpLabel.padEnd(10)} ${timing}`);
    console.log(`      ${r.detail}`);
    console.log();
  }
}

function reportSummary(results, grantedScopes) {
  console.log("─── Summary ─────────────────────────────────────────────────────\n");

  // Report on each probed product
  const productProbes = results.filter(r => r.product !== "OpenID / Profile");

  for (const r of productProbes) {
    const icon = ICONS[r.status] || "?";
    const verdict = r.status === STATUS.CONFIRMED
      ? "CONFIRMED — functional access verified"
      : r.status === STATUS.SCOPE_ONLY
        ? "PARTIAL — scope present but endpoint denied (check role/tier)"
        : r.status === STATUS.SKIPPED
          ? "SKIPPED — scope not on this token"
          : r.status === STATUS.DENIED
            ? "NOT AVAILABLE — apply via Developer Portal"
            : "ERROR — see probe details above";
    console.log(`  ${icon} ${r.product.padEnd(28)} ${verdict}`);
  }

  // Products not probed at all (no entry in registry)
  const probedProducts = new Set(results.map(r => r.product));
  const unprobed = Object.keys(SCOPE_CATALOG)
    .filter(p => p !== "OpenID / Profile" && !probedProducts.has(p));

  for (const p of unprobed) {
    const has = hasAnyScope(grantedScopes, SCOPE_CATALOG[p].scopes);
    console.log(`  ⬜ ${p.padEnd(28)} ${has ? "Scope present — no endpoint probe defined" : "Not tested"}`);
  }

  // Actionable next steps
  const skipped = results.filter(r => r.status === STATUS.SKIPPED);
  const denied  = results.filter(r => r.status === STATUS.DENIED);

  if (skipped.length > 0 || denied.length > 0) {
    console.log("\n  Next steps:");
    if (skipped.length > 0) {
      console.log("    • Re-generate the token with the missing scopes via Developer Portal");
      console.log("      (Auth → OAuth 2.0 tools → select additional scopes → generate)");
    }
    if (denied.length > 0) {
      console.log("    • Apply for the denied product(s) via Developer Portal → Products tab");
    }
  }

  console.log("\n  Rate limits (Development Tier):");
  console.log("    Per App:    500 requests");
  console.log("    Per Member: 100 requests");
  console.log("    Standard Tier requires a screencast demo of working integration.\n");
}

// ── Main ─────────────────────────────────────────────────────

// import stringify from 'json-stringify-safe';
import util from 'util';
async function main() {
  const config = loadConfig();
// console.log(stringify(config, null, 2));
console.log(util.inspect(config, {
  depth: null,
  colors: true,
  compact: false
}));
  const client = createHttpClient(config);

  reportBanner(config);

  // Phase 1: Introspect
  const intro = await introspectToken(config, client);
  const grantedScopes = intro.scopes || [];

  reportIntrospection(intro, grantedScopes);

  if (!intro.active) {
    process.exit(EXIT.TOKEN_INACTIVE);
  }

  // Phase 2: Probes
  const probes  = buildProbeRegistry(config);
  const results = await runProbes(probes, grantedScopes, client);

  reportProbes(results);
  reportSummary(results, grantedScopes);

  // Exit code: 0 if no failures, 3 if any probe failed
  const hasFailed = results.some(r =>
    r.status === STATUS.DENIED ||
    r.status === STATUS.ERROR
  );
  process.exit(hasFailed ? EXIT.PROBE_FAILED : EXIT.OK);
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(EXIT.CONFIG_ERROR);
});
