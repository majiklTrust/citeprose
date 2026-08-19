// ═══════════════════════════════════════════════════════════════
// src/routes/platform-admin-api.js — Platform admin operations
// ═══════════════════════════════════════════════════════════════
// Cross-tenant administrative queries for platform super admins.
// Access requires isPlatformAdmin(req.user.sub) — same gate as
// tenant registration.
//
// Queries are defined SERVER-SIDE only. The client sends a query
// key (e.g., "clear-all-tenant-data"), the server looks it up
// and executes the predefined SQL. The client never sees or
// sends SQL — Zero Trust against injection.
//
// To add a new query: add one entry to QUERY_REGISTRY below.
//
// Endpoints:
//   GET  /api/platform-admin/queries  — list available queries
//   POST /api/platform-admin/execute  — run a named query
//
// RLS bypass:
//   All queries execute inside a transaction with SET LOCAL ROLE
//   to the platform admin database role (env: PLATFORM_ADMIN_DB_ROLE,
//   default: ***REMOVED***). This role bypasses RLS so the super
//   user sees all tenant data without per-tenant context switching.
//   SET LOCAL is transaction-scoped — the pooled connection reverts
//   to the app role on COMMIT/ROLLBACK. No leaked privileges.
//
// Zero Trust:
//   • isPlatformAdmin gate — .env PLATFORM_ADMIN_SUBS
//   • Query keys validated against registry — unknown keys rejected
//   • SQL never leaves the server
//   • Parameterized queries — no string interpolation
//   • Destructive queries require explicit confirmation flag
//   • All executions logged via platformLog
//   • Elevated DB role is transaction-scoped, never persists
// ═══════════════════════════════════════════════════════════════

import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { isPlatformAdmin } from "../tenant/platform-db.js";
import createPlatformAdminLabRoutes from "./platform-admin-lab-api.js";
import { pool } from "../db/pool.js";
import { platformLog } from "../services/platform-log.js";
import { TIERS } from "../config/entitlements.js";
import { decryptPlatformSecret } from "../services/platform-secret.js";
import { storePromptGenre } from "../services/prompt-vault.js";
import { getProvider, resolveBaseUrl } from "../llm/registry.js";
import { getModelListingPageLimit } from "../config/ai.js";
import { QUERY_REGISTRY } from "./platform-admin-queries.js";

const router = Router();

// Database role for platform admin queries. Must have privileges
// to read/write tenant tables and bypass RLS. The app role needs:
//   GRANT ***REMOVED*** TO linkedin_agent_app;
// so SET LOCAL ROLE succeeds.
// Resolved lazily on first call to createPlatformAdminRoutes()
// so that dotenv.config() has already run.
let ADMIN_DB_ROLE = null;

function resolveAdminRole() {
  if (ADMIN_DB_ROLE) return ADMIN_DB_ROLE;
  const cipher = process.env.PLATFORM_ADMIN_DB_ROLE;
  if (!cipher || typeof cipher !== "string" || cipher.trim().length === 0) {
    throw new Error("PLATFORM_ADMIN_DB_ROLE is not set — platform admin queries are disabled");
  }
  let role;
  try {
    role = decryptPlatformSecret(cipher.trim());
  } catch {
    throw new Error("PLATFORM_ADMIN_DB_ROLE could not be decrypted — platform admin queries are disabled");
  }
  const trimmed = role.trim();
  // Validate AFTER decrypt — the role is interpolated into SET LOCAL ROLE,
  // so it must be a safe PostgreSQL identifier regardless of source.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new Error("Invalid PLATFORM_ADMIN_DB_ROLE: must be a valid PostgreSQL identifier");
  }
  ADMIN_DB_ROLE = trimmed;
  return ADMIN_DB_ROLE;
}

// ── Model catalog grouping & cache ───────────────────────────
// The only static element is the family order and the substring
// used to classify a model ID into a family. Model IDs themselves
// come from the live Anthropic Models API.

