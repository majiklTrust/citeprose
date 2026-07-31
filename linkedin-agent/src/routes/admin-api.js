// ═══════════════════════════════════════════════════════════════
// src/routes/admin-api.js — Admin API endpoints
// ═══════════════════════════════════════════════════════════════
// User management: invites, members, role changes.
//
// Every route requires:
//   1. requireAuth (valid session or token)
//   2. resolveTenant (user has a membership)
//   3. requireNoDevBypass (dev bypass users blocked)
//   4. requirePermission("manage_users") (owner only)
//
// Two independent security gates beyond normal auth:
//   - Dev bypass block: synthetic users cannot access admin
//   - Permission check: only owners have manage_users
// ═══════════════════════════════════════════════════════════════

import { suspendedWriteGuard } from "../services/entitlements.js";
import { listProviders, listModels, getImageModelProfile, defaultModelId } from "../image/registry.js";
import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission, requireNoDevBypass } from "../tenant/permissions.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import {
  createInvite,
  listPendingInvites,
  revokeInvite
} from "../tenant/invite-store.js";
import { createAiConfigRoutes } from "./admin-ai-api.js";
import { getBudgetStatus, dollarsToCents, MAX_BUDGET_DOLLARS } from "../services/image-budget.js";
import { setAgentState, getAgentState } from "../services/database.js";

const router = Router();

const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

// ── Server-side owner gate for the /app/admin PAGE route ─────
// The static admin page previously relied on the client-side
// checkAccess() redirect; hiding the page is not access control.
// This factory returns the SAME chain the admin API enforces
// (auth -> tenant -> no dev bypass -> owner permission) plus a
// pure final owner check, for mounting in front of the static
// handler in index.js. Overrides exist for tests only (factory
// convention: no shared state between callers).
export function createAdminPageGate(overrides = {}) {
  const gateAuth = overrides.requireAuth || requireAuth;
  const gateTenant = overrides.resolveTenant || resolveTenant;
  const gateNoBypass = overrides.requireNoDevBypass || requireNoDevBypass();
  const gatePermission = overrides.requirePermission || requirePermission("manage_users");
  const gateOwnerOnly = (req, res, next) => {
    if (req.tenant && req.tenant.role === "owner" && !req.devBypass) return next();
    return res.status(403).json({ error: "Permission denied" });
  };
  return [gateAuth, gateTenant, gateNoBypass, gatePermission, gateOwnerOnly];
}

// ── Middleware chain for all admin routes ─────────────────────
router.use(requireAuth);
router.use(resolveTenant);
// Payments (2.3.4), ruling (3): outside good standing the tenant
// is read-only. Mutating verbs deny here; billing stays exempt.
router.use(suspendedWriteGuard());

router.use(requireNoDevBypass());
router.use(requirePermission("manage_users"));

// ── AI vendor / model / key configuration (owner only) ───────
// Mounted AFTER the blanket chain above, so /api/admin/ai-config
// inherits the same owner gate as user management.
router.use(createAiConfigRoutes());

// ── Email validation ─────────────────────────────────────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_INVITE_ROLES = ["editor", "viewer"];

// ══════════════════════════════════════════════════════════════
// Invites
// ══════════════════════════════════════════════════════════════

// Create a pending invite
router.post("/invites", async (req, res) => {
  try {
    const { email, role } = req.body || {};

    if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: "Valid email address required" });
    }
    if (!role || !VALID_INVITE_ROLES.includes(role)) {
      return res.status(400).json({
        error: `Role must be one of: ${VALID_INVITE_ROLES.join(", ")}`
      });
    }

    const invite = await withTenant(req.tenant.id, async () => {
      return createInvite({
        email: email.trim(),
        role,
        invitedBy: req.user.sub
      });
    });

    res.status(201).json(invite);
  } catch (err) {
    // Unique constraint violation — duplicate pending invite
    if (err.code === "23505") {
      return res.status(409).json({ error: "A pending invite already exists for this email" });
    }
    platformLog("error", "invite_create_failed", { error: err.message });
    res.status(500).json({ error: "Failed to create invite" });
  }
});

// List pending invites
router.get("/invites", async (req, res) => {
  try {
    const invites = await withTenant(req.tenant.id, async () => {
      return listPendingInvites();
    });
    res.json({ invites });
  } catch (err) {
    platformLog("error", "invite_list_failed", { error: err.message });
    res.status(500).json({ error: "Failed to list invites" });
  }
});

