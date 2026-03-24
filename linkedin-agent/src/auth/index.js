// ═══════════════════════════════════════════════════════════════
// Auth Provider Registry
// ═══════════════════════════════════════════════════════════════
//
// Discovers and loads auth providers from src/auth/providers/.
// Each provider file must export a default object implementing
// the AuthProvider interface (see PROVIDER_CONTRACT below).
//
// Provider activation is controlled by environment variables,
// not by file presence. A provider file can exist permanently
// in the codebase — it only activates when its required env
// vars are set.
//
// NODE_ENV=production: at least one provider must be active.
//   Startup fails if none are found.
//
// Any other NODE_ENV (or unset): providers are optional.
//   A warning is logged if none are active, and the app
//   continues in unauthenticated mode.
// ═══════════════════════════════════════════════════════════════

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = path.join(__dirname, "providers");

// ── Provider Interface Contract ──────────────────────────────
//
// Every provider must export a default object with these fields:
//
//   name        (string)   — unique identifier, e.g. "auth0"
//   type        (string)   — protocol type: "oidc" | "saml"
//   priority    (number)   — lower number = higher priority for default selection
//   issuer      (string)   — token issuer URL (used for JWT validation)
//   jwksUri     (string)   — JWKS endpoint for public key retrieval
//   audience    (string)   — expected JWT audience claim
//   clientId    (string)   — OAuth client ID
//
//   isConfigured()         — returns boolean: are required env vars present?
//   init()                 — async: provider startup logic (validate config, warm caches)
//   getRoutes()            — returns Express Router with provider-specific auth routes
//   getLoginUrl(state)     — returns authorization URL for login redirect
//   exchangeCode(code)     — async: exchanges auth code for tokens
//   getUserInfo(token)     — async: retrieves user profile from token or userinfo endpoint
//   getLogoutUrl(returnTo) — returns logout URL
//
// Optional:
//   shutdown()             — async: cleanup on server shutdown

const REQUIRED_FIELDS = ["name", "type", "priority", "issuer", "jwksUri", "audience", "clientId"];
const REQUIRED_METHODS = ["isConfigured", "init", "getRoutes", "getLoginUrl", "exchangeCode", "getUserInfo", "getLogoutUrl"];

// ── Registry State ───────────────────────────────────────────

const activeProviders = new Map();
let registryInitialized = false;
let authRequired = false;

// ── Validation ───────────────────────────────────────────────

function validateProviderInterface(provider, filename) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (provider[field] === undefined || provider[field] === null || provider[field] === "") {
      errors.push(`missing field: ${field}`);
    }
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== "function") {
      errors.push(`missing or non-function method: ${method}`);
    }
  }

  if (provider.name && typeof provider.name !== "string") {
    errors.push("name must be a string");
  }

  if (provider.type && !["oidc", "saml"].includes(provider.type)) {
    errors.push(`type must be 'oidc' or 'saml', got '${provider.type}'`);
  }

  if (provider.priority !== undefined && typeof provider.priority !== "number") {
    errors.push("priority must be a number");
  }

  return errors;
}

// ── Discovery & Loading ──────────────────────────────────────

async function discoverProviderFiles() {
  if (!existsSync(PROVIDERS_DIR)) {
    return [];
  }

  const files = await readdir(PROVIDERS_DIR);
  return files
    .filter(f => f.endsWith(".js") && !f.startsWith("_") && !f.startsWith("."))
    .sort();
}

