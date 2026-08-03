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

// ── FIX 3.1.6.1-A | CRITICAL ────────────────────────────────
// Threat closed: A hostile provider whose init() never resolves
// can no longer block server startup indefinitely. Each provider
// init() is wrapped in a race against this timeout. If the
// provider does not complete within the limit, it is marked as
// failed and the registry continues loading remaining providers.
const INIT_TIMEOUT_MS = 10_000;

// ── FIX 3.1.4.3-A / 3.1.4.4-A | CRITICAL ───────────────────
// Threat closed: A provider that mutates its issuer or jwksUri
// after registration can no longer redirect token validation to
// attacker-controlled keys. Provider fields are frozen at
// registration time. getJwksMap() and getIssuers() read from
// the snapshot, not the live provider object. The attacker's
// post-init mutation has no effect on token verification.
const providerSnapshots = new Map();

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
      const providerName = result.provider.name;

      // ── FIX 3.1.3.2-A | MEDIUM ──────────────────────────────
      // Threat closed: A hostile provider file that exports the
      // same name as a legitimate provider can no longer hijack
      // the name by sorting alphabetically first. When two files
      // claim the same name, BOTH are evicted — the first one
      // already registered is removed, and the second is rejected.
      // Neither can be trusted because the operator cannot tell
      // which is legitimate from file scan order alone. This
      // forces manual resolution of the naming conflict.
      if (activeProviders.has(providerName)) {
        // Evict the previously registered provider — it may be hostile
        activeProviders.delete(providerName);
        providerSnapshots.delete(providerName);

        result.status = "duplicate";
        result.reason = `duplicate provider name "${providerName}" — both providers evicted for safety`;

        if (logFn) {
          logFn("error", "auth_provider_duplicate", {
            filename: result.filename,
            name: providerName,
            reason: result.reason
          });
        }
        continue;
      }

      try {
        // ── FIX 3.1.6.1-A + 3.1.2.1-A | CRITICAL + MEDIUM ────
        // Threat closed: A provider whose init() hangs (never
        // resolves) can no longer block server startup. The init
        // call races against INIT_TIMEOUT_MS. If the provider does
        // not complete in time, it is marked as failed and the
        // registry continues with remaining providers. This also
        // addresses the hang scenario in 3.1.2.1-A.
        // ── FIX 3.1.7.1-A + 3.1.7.2-A | HIGH ─────────────────
        // Threat closed: a provider whose init() steals or plants
        // process.env values, or injects globals, is detected by an
        // env/global snapshot diff. Mutations are reverted and the
        // provider is evicted before registration (fail closed).
        const envBefore = { ...process.env };
        const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));

        await Promise.race([
          result.provider.init(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("INIT_TIMEOUT")), INIT_TIMEOUT_MS)
          )
        ]);

        const mutatedEnvKeys = [];
        for (const k of new Set([...Object.keys(envBefore), ...Object.keys(process.env)])) {
          if (process.env[k] !== envBefore[k]) {
            mutatedEnvKeys.push(k);
            if (Object.prototype.hasOwnProperty.call(envBefore, k)) {
              process.env[k] = envBefore[k];
            } else {
              delete process.env[k];
            }
          }
        }
        const addedGlobals = Object.getOwnPropertyNames(globalThis)
          .filter((k) => !globalsBefore.has(k));
        for (const k of addedGlobals) {
          try { delete globalThis[k]; } catch { /* non-configurable: reported below */ }
        }
        if (mutatedEnvKeys.length > 0 || addedGlobals.length > 0) {
          result.status = "init_failed";
          result.reason = "env/global mutation during init: provider evicted";
          if (logFn) {
            logFn("error", "auth_provider_env_mutation", {
              name: result.provider.name,
              mutatedEnvKeys,
              addedGlobals
            });
          }
          continue;
        }

        // ── FIX 3.1.4.3-A / 3.1.4.4-A | CRITICAL ─────────────
        // Snapshot immutable copies of security-critical fields at
        // registration time. getJwksMap() and getIssuers() read
        // from the snapshot, not the live provider object. A
        // provider that mutates its issuer or jwksUri via getters
        // backed by mutable variables cannot affect token
        // validation after this point.
        const snapshot = Object.freeze({
          issuer: result.provider.issuer,
          jwksUri: result.provider.jwksUri,
          audience: result.provider.audience,
          clientId: result.provider.clientId,
          name: result.provider.name,
          type: result.provider.type,
          priority: result.provider.priority
        });
        providerSnapshots.set(providerName, snapshot);

        activeProviders.set(providerName, result.provider);

        if (logFn) {
          logFn("info", "auth_provider_loaded", {
            name: snapshot.name,
            type: snapshot.type,
            issuer: snapshot.issuer,
            priority: snapshot.priority
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
 * Reads from frozen snapshots — immune to post-init provider mutation.
 */
export function getJwksMap() {
  const map = new Map();
  for (const snapshot of providerSnapshots.values()) {
    map.set(snapshot.issuer, snapshot.jwksUri);
  }
  return map;
}

/**
 * Get all registered issuers (for JWT validation allowlist).
 * Reads from frozen snapshots — immune to post-init provider mutation.
 */
export function getIssuers() {
  return [...providerSnapshots.values()].map(s => s.issuer);
}

/**
 * Get a frozen snapshot by issuer (for middleware audience lookup).
 * Returns the immutable registration-time copy, not the live provider.
 */
export function getSnapshotByIssuer(issuer) {
  for (const snapshot of providerSnapshots.values()) {
    if (snapshot.issuer === issuer) return snapshot;
  }
  return null;
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
  providerSnapshots.clear();
  registryInitialized = false;
}

/**
 * Reset the registry (for testing only).
 */
export function _resetForTesting() {
  activeProviders.clear();
  providerSnapshots.clear();
  registryInitialized = false;
  authRequired = false;
}

/**
 * Patch a frozen snapshot with test-specific values (testing only).
 * The middleware reads from snapshots, not live providers. When tests
 * monkey-patch a provider's jwksUri to point at a local JWKS server,
 * the snapshot still holds the original value. This function replaces
 * the frozen snapshot so the middleware uses the test values.
 *
 * Refuses to run in production.
 *
 * @param {string} providerName — name of the provider to patch
 * @param {object} overrides — fields to replace in the snapshot
 */
export function _patchSnapshotForTesting(providerName, overrides) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("_patchSnapshotForTesting cannot be used in production");
  }
  const existing = providerSnapshots.get(providerName);
  if (!existing) {
    throw new Error(`No snapshot found for provider "${providerName}"`);
  }
  providerSnapshots.set(providerName, Object.freeze({ ...existing, ...overrides }));
}

// ── Exports for validation (used by test scripts) ────────────

export const PROVIDER_INTERFACE = {
  fields: [...REQUIRED_FIELDS],
  methods: [...REQUIRED_METHODS]
};
