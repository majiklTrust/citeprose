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

export default router;
