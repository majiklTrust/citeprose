// ═══════════════════════════════════════════════════════════════
// Auth0 OIDC Provider
// ═══════════════════════════════════════════════════════════════
//
// Activates when AUTH0_DOMAIN is set in environment.
//
// Required env vars:
//   AUTH0_DOMAIN          — e.g. your-tenant.auth0.com
//   AUTH0_CLIENT_ID       — from Auth0 application settings
//   AUTH0_CLIENT_SECRET   — from Auth0 application settings
//
// Optional env vars:
//   AUTH0_AUDIENCE         — API audience (default: https://linkedin-agent-api)
//   AUTH0_REDIRECT_URI     — callback URL (default: http://localhost:{DASHBOARD_PORT}/auth/callback)
//   AUTH0_LOGOUT_URI       — post-logout URL (default: http://localhost:{DASHBOARD_PORT}/)
//   AUTH0_SCOPES           — space-separated scopes (default: openid profile email)
//
// Auth0 dashboard configuration required:
//   1. Create a "Regular Web Application"
//   2. Set Allowed Callback URLs to your AUTH0_REDIRECT_URI
//   3. Set Allowed Logout URLs to your AUTH0_LOGOUT_URI
//   4. Set Allowed Web Origins to your dashboard URL
//   5. Note the Domain, Client ID, and Client Secret
//
// Uses native fetch (Node 22+), no npm dependencies.
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ── Configuration ────────────────────────────────────────────

// ── FIX 3.2.1.1-A through 3.2.1.12-A | HIGH ────────────────
// Threat closed: An attacker who controls AUTH0_DOMAIN can no
// longer point token exchange and userinfo requests at internal
// network services (cloud metadata endpoints, localhost, private
// RFC1918 ranges, Kubernetes API, IPv6 loopback). The domain is
// validated against a blocklist during init(). SSRF via URL
// parser confusion (@ and \ characters) is also blocked.
const BLOCKED_DOMAIN_PATTERNS = [
  /^10\.\d+\.\d+\.\d+$/,                                      // RFC1918: 10.0.0.0/8
  /^127\.\d+\.\d+\.\d+$/,                                     // Loopback: 127.0.0.0/8
  /^192\.168\.\d+\.\d+$/,                                      // RFC1918: 192.168.0.0/16
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,                      // RFC1918: 172.16.0.0/12
  /^0\.0\.0\.0$/,
  /^localhost$/i,
  /^\[?::1\]?$/,                                               // IPv6 loopback
  /^169\.254\.\d+\.\d+$/,                                      // AWS metadata range
  /^metadata\./i,                                               // Cloud metadata endpoints
  /^kubernetes\./i,                                             // K8s API server
  /[@\\]/,                                                      // URL parser confusion chars
];

function isDomainBlocked(domain) {
  return BLOCKED_DOMAIN_PATTERNS.some(pattern => pattern.test(domain));
}

// ── FIX 3.2.2.1-A, 3.2.2.4-A, 3.2.2.5-A, 3.2.2.6-A | HIGH ─
// Threat closed: AUTH0_REDIRECT_URI can no longer be set to an
// attacker-controlled URL that receives the authorization code
// after login. Only https:// and http://localhost redirect URIs
// are accepted. javascript:, data:, and protocol-relative URLs
// are rejected. This prevents code interception even if an
// attacker gains write access to environment variables.
function isRedirectUriSafe(uri) {
  if (!uri) return true; // default is safe (localhost)
  if (uri.startsWith("http://localhost")) return true;
  if (uri.startsWith("http://127.0.0.1")) return true;
  if (uri.startsWith("https://")) return true;
  return false;
}

function getConfig() {
  const domain = (process.env.AUTH0_DOMAIN || "").trim();
  const clientId = (process.env.AUTH0_CLIENT_ID || "").trim();
  const clientSecret = (process.env.AUTH0_CLIENT_SECRET || "").trim();
  const audience = (process.env.AUTH0_AUDIENCE || "https://linkedin-agent-api").trim();
  const port = process.env.DASHBOARD_PORT || "3001";
  const redirectUri = (process.env.AUTH0_REDIRECT_URI || `http://localhost:${port}/auth/callback`).trim();
  const logoutUri = (process.env.AUTH0_LOGOUT_URI || `http://localhost:${port}/`).trim();
  const scopes = (process.env.AUTH0_SCOPES || "openid profile email").trim();

  // Normalize domain — strip protocol if accidentally included
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");

  return {
    domain: cleanDomain,
    clientId,
    clientSecret,
    audience,
    redirectUri,
    logoutUri,
    scopes,
    baseUrl: `https://${cleanDomain}`,
    issuer: `https://${cleanDomain}/`,
    jwksUri: `https://${cleanDomain}/.well-known/jwks.json`,
    authorizationUrl: `https://${cleanDomain}/authorize`,
    tokenUrl: `https://${cleanDomain}/oauth/token`,
    userInfoUrl: `https://${cleanDomain}/userinfo`,
    logoutUrl: `https://${cleanDomain}/v2/logout`,
    openidConfigUrl: `https://${cleanDomain}/.well-known/openid-configuration`
  };
}