const MODEL_FAMILIES = [
  { group: "Sonnet", match: "sonnet" },
  { group: "Haiku", match: "haiku" },
  { group: "Opus", match: "opus" }
];

function groupModelsByFamily(models) {
  return MODEL_FAMILIES.map((fam) => ({
    group: fam.group,
    options: models
      .map((m) => m && m.id)
      .filter((id) => typeof id === "string" && id.toLowerCase().includes(fam.match))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  })).filter((g) => g.options.length > 0);
}

let modelCache = null;
let modelCacheAt = 0;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedModels() {
  if (modelCache && Date.now() - modelCacheAt < MODEL_CACHE_TTL_MS) return modelCache;
  return null;
}

function setCachedModels(optgroups) {
  modelCache = optgroups;
  modelCacheAt = Date.now();
}

// ── Query Registry ───────────────────────────────────────────
// Each entry: key → { label, description, sql, params, destructive, readOnly }
//
// params: array of { name, label, type, required }
//   type: 'uuid' | 'text' | 'number'
//
// To add a query, add one object IN platform-admin-queries.js
// (the registry data module, 2.5.66); the frontend picks it up
// automatically from GET /queries. Nothing registers here.


// ── Middleware ────────────────────────────────────────────────

// ── Server-side PAGE gate (2.5.110) ─────────────────────────────
// Mirror of createAdminPageGate (admin-api.js): the STATIC page at
// /app/platform-admin mounts behind this chain in index, so a
// non-admin request receives a bare 403 and NONE of the page's
// bytes. The page structure is itself privileged surface: forms,
// copy, and capability names must never reach a non-admin response.
export function createPlatformAdminPageGate(overrides = {}) {
  const gateAuth = overrides.requireAuth || createAuthMiddleware().requireAuth;
  const gateAdmin = overrides.platformAdminOnly || ((req, res, next) => {
    if (req.user && isPlatformAdmin(req.user.sub)) return next();
    return res.status(403).json({ error: "Forbidden" });
  });
  return [gateAuth, gateAdmin];
}