async function loadProvider(filename) {
  const filepath = path.join(PROVIDERS_DIR, filename);

  try {
    const module = await import(filepath);
    const provider = module.default;

    if (!provider) {
      return { status: "skip", reason: "no default export", filename };
    }

    // Check if provider has isConfigured before full validation
    if (typeof provider.isConfigured === "function" && !provider.isConfigured()) {
      return { status: "inactive", reason: "env vars not configured", filename, name: provider.name || filename };
    }

    // Full interface validation only for configured providers
    const errors = validateProviderInterface(provider, filename);
    if (errors.length > 0) {
      return { status: "invalid", reason: errors.join("; "), filename, name: provider.name || filename };
    }

    return { status: "ready", provider, filename };
  } catch (err) {
    return { status: "error", reason: err.message, filename };
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Initialize the provider registry.
 * Scans providers/, loads configured providers, enforces production requirements.
 *
 * @param {Function} logFn — logging function with signature logFn(level, action, details)
 * @returns {Object} { providers: Map, authEnabled: boolean, results: Array }
 */
export async function initRegistry(logFn) {
  if (registryInitialized) {
    return { providers: activeProviders, authEnabled: activeProviders.size > 0, results: [] };
  }

  const isProduction = process.env.NODE_ENV === "production";
  authRequired = isProduction;

  const results = [];
  const files = await discoverProviderFiles();

  if (logFn) {
    logFn("info", "auth_registry_scan", {
      providersDir: PROVIDERS_DIR,
      filesFound: files.length,
      environment: process.env.NODE_ENV || "(unset)"
    });
  }

  for (const file of files) {
    const result = await loadProvider(file);
    results.push(result);

    if (result.status === "ready") {
      try {
        await result.provider.init();
        activeProviders.set(result.provider.name, result.provider);

        if (logFn) {
          logFn("info", "auth_provider_loaded", {
            name: result.provider.name,
            type: result.provider.type,
            issuer: result.provider.issuer,
            priority: result.provider.priority
          });
        }
      } catch (err) {
        result.status = "init_failed";
        result.reason = err.message;

        if (logFn) {
          logFn("error", "auth_provider_init_failed", {
            name: result.provider.name,
            error: err.message
          });
        }
      }
    } else if (logFn) {
      logFn("info", "auth_provider_skipped", {
        filename: result.filename,
        status: result.status,
        reason: result.reason,
        name: result.name || null
      });
    }
  }

  // Enforce production requirement
  if (isProduction && activeProviders.size === 0) {
    const msg = "[FATAL] No auth providers configured. Set AUTH0_DOMAIN or WORKOS_API_KEY in environment.";
    if (logFn) {
      logFn("error", "auth_registry_fatal", { message: msg });
    }
    throw new Error(msg);
  }

  if (activeProviders.size === 0 && logFn) {
    logFn("warn", "auth_registry_no_providers", {
      message: "No auth providers active — running without authentication."
    });
  }

  registryInitialized = true;

  return {
    providers: activeProviders,
    authEnabled: activeProviders.size > 0,
    results
  };
}

/**
 * Get all active providers, sorted by priority (lowest first).
 */
export function getProviders() {
  return [...activeProviders.values()].sort((a, b) => a.priority - b.priority);
}

/**
 * Get a specific provider by name.
 */
export function getProvider(name) {
  return activeProviders.get(name) || null;
}

/**
 * Get the default (highest priority) provider.
 */
export function getDefaultProvider() {
  const sorted = getProviders();
  return sorted.length > 0 ? sorted[0] : null;
}

/**
 * Get all registered JWKS URIs (for JWT middleware to validate against).
 * Returns Map<issuer, jwksUri>
 */
export function getJwksMap() {
  const map = new Map();
  for (const provider of activeProviders.values()) {
    map.set(provider.issuer, provider.jwksUri);
  }
  return map;
}

/**
 * Get all registered issuers (for JWT validation allowlist).
 */
export function getIssuers() {
  return [...activeProviders.values()].map(p => p.issuer);
}

/**
 * Whether auth enforcement is active.
 * True when at least one provider loaded successfully.
 */
export function isAuthEnabled() {
  return activeProviders.size > 0;
}

/**
 * Whether auth is required (production mode).
 */
export function isAuthRequired() {
  return authRequired;
}

/**
 * Shutdown all providers gracefully.
 */
export async function shutdownRegistry(logFn) {
  for (const [name, provider] of activeProviders) {
    if (typeof provider.shutdown === "function") {
      try {
        await provider.shutdown();
        if (logFn) logFn("info", "auth_provider_shutdown", { name });
      } catch (err) {
        if (logFn) logFn("error", "auth_provider_shutdown_error", { name, error: err.message });
      }
    }
  }
  activeProviders.clear();
  registryInitialized = false;
}

/**
 * Reset the registry (for testing only).
 */
export function _resetForTesting() {
  activeProviders.clear();
  registryInitialized = false;
  authRequired = false;
}

// ── Exports for validation (used by test scripts) ────────────

export const PROVIDER_INTERFACE = {
  fields: [...REQUIRED_FIELDS],
  methods: [...REQUIRED_METHODS]
};