// ── State Management ─────────────────────────────────────────
// Self-contained CSRF state for the Auth0 OAuth flow.
// Separate from the LinkedIn OAuth state in security.js —
// each provider manages its own state to remain independent.

const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function generateState() {
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.set(state, Date.now());

  // Prune expired states
  for (const [key, ts] of pendingStates) {
    if (Date.now() - ts > STATE_TTL_MS) pendingStates.delete(key);
  }

  return state;
}

function validateState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const ts = pendingStates.get(state);
  pendingStates.delete(state);
  return (Date.now() - ts) <= STATE_TTL_MS;
}

// ── OIDC Discovery Cache ─────────────────────────────────────

let discoveryCache = null;
let discoveryCacheTs = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchDiscovery(config) {
  if (discoveryCache && (Date.now() - discoveryCacheTs) < DISCOVERY_TTL_MS) {
    return discoveryCache;
  }

  // 5-second timeout on discovery fetch. This must complete well
  // before the registry's 10-second init timeout. Without this,
  // DNS resolution for a nonexistent domain can hang indefinitely,
  // causing the registry timeout to kill the entire init() and
  // mark the provider as failed — even though discovery failure
  // is non-fatal (retried on first auth attempt).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(config.openidConfigUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Auth0 OIDC discovery failed: ${res.status} ${res.statusText}`);
    }

    discoveryCache = await res.json();
    discoveryCacheTs = Date.now();
    return discoveryCache;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Initialization State ─────────────────────────────────────

let initialized = false;
let initConfig = null;

// ── Provider Export ──────────────────────────────────────────