export default function createPlatformAdminRoutes() {
  const { requireAuth } = createAuthMiddleware();

  // Platform admin gate — applied to all routes
  function requirePlatformAdmin(req, res, next) {
    if (!req.user || !isPlatformAdmin(req.user.sub)) {
      return res.status(403).json({ error: "Platform admin access required" });
    }
    next();
  }

  router.use(requireAuth);
  router.use(requirePlatformAdmin);

  // Generation Lab: sub-router inherits BOTH gates above.
  router.use("/lab", createPlatformAdminLabRoutes());

  // ── Payments (2.3.1.1): complimentary entitlements ──────────
  // The deliberate, auditable, processor-free grant. Router-level
  // gates above already enforce platform admin.

  router.get("/subscriptions", async (req, res) => {
    try {
      const { listSubscriptions } = await import("../services/entitlements.js");
      // tiers: derived from TIERS (2.4.54) so every console tier
      // surface renders the ruled set with zero hand maintenance.
      res.json({ subscriptions: await listSubscriptions(), tiers: TIERS });
    } catch (err) {
      res.status(500).json({ error: "Failed to list subscriptions" });
    }
  });

  router.post("/comp", async (req, res) => {
    try {
      const { tenantId, tier } = req.body || {};
      const { TIERS } = await import("../config/entitlements.js");
      if (!tenantId || !/^[0-9a-f-]{36}$/.test(String(tenantId))) {
        return res.status(400).json({ error: "A valid tenant id is required" });
      }
      if (!TIERS.includes(tier)) {
        return res.status(400).json({ error: "Choose a valid tier" });
      }
      const { grantComp } = await import("../services/entitlements.js");
      const row = await grantComp(tenantId, tier);
      const { platformLog } = await import("../services/platform-log.js");
      platformLog("info", "comp_entitlement_granted", { tenantId, tier, by: req.user.sub });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: "Comp grant failed" });
    }
  });

  router.delete("/comp/:tenantId", async (req, res) => {
    try {
      const tenantId = String(req.params.tenantId);
      if (!/^[0-9a-f-]{36}$/.test(tenantId)) {
        return res.status(400).json({ error: "A valid tenant id is required" });
      }
      const { revokeComp } = await import("../services/entitlements.js");
      const ok = await revokeComp(tenantId);
      if (!ok) return res.status(404).json({ error: "No complimentary subscription for that tenant" });
      const { platformLog } = await import("../services/platform-log.js");
      platformLog("info", "comp_entitlement_revoked", { tenantId, removed: true, by: req.user.sub });
      res.json({ tenantId, removed: true });
    } catch (err) {
      res.status(500).json({ error: "Comp revoke failed" });
    }
  });

  // ── GET /queries — list available queries ────────────────
  // Returns query metadata only — SQL is never exposed.

  router.get("/queries", (req, res) => {
    const queries = Object.entries(QUERY_REGISTRY).map(([key, q]) => ({
      key,
      label: q.label,
      description: q.description,
      capability: q.capability || null,
      params: q.params,
      destructive: q.destructive,
      readOnly: q.readOnly
    }));
    res.json({ queries });
  });

  // ── GET /models — live Anthropic model catalog ───────────
  // Populates the Set Anthropic Model dropdown dynamically so
  // nothing is hardcoded. Grouped server-side as Sonnet, Haiku,
  // Opus (in that order).
  //
  // Zero Trust:
  //   • Uses a dedicated platform key, never a tenant's BYOK key —
  //     a global lookup must not decrypt tenant secrets.
  //   • Key is stored ENCRYPTED at rest (env PLATFORM_ANTHROPIC_API_KEY,
  //     AES-256-GCM under HKDF(ENCRYPTION_SECRET)); decrypted at call
  //     time, held only for the request, then nulled.
  //   • Key is never logged and never sent to the client.
  //   • Fails closed if the encrypted key is unset or undecryptable (503).
  //   • Only model IDs are returned — no capabilities, pricing, or keys.
  //   • Behind the isPlatformAdmin gate (router-level).

  router.get("/models", async (req, res) => {
    const encKey = process.env.PLATFORM_ANTHROPIC_API_KEY;
    if (!encKey || encKey.trim().length === 0) {
      return res.status(503).json({ error: "Model listing is not configured" });
    }

    let apiKey;
    try {
      apiKey = decryptPlatformSecret(encKey.trim());
    } catch (err) {
      platformLog("error", "platform_key_decrypt_failed", { admin: req.user.sub });
      return res.status(503).json({ error: "Model listing is not configured" });
    }
    if (!apiKey || apiKey.length === 0) {
      return res.status(503).json({ error: "Model listing is not configured" });
    }

    const cached = getCachedModels();
    if (cached) {
      return res.json({ optgroups: cached });
    }

    try {
      // Vendor URL comes from the LLM registry profile, the single
      // sanctioned home for provider endpoints; the page limit is a
      // config getter. No vendor literals in the route layer.
      const anthropicProfile = getProvider("anthropic");
      const modelsUrl = resolveBaseUrl(anthropicProfile, process.env)
        + anthropicProfile.modelsPath + `?limit=${getModelListingPageLimit()}`;
      const resp = await fetch(modelsUrl, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        }
      });
      if (!resp.ok) {
        platformLog("error", "model_list_failed", { admin: req.user.sub, status: resp.status });
        return res.status(502).json({ error: "Could not retrieve models" });
      }
      const data = await resp.json();
      const optgroups = groupModelsByFamily(data.data || []);
      setCachedModels(optgroups);
      res.json({ optgroups });
    } catch (err) {
      platformLog("error", "model_list_error", { admin: req.user.sub, error: err.message });
      res.status(502).json({ error: "Could not retrieve models" });
    } finally {
      apiKey = null;
    }
  });
  
  // ── GET /tenants: tenant catalog for dropdowns ───────────
  // Populates tenant-select params (e.g. Set Language Model) so an
  // admin picks a tenant by name instead of pasting a UUID.
  //
  // Zero Trust:
  //   • Reads only the platform tenants table, under the platform
  //     admin DB role (SET LOCAL ROLE, transaction-scoped).
  //   • Returns only id, name, slug, and status. No secrets.
  //   • Behind the isPlatformAdmin gate (router-level).
  
  router.get("/tenants", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${resolveAdminRole()}`);   // ◄ same role elevation POST /execute uses
      const result = await client.query(
        `SELECT id, name, slug, status::text AS status
           FROM tenants
          ORDER BY name`
      );
      await client.query("COMMIT");
      res.json({ tenants: result.rows });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      platformLog("error", "tenant_list_failed", { admin: req.user.sub, error: err.message });
      res.status(502).json({ error: "Could not retrieve tenants" });
    } finally {
      client.release();
    }
  });

  // ── POST /execute — run a named query ────────────────────
  // Body: { key: string, params: { name: value, ... }, confirmed?: boolean }
  //
  // Every query runs inside a transaction with SET LOCAL ROLE
  // to the platform admin DB role. This bypasses RLS so the
  // super user sees all tenant data. The role elevation is
  // transaction-scoped — it reverts on COMMIT/ROLLBACK.

  router.post("/execute", async (req, res) => {
    const { key, params: clientParams, confirmed } = req.body || {};

    if (!key || typeof key !== "string") {
      return res.status(400).json({ error: "Query key required" });
    }

    const queryDef = QUERY_REGISTRY[key];
    if (!queryDef) {
      return res.status(400).json({ error: "Unknown query key" });
    }

    // Destructive queries require explicit confirmation
    if (queryDef.destructive && !confirmed) {
      return res.status(400).json({
        error: "Destructive query requires confirmation",
        requiresConfirmation: true
      });
    }

    // Build parameter array in order
    const paramValues = [];
    for (const p of queryDef.params) {
      const val = clientParams?.[p.name];
      if (p.required && (!val || String(val).trim().length === 0)) {
        return res.status(400).json({ error: `Parameter '${p.label}' is required` });
      }
      paramValues.push(val || null);
    }

    platformLog("info", "platform_admin_query", {
      admin: req.user.sub,
      query: key,
      params: clientParams,
      destructive: queryDef.destructive
    });

    // ── Restricted table protection ──────────────────────────
    // Prevent admin queries from reading encrypted prompt content.
    // Metadata queries (key, description, updated_at) are allowed.
    //
    // EXCEPTION: an exception is made for the guarded
    // platform-admin/lab traceability routine. The Generation Lab
    // returns decrypted prompt templates in its run response so an
    // operator can see which vault row served each prompt. That path
    // is gated by requireAuth + requirePlatformAdmin, decrypts
    // server-side, and is read only. This firewall still stands for
    // the /execute path, which must never reach value_enc: raw
    // registry SQL cannot decrypt, and encryption must never happen
    // client-side.
    var RESTRICTED_COLUMNS = [
      { table: "prompt_vault", columns: ["value_enc"] }
    ];

    var sqlLower = queryDef.sql.toLowerCase();
    for (var restriction of RESTRICTED_COLUMNS) {
      if (!sqlLower.includes(restriction.table)) continue;
      for (var col of restriction.columns) {
        if (sqlLower.includes(col)) {
          platformLog("warn", "platform_admin_restricted_column", {
            admin: req.user.sub, query: key, table: restriction.table, column: col
          });
          return res.status(403).json({ error: "Query references a restricted column" });
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${resolveAdminRole()}`);

      const result = await client.query(queryDef.sql, paramValues);

      await client.query("COMMIT");

      platformLog("info", "platform_admin_query_result", {
        query: key,
        rowCount: result.rowCount,
        command: result.command
      });

      res.json({
        success: true,
        command: result.command,
        rowCount: result.rowCount,
        rows: queryDef.readOnly ? result.rows : undefined,
        fields: queryDef.readOnly ? result.fields?.map(f => f.name) : undefined
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      platformLog("error", "platform_admin_query_failed", {
        query: key, error: err.message
      });
      res.status(500).json({ error: "An internal error occurred" });
    } finally {
      client.release();
    }
  });

  // ── Content genre insert ─────────────────────────────────
  // Dedicated endpoint — NOT part of QUERY_REGISTRY/execute.
  //
  // Why separate: the /execute path runs raw registry SQL and is
  // firewalled from prompt_vault.value_enc by design (encryption
  // must never happen client-side). That firewall governs /execute
  // only; an exception is made for the guarded platform-admin/lab
  // traceability routine, which decrypts server-side behind the same
  // admin gate and returns templates for display. Inserting a genre template
  // requires server-side AES-256-GCM encryption, so it goes
  // through storePromptGenre() in prompt-vault.js — the same
  // encrypt() the default prompt uses. Plaintext is received over
  // the authenticated admin request, encrypted in memory, and only
  // the ciphertext blob is persisted. The body is never logged.
  //
  // SECURITY NOTE (tracked, high priority): the template plaintext
  // travels over the wire and lives briefly in server memory during
  // this request. Same exposure profile as seeding the default
  // prompt. TLS termination at the ALB/CloudFront protects it in
  // transit. A future hardening pass should reduce this window.
  //
  // Gated by router-level requireAuth + requirePlatformAdmin.
  router.post("/content-genre", async (req, res) => {
    const { genre, template, description, confirmed } = req.body || {};

    // Audit the attempt WITHOUT the template body or any ciphertext.
    platformLog("info", "content_genre_write_attempt", {
      admin: req.user.sub,
      genre: typeof genre === "string" ? genre : "(invalid)",
      templateLength: typeof template === "string" ? template.length : 0,
      confirmed: confirmed === true
    });

    try {
      const result = await storePromptGenre(
        "content_generator", genre, template, description, confirmed === true
      );
      res.json({ success: true, action: result.action, key: "content_generator", genre });
    } catch (err) {
      // CONFIRM_OVERWRITE is not a failure — it tells the UI the
      // template already exists and to ask the admin to confirm
      // the overwrite, then resend with confirmed:true. 409 Conflict.
      if (err.code === "CONFIRM_OVERWRITE") {
        return res.status(409).json({
          needsConfirm: true,
          message: "A template for genre '" + genre + "' already exists. Overwrite it?"
        });
      }
      // Map known validation codes to safe 400s; everything else
      // is a generic 500 that never leaks internals.
      const SAFE = {
        INVALID_GENRE:  "Genre must be lowercase, start with a letter, and be 2-32 characters.",
        EMPTY_TEMPLATE: "Template text is required.",
        EMPTY_DESCRIPTION: "Description is required."
      };
      if (err.code && SAFE[err.code]) {
        platformLog("warn", "content_genre_write_rejected", {
          admin: req.user.sub, genre, reason: err.code
        });
        return res.status(400).json({ error: SAFE[err.code], code: err.code });
      }
      platformLog("error", "content_genre_write_failed", {
        admin: req.user.sub, error: err.message
      });
      return res.status(500).json({ error: "An internal error occurred" });
    }
  });

  // ── Trial key management (Phase D writes) ────────────────────
  // The console's first write routes: same isPlatformAdmin gate,
  // pool-level access (platform tables carry no RLS), loud audits.
  // Key material is validated against the provider BEFORE the vault
  // accepts it (prove-first), encrypted platform-secret, and never
  // echoed in any response or log.

  router.post("/trial-keys", async (req, res) => {
    if (!isPlatformAdmin(req.user && req.user.sub)) return res.status(403).json({ error: "Forbidden" });
    const { provider, name, apiKey, maxSpendUsd, startsAt, endsAt } = req.body || {};
    if (!provider || !name || !apiKey || !Number.isFinite(Number(maxSpendUsd)) || !startsAt || !endsAt) {
      return res.status(400).json({ error: "provider, name, apiKey, maxSpendUsd, startsAt, endsAt required", code: "INVALID_INPUT" });
    }
    try {
      const { validateProviderKey } = await import("../llm/client.js");
      let probe;
      try {
        probe = await validateProviderKey(provider, apiKey);
      } catch (provErr) {
        if (provErr && provErr.code === "UNKNOWN_PROVIDER") {
          return res.status(400).json({ error: "Unknown provider: " + String(provider), code: "UNKNOWN_PROVIDER" });
        }
        throw provErr;
      }
      if (!probe || probe.valid !== true) {
        return res.status(400).json({ error: "Key failed live validation for " + provider, code: "KEY_INVALID" });
      }
      const { createTrialKey } = await import("../spend/trial-store.js");
      const out = await createTrialKey({ provider, name, apiKey, maxSpendUsd: Number(maxSpendUsd), startsAt, endsAt, createdBy: req.user.sub });
      platformLog("info", "trial_key_created", { trialKeyId: out.id, provider, name, by: req.user.sub });
      return res.status(201).json({ id: out.id, provider, name });
    } catch (err) {
      platformLog("error", "trial_key_create_failed", { error: err && err.message, by: req.user && req.user.sub });
      return res.status(500).json({ error: "An internal error occurred" });
    }
  });

  router.get("/trial-keys", async (req, res) => {
    if (!isPlatformAdmin(req.user && req.user.sub)) return res.status(403).json({ error: "Forbidden" });
    try {
      const { listTrialKeys } = await import("../spend/trial-store.js");
      return res.json({ keys: await listTrialKeys() });
    } catch (err) {
      platformLog("error", "trial_key_list_failed", { error: err && err.message });
      return res.status(500).json({ error: "An internal error occurred" });
    }
  });

  router.post("/trial-keys/:id/active", async (req, res) => {
    if (!isPlatformAdmin(req.user && req.user.sub)) return res.status(403).json({ error: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    const active = !!(req.body || {}).active;
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id", code: "INVALID_INPUT" });
    try {
      const { setTrialKeyActive } = await import("../spend/trial-store.js");
      await setTrialKeyActive(id, active, req.user.sub);
      platformLog("info", active ? "trial_key_reactivated" : "trial_key_revoked", { trialKeyId: id, by: req.user.sub });
      return res.json({ id, active });
    } catch (err) {
      platformLog("error", "trial_key_toggle_failed", { error: err && err.message });
      return res.status(500).json({ error: "An internal error occurred" });
    }
  });

  router.post("/trial-keys/:id/activate", async (req, res) => {
    if (!isPlatformAdmin(req.user && req.user.sub)) return res.status(403).json({ error: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    const { tenantId, maxSpendUsd } = req.body || {};
    if (!Number.isFinite(id) || !tenantId) return res.status(400).json({ error: "id and tenantId required", code: "INVALID_INPUT" });
    try {
      const { activateForTenant } = await import("../spend/trial-store.js");
      const out = await activateForTenant({ trialKeyId: id, tenantId, maxSpendUsd: maxSpendUsd != null ? Number(maxSpendUsd) : null, activatedBy: req.user.sub });
      platformLog("info", "trial_activated", { trialKeyId: id, trialActivationId: out.id, tenantId, by: req.user.sub });
      return res.status(201).json({ activationId: out.id });
    } catch (err) {
      platformLog("error", "trial_activate_failed", { error: err && err.message, tenantId });
      return res.status(500).json({ error: "An internal error occurred" });
    }
  });

  router.post("/trial-activations/:id/deactivate", async (req, res) => {
    if (!isPlatformAdmin(req.user && req.user.sub)) return res.status(403).json({ error: "Forbidden" });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id", code: "INVALID_INPUT" });
    try {
      const { deactivateActivation } = await import("../spend/trial-store.js");
      await deactivateActivation(id, req.user.sub);
      platformLog("info", "trial_deactivated", { trialActivationId: id, by: req.user.sub });
      return res.json({ id, active: false });
    } catch (err) {
      platformLog("error", "trial_deactivate_failed", { error: err && err.message });
      return res.status(500).json({ error: "An internal error occurred" });
    }
  });

  return router;
}