// Revoke a pending invite
router.delete("/invites/:id", async (req, res) => {
  try {
    const revoked = await withTenant(req.tenant.id, async () => {
      return revokeInvite(req.params.id);
    });
    if (!revoked) {
      return res.status(404).json({ error: "Invite not found or already claimed/revoked" });
    }
    res.json({ success: true });
  } catch (err) {
    platformLog("error", "invite_revoke_failed", { error: err.message });
    res.status(500).json({ error: "Failed to revoke invite" });
  }
});

// ══════════════════════════════════════════════════════════════
// Members
// ══════════════════════════════════════════════════════════════

// List members for the current tenant
router.get("/members", async (req, res) => {
  try {
    const { query } = await import("../db/pool.js");
    const r = await query(
      `SELECT m.id, m.auth_provider::text, m.auth_sub, m.role::text, m.created_at
       FROM memberships m
       WHERE m.tenant_id = $1
       ORDER BY m.created_at`,
      [req.tenant.id]
    );
    res.json({ members: r.rows });
  } catch (err) {
    platformLog("error", "members_list_failed", { error: err.message });
    res.status(500).json({ error: "Failed to list members" });
  }
});

// Change a member's role
router.patch("/members/:id", async (req, res) => {
  try {
    const { role } = req.body || {};
    if (!role || !VALID_INVITE_ROLES.includes(role)) {
      return res.status(400).json({
        error: `Role must be one of: ${VALID_INVITE_ROLES.join(", ")}`
      });
    }

    const { query } = await import("../db/pool.js");

    // Fetch the target membership
    const target = await query(
      `SELECT id, auth_sub, role::text FROM memberships WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    // Prevent self-demotion
    if (target.rows[0].auth_sub === req.user.sub) {
      return res.status(400).json({ error: "Cannot change your own role" });
    }

    // Owner role is immutable through the API
    if (target.rows[0].role === "owner") {
      return res.status(400).json({ error: "This member cannot be modified" });
    }

    const r = await query(
      `UPDATE memberships SET role = $1::member_role WHERE id = $2 AND tenant_id = $3
       RETURNING id, auth_sub, role::text`,
      [role, req.params.id, req.tenant.id]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }
    res.json(r.rows[0]);
  } catch (err) {
    platformLog("error", "member_role_change_failed", { error: err.message });
    res.status(500).json({ error: "Failed to change role" });
  }
});

// Remove a member
router.delete("/members/:id", async (req, res) => {
  try {
    const { query } = await import("../db/pool.js");

    // Fetch the target membership
    const target = await query(
      `SELECT id, auth_sub, role::text FROM memberships WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    // Prevent self-removal
    if (target.rows[0].auth_sub === req.user.sub) {
      return res.status(400).json({ error: "Cannot remove yourself" });
    }

    // Owner role is immutable through the API
    if (target.rows[0].role === "owner") {
      return res.status(400).json({ error: "This member cannot be removed" });
    }

    await query(
      `DELETE FROM memberships WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    );
    res.json({ success: true });
  } catch (err) {
    platformLog("error", "member_remove_failed", { error: err.message });
    res.status(500).json({ error: "Failed to remove member" });
  }
});

// ══════════════════════════════════════════════════════════════
// Image render budget (owner only, inherits the blanket chain above:
// auth -> tenant -> suspended-write -> no-dev-bypass -> manage_users)
// ══════════════════════════════════════════════════════════════
// The per-cycle spend cap for AI image generation. Stored as integer
// CENTS in agent_state.image_render_budget_cents, which the render
// budget gate reads (fail-closed: an unset or zero cap denies all
// generation). The owner sets a DOLLAR amount here; dollarsToCents
// (in the budget domain module, beside the gate that reads the stored
// cents) validates and rounds so float dollars cannot drift the value.

// Read the current budget status (cap, spent, remaining) for the UI.
router.get("/image-budget", async (req, res) => {
  try {
    const status = await withTenant(req.tenant.id, () => getBudgetStatus());
    res.json(status);
  } catch (err) {
    platformLog("error", "image_budget_get_failed", { error: err.message });
    res.status(500).json({ error: "Failed to read image budget" });
  }
});

// Set the per-cycle image render budget (dollars in, cents stored).
router.put("/image-budget", async (req, res) => {
  const cents = dollarsToCents((req.body || {}).dollars);
  if (cents === null) {
    return res.status(400).json({
      error: `Budget must be a dollar amount between 0 and ${MAX_BUDGET_DOLLARS}.`
    });
  }
  try {
    const status = await withTenant(req.tenant.id, async () => {
      await setAgentState("image_render_budget_cents", String(cents));
      return getBudgetStatus();
    });
    platformLog("info", "image_budget_set", { cents });
    res.json(status);
  } catch (err) {
    platformLog("error", "image_budget_set_failed", { error: err.message });
    res.status(500).json({ error: "Failed to set image budget" });
  }
});

// ══════════════════════════════════════════════════════════════
// Brand palette for AI images (owner only, same blanket chain)
// ══════════════════════════════════════════════════════════════
// Free-text tenant palette (e.g. "deep navy, warm amber, off-white")
// stored in agent_state.image_brand_palette and appended to image
// prompts at composition time. Validated here at the write AND
// sanitized defensively at composition (image-lenses.sanitizePalette):
// template braces are rejected so a palette can never smuggle a
// {{METRIC_...}} token into a post-fidelity-lock prompt.
const PALETTE_MAX = 240;
function validPalette(v) {
  if (typeof v !== "string") return null;
  if (v.length > PALETTE_MAX) return null;
  if (/[{}]/.test(v)) return null;                       // token smuggling
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;      // control chars
  return v.trim();                                       // "" clears the palette
}

router.get("/image-palette", async (req, res) => {
  try {
    const palette = await withTenant(req.tenant.id, async () => {
      return (await getAgentState("image_brand_palette")) || "";
    });
    res.json({ palette });
  } catch (err) {
    platformLog("error", "image_palette_get_failed", { error: err.message });
    res.status(500).json({ error: "Failed to read the brand palette" });
  }
});

router.put("/image-palette", async (req, res) => {
  const palette = validPalette((req.body || {}).palette);
  if (palette === null) {
    return res.status(400).json({
      error: `Palette must be plain text up to ${PALETTE_MAX} characters, without braces or control characters.`
    });
  }
  try {
    await withTenant(req.tenant.id, () => setAgentState("image_brand_palette", palette));
    platformLog("info", "image_palette_set", { chars: palette.length });
    res.json({ palette });
  } catch (err) {
    platformLog("error", "image_palette_set_failed", { error: err.message });
    res.status(500).json({ error: "Failed to set the brand palette" });
  }
});

// ══════════════════════════════════════════════════════════════
// Image storage backend switch (owner only, same blanket chain)
// ══════════════════════════════════════════════════════════════
// Tenant default backend for NEW images (agent_state
// image_storage_backend, registered in 40.2: db | s3). Existing
// images keep their recorded backend, so switching is always safe
// for old data. Switching TO s3 is fail-closed: the server must
// actually resolve a configured object store (config present AND the
// SDK installed) before the preference is stored, so an owner cannot
// strand new images on an unreachable backend.
router.get("/image-storage", async (req, res) => {
  try {
    const backend = await withTenant(req.tenant.id, async () => {
      return (await getAgentState("image_storage_backend")) || "db";
    });
    res.json({ backend });
  } catch (err) {
    platformLog("error", "image_storage_get_failed", { error: err.message });
    res.status(500).json({ error: "Failed to read the image storage backend" });
  }
});

router.put("/image-storage", async (req, res) => {
  const backend = (req.body || {}).backend;
  if (backend !== "db" && backend !== "s3") {
    return res.status(400).json({ error: "Backend must be db or s3." });
  }
  try {
    if (backend === "s3") {
      let available = false;
      try {
        const { resolveObjectStore } = await import("../storage/object-store.js");
        available = (await resolveObjectStore()) !== null;
      } catch (err) {
        platformLog("warn", "image_storage_s3_unavailable", { error: err.message });
        available = false;
      }
      if (!available) {
        return res.status(409).json({
          error: "S3 storage is not available on this server (missing configuration or SDK). New images stay on the db backend."
        });
      }
    }
    await withTenant(req.tenant.id, () => setAgentState("image_storage_backend", backend));
    platformLog("info", "image_storage_set", { backend });
    res.json({ backend });
  } catch (err) {
    platformLog("error", "image_storage_set_failed", { error: err.message });
    res.status(500).json({ error: "Failed to set the image storage backend" });
  }
});

// ══════════════════════════════════════════════════════════════
// Image model selection (owner chain). The write path 40.2 always
// anticipated: the selection is validated against the application
// image registry BEFORE it is written, closing the NOT_PROVISIONED
// dead end where registered defaults were unread and no surface
// could set the keys. The reader stays fail-closed by design:
// provisioning is an explicit owner act, never a silent default.
// ══════════════════════════════════════════════════════════════
// Image destination (Phase 6, 2.5.27): one pasted string names where
// new generated images live. The PUT proves the destination LIVE
// (write, read back, compare, delete) BEFORE anything persists: a
// destination that cannot pass the probe cannot be configured. An
// empty string clears back to the platform default.
// GET /api/admin/spend-summary: the Spend card. Read-only ledger
// sums (30-day window) by provider, recent activations, and the
// trial indicator (existence + burn, never key material).
router.get("/spend-summary", async (req, res) => {
  try {
    const out = await withTenant(req.tenant.id, async (client) => {
      const byProvider = (await client.query(
        `SELECT provider::text, key_source::text,
                COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
                COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
                SUM(cost_estimate_usd) AS cost_estimate_usd,
                COUNT(*)::int AS calls
         FROM llm_spend_events
         WHERE created_at >= now() - interval '30 days'
         GROUP BY provider, key_source
         ORDER BY provider, key_source`)).rows;
      const recent = (await client.query(
        `SELECT a.id, a.workflow::text, a.label, a.created_at,
                COALESCE(SUM(e.input_tokens),0)::bigint AS input_tokens,
                COALESCE(SUM(e.output_tokens),0)::bigint AS output_tokens,
                SUM(e.cost_estimate_usd) AS cost_estimate_usd,
                COUNT(e.id)::int AS calls
         FROM llm_activations a
         LEFT JOIN llm_spend_events e ON e.activation_id = a.id
         GROUP BY a.id, a.workflow, a.label, a.created_at
         ORDER BY a.created_at DESC
         LIMIT 10`)).rows;
      return { byProvider, recent };
    });
    const { pool } = await import("../db/pool.js");
    const trial = (await pool.query(
      `SELECT k.provider::text, k.name, k.ends_at, k.max_spend_usd,
              ta.max_spend_usd AS activation_cap, ta.id AS activation_id,
              trial_activation_spend_usd(ta.id) AS activation_spent,
              trial_key_spend_usd(k.id) AS key_spent
       FROM trial_key_activations ta
       JOIN trial_keys k ON k.id = ta.trial_key_id
       WHERE ta.tenant_id = $1 AND ta.active AND k.active
         AND now() BETWEEN k.starts_at AND k.ends_at`,
      [req.tenant.id])).rows;
    res.json({ windowDays: 30, byProvider: out.byProvider, recent: out.recent, activeTrials: trial });
  } catch (err) {
    platformLog("error", "spend_summary_failed", { error: err && err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.get("/image-destination", async (req, res) => {
  try {
    const { DESTINATION_STATE_KEY } = await import("../storage/object-store.js");
    const { hasAwsImageCredentials } = await import("../tenant/credential-store.js");
    const out = await withTenant(req.tenant.id, async () => ({
      destination: null,
      raw: await getAgentState(DESTINATION_STATE_KEY),
      hasCredentials: await hasAwsImageCredentials()      // existence only: the secret NEVER leaves the vault
    }));
    res.json({
      destination: (typeof out.raw === "string" && out.raw.trim() !== "") ? out.raw.trim() : null,
      hasCredentials: out.hasCredentials
    });
  } catch (err) {
    platformLog("error", "image_destination_get_failed", { error: err.message });
    res.status(500).json({ error: "Failed to read the image destination" });
  }
});

router.put("/image-destination", async (req, res) => {
  const raw = (req.body || {}).destination;
  const accessKeyId = (req.body || {}).accessKeyId;
  const secretAccessKey = (req.body || {}).secretAccessKey;
  if (raw !== null && typeof raw !== "string") {
    return res.status(400).json({ error: "destination must be a string, or null to clear." });
  }
  // The identity pair travels together or not at all: a half pair is
  // a mistake, never a guess.
  const idGiven = typeof accessKeyId === "string" && accessKeyId.trim() !== "";
  const secretGiven = typeof secretAccessKey === "string" && secretAccessKey.trim() !== "";
  if (idGiven !== secretGiven) {
    return res.status(400).json({ error: "Provide both the access key id and the secret, or neither." });
  }
  const suppliedCreds = idGiven ? { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() } : null;
  try {
    const os = await import("../storage/object-store.js");
    const creds = await import("../tenant/credential-store.js");
    if (raw === null || raw.trim() === "") {
      await withTenant(req.tenant.id, async () => {
        await setAgentState(os.DESTINATION_STATE_KEY, "");
        await creds.deleteCredential(creds.AWS_IMAGE_KEY_ID);       // Clear clears the identity too:
        await creds.deleteCredential(creds.AWS_IMAGE_KEY_SECRET);   // no orphaned secrets in the vault
      });
      os.resetObjectStoreCache();
      platformLog("info", "image_destination_cleared", {});
      return res.json({ destination: null, verified: false, hasCredentials: false });
    }
    const dest = await withTenant(req.tenant.id, async () => {
      // Zero Trust ordering: PROVE the identity against the exact
      // destination FIRST; only a passing pair earns the vault. The
      // probe uses the supplied pair, else the stored one, else the
      // ambient chain, precisely what renders will use.
      const verified = await os.probeObjectStoreDestination(raw.trim(),
        suppliedCreds ? { credentials: suppliedCreds } : {});        // throws typed on any failure
      if (suppliedCreds) {
        await creds.storeCredential(creds.AWS_IMAGE_KEY_ID, suppliedCreds.accessKeyId);
        await creds.storeCredential(creds.AWS_IMAGE_KEY_SECRET, suppliedCreds.secretAccessKey);
      }
      await setAgentState(os.DESTINATION_STATE_KEY, raw.trim());
      return verified;
    });
    os.resetObjectStoreCache();
    platformLog("info", "image_destination_set", { bucket: dest.bucket, prefix: dest.prefix, region: dest.region });
    return res.json({
      destination: raw.trim(), verified: true,
      bucket: dest.bucket, prefix: dest.prefix, region: dest.region, endpoint: dest.endpoint,
      hasCredentials: suppliedCreds !== null || undefined            // the secret itself never appears here
    });
  } catch (err) {
    const code = err && err.code;
    // Diagnosability (2.5.28): the adapter already knows WHICH SDK
    // error and HTTP status it folded into the typed code. Surface
    // both in the log and the refusal, so "STORE_FAILED" reads as
    // "PermanentRedirect, HTTP 301" (wrong region) or
    // "CredentialsProviderError" (no AWS identity) at a glance.
    const detail = (err && err.details) || {};
    platformLog("warn", "image_destination_probe_failed", {
      code, providerError: detail.name || null, httpStatus: detail.status || null, op: detail.op || null
    });
    let why = [detail.name, detail.status ? ("HTTP " + detail.status) : null].filter(Boolean).join(", ");
    if (detail.name === "CredentialsProviderError") {
      why += "; no AWS identity reached the bucket. Enter this workspace's access key id and secret beside the destination and save again";
    }
    if (code === "DESTINATION_INVALID") return res.status(400).json({ error: err.message, code });
    if (code === "SDK_UNAVAILABLE") return res.status(409).json({ error: "The S3 SDK is not installed on this server.", code });
    if (code === "ENDPOINT_BLOCKED" || code === "ACCESS_DENIED" || code === "STORE_FAILED" || code === "OBJECT_NOT_FOUND") {
      return res.status(409).json({
        error: "The destination did not pass the live verification: " + (err.message || code) + (why ? " [" + why + "]" : ""),
        code, providerError: detail.name || null, httpStatus: detail.status || null
      });
    }
    res.status(500).json({ error: "Failed to verify the destination" });
  }
});

router.get("/image-model", async (req, res) => {
  try {
    const providers = listProviders(process.env).map((p) => ({
      id: p.id, label: p.label,
      models: listModels(p.id)
    }));
    const current = await withTenant(req.tenant.id, async () => ({
      provider: (await getAgentState("image_provider")) || null,
      model: (await getAgentState("image_model")) || null
    }));
    res.json({ providers, current, registryDefault: { provider: "openai", model: defaultModelId("openai") } });
  } catch (err) {
    platformLog("error", "image_model_get_failed", { error: err.message });
    res.status(500).json({ error: "Failed to read the image model selection" });
  }
});

router.put("/image-model", async (req, res) => {
  const provider = (req.body || {}).provider;
  const model = (req.body || {}).model;
  if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") {
    return res.status(400).json({ error: "Provider and model are required." });
  }
  try {
    getImageModelProfile(provider, model, process.env);   // registry validation, fail-closed
  } catch {
    return res.status(400).json({ error: "The selected provider or model is not recognized by the image registry." });
  }
  try {
    await withTenant(req.tenant.id, async () => {
      await setAgentState("image_provider", provider);
      await setAgentState("image_model", model);
    });
    platformLog("info", "image_model_set", { provider, model });
    res.json({ provider, model });
  } catch (err) {
    platformLog("error", "image_model_set_failed", { error: err.message });
    res.status(500).json({ error: "Failed to save the image model selection" });
  }
});

export default router;