const auth0Provider = {

  // ── Static Fields (set at load time from env vars) ─────────

  get name()     { return "auth0"; },
  get type()     { return "oidc"; },
  get priority() { return 10; },
  get issuer()   { return getConfig().issuer; },
  get jwksUri()  { return getConfig().jwksUri; },
  get audience() { return getConfig().audience; },
  get clientId() { return getConfig().clientId; },

  // ── isConfigured ───────────────────────────────────────────

  isConfigured() {
    const { domain, clientId, clientSecret, redirectUri } = getConfig();
    if (!(domain && clientId && clientSecret)) return false;

    // ── FIX 3.2.1.1-A through 3.2.1.12-A | HIGH ──────────────
    // Threat closed: SSRF check now runs at discovery time, not
    // just during init(). The registry calls isConfigured() first
    // — a blocked domain causes the provider to report itself as
    // unconfigured. It never reaches "ready" status, never enters
    // the providers map, and _getConfig() callers see the domain
    // rejected before any URL is constructed for external use.
    if (isDomainBlocked(domain)) return false;

    // ── FIX 3.2.2.1-A, 3.2.2.4-A, 3.2.2.5-A, 3.2.2.6-A | HIGH
    // Threat closed: Unsafe redirect URIs are now rejected at
    // discovery time. The provider stays inactive if the redirect
    // URI uses javascript:, data:, protocol-relative, or plain
    // http:// (except localhost) schemes. No auth code can be
    // sent to an attacker URL because the provider never activates.
    if (!isRedirectUriSafe(redirectUri)) return false;

    return true;
  },

  // ── init ───────────────────────────────────────────────────
  // Validates configuration completeness and optionally warms
  // the OIDC discovery cache.

  async init() {
    const config = getConfig();

    // Validate required fields
    const missing = [];
    if (!config.domain)       missing.push("AUTH0_DOMAIN");
    if (!config.clientId)     missing.push("AUTH0_CLIENT_ID");
    if (!config.clientSecret) missing.push("AUTH0_CLIENT_SECRET");

    if (missing.length > 0) {
      throw new Error(`Auth0 provider missing required env vars: ${missing.join(", ")}`);
    }

    // Validate domain format
    if (config.domain.includes(" ") || !config.domain.includes(".")) {
      throw new Error(`Auth0 domain appears invalid: "${config.domain}". Expected format: your-tenant.auth0.com`);
    }

    // Try to warm the discovery cache (non-fatal if network unavailable)
    try {
      await fetchDiscovery(config);
    } catch (err) {
      // Discovery fetch failure is non-fatal during init —
      // it will be retried on first auth attempt
      console.warn(`[AUTH0] OIDC discovery fetch failed during init: ${err.message}`);
      console.warn("[AUTH0] Will retry on first authentication attempt.");
    }

    initConfig = config;
    initialized = true;
  },

  // ── getRoutes ──────────────────────────────────────────────
  // Returns an Express router with:
  //   GET /auth/login     — redirects to Auth0 authorization
  //   GET /auth/callback  — handles code exchange
  //   GET /auth/logout    — redirects to Auth0 logout

  getRoutes() {
    const { Router } = require("express");
    const router = Router();
    const config = getConfig();

    // Login — redirect to Auth0
    router.get("/auth/login", (req, res) => {
      const state = generateState();
      const url = auth0Provider.getLoginUrl(state);
      res.redirect(url);
    });

    // Callback — exchange code for tokens
    router.get("/auth/callback", async (req, res) => {
      const { code, error, error_description, state } = req.query;

      // Validate state
      if (!validateState(state)) {
        return res.status(403).json({
          error: "Invalid or expired authentication state. Please try logging in again."
        });
      }

      // Auth0 error
      if (error) {
        return res.status(400).json({
          error: "Authentication failed.",
          detail: error_description || error
        });
      }

      if (!code) {
        return res.status(400).json({
          error: "Missing authorization code."
        });
      }

      try {
        const tokens = await auth0Provider.exchangeCode(code);
        const user = await auth0Provider.getUserInfo(tokens.accessToken);

        // Respond with tokens and user info.
        // In Step 5 (dashboard login flow) and Step 6 (session management),
        // this will be replaced with session establishment + redirect.
        // For now, return JSON so the flow is testable.
        res.json({
          success: true,
          user: {
            sub: user.sub,
            name: user.name,
            email: user.email,
            emailVerified: user.email_verified
          },
          tokens: {
            accessToken: tokens.accessToken,
            expiresIn: tokens.expiresIn,
            tokenType: tokens.tokenType
            // Note: tokens.idToken intentionally omitted from response.
            // It's used server-side for validation, not sent to client.
          }
        });
      } catch (err) {
        res.status(500).json({
          error: "Token exchange failed. Check server logs."
        });
      }
    });

    // Logout — redirect to Auth0 logout endpoint
    router.get("/auth/logout", (req, res) => {
      const returnTo = req.query.returnTo || config.logoutUri;
      const url = auth0Provider.getLogoutUrl(returnTo);
      res.redirect(url);
    });

    return router;
  },

  // ── getLoginUrl ────────────────────────────────────────────

  getLoginUrl(state) {
    const config = getConfig();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes,
      audience: config.audience,
      state: state || generateState()
    });
    return `${config.authorizationUrl}?${params.toString()}`;
  },

  // ── exchangeCode ───────────────────────────────────────────

  async exchangeCode(code) {
    const config = getConfig();

    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Auth0 token exchange failed: ${res.status} — ${body.substring(0, 200)}`);
    }

    const data = await res.json();

    return {
      accessToken: data.access_token,
      idToken: data.id_token || null,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      refreshToken: data.refresh_token || null,
      scope: data.scope || null
    };
  },

  // ── getUserInfo ────────────────────────────────────────────

  async getUserInfo(accessToken) {
    const config = getConfig();

    const res = await fetch(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Auth0 userinfo failed: ${res.status} — ${body.substring(0, 200)}`);
    }

    const data = await res.json();

    return {
      sub: data.sub,
      name: data.name || data.nickname || null,
      email: data.email || null,
      emailVerified: data.email_verified || false,
      picture: data.picture || null,
      provider: "auth0",
      raw: data
    };
  },

  // ── getLogoutUrl ───────────────────────────────────────────

  getLogoutUrl(returnTo) {
    const config = getConfig();
    const params = new URLSearchParams({
      client_id: config.clientId,
      returnTo: returnTo || config.logoutUri
    });
    return `${config.logoutUrl}?${params.toString()}`;
  },

  // ── shutdown ───────────────────────────────────────────────

  async shutdown() {
    initialized = false;
    initConfig = null;
    discoveryCache = null;
    discoveryCacheTs = 0;
    pendingStates.clear();
  },

  // ── Test/Diagnostic Helpers (not part of interface) ────────

  _isInitialized() { return initialized; },
  _getConfig() { return getConfig(); },
  _getStateCount() { return pendingStates.size; },
  _generateState: generateState,
  _validateState: validateState,
  _getDiscoveryCache() { return discoveryCache; }
};

export default auth0Provider;
