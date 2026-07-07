// =================================================================
// src/routes/advocacy-api.js, participation routes (Phase 2 Step 1)
// =================================================================
// Router-level middleware: requireAuth -> resolveTenant.
// Owner surface (manage_advocacy): list and enable/disable members.
// Member surface: NO extra permission (D2: any role participates);
// the member is derived EXCLUSIVELY from the session sub, never
// from the request body, so no caller can act on another member
// (FR-P2-04, FR-P2-08).
// =================================================================

import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import {
  enableMember, disableMember, listMembers, getSelf,
  setSelfMode, disconnectSelf
} from "../services/advocacy-members.js";

const router = Router();
const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

router.use(requireAuth);
router.use(resolveTenant);

// ── Member self surface ───────────────────────────────────────

router.get("/me", async (req, res) => {
  try {
    const self = await withTenant(req.tenant.id, () => getSelf(req.user.sub));
    res.json({
      enabled: self !== null,
      participation: self,
      role: req.tenant.role
    });
  } catch (err) {
    platformLog("error", "advocacy_me_failed", { error: err.message });
    res.status(500).json({ error: "Failed to load advocacy status" });
  }
});

router.post("/me/mode", async (req, res) => {
  try {
    const { mode } = req.body || {};
    const result = await withTenant(req.tenant.id, async () => {
      const r = await setSelfMode(req.user.sub, mode);
      if (r.status === "set") {
        const { logActivity } = await import("../services/database.js");
        await logActivity("info", "advocacy_mode_changed", { mode: r.mode }, req.user.sub);
      }
      return r;
    });
    if (result.status === "rejected") return res.status(400).json({ error: result.reason });
    res.json(result);
  } catch (err) {
    platformLog("error", "advocacy_mode_failed", { error: err.message });
    res.status(500).json({ error: "Failed to set mode" });
  }
});

router.post("/me/disconnect", async (req, res) => {
  try {
    const result = await withTenant(req.tenant.id, async () => {
      const r = await disconnectSelf(req.user.sub);
      if (r.status === "disconnected") {
        const { logActivity } = await import("../services/database.js");
        await logActivity("info", "advocacy_member_disconnected", {
          credentialsWiped: r.credentialsWiped
        }, req.user.sub);
      }
      return r;
    });
    if (result.status === "not_enabled") return res.status(404).json({ error: "Advocacy is not enabled for this member" });
    res.json(result);
  } catch (err) {
    platformLog("error", "advocacy_disconnect_failed", { error: err.message });
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

// ── Owner surface ─────────────────────────────────────────────

router.get("/members", requirePermission("manage_advocacy"), async (req, res) => {
  try {
    const members = await withTenant(req.tenant.id, () => listMembers());
    res.json({ members });
  } catch (err) {
    platformLog("error", "advocacy_members_failed", { error: err.message });
    res.status(500).json({ error: "Failed to list advocacy members" });
  }
});

router.post("/members", requirePermission("manage_advocacy"), async (req, res) => {
  try {
    const { sub, enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be true or false" });
    }
    const result = await withTenant(req.tenant.id, async () => {
      const r = enabled ? await enableMember(sub, req.user.sub) : await disableMember(sub);
      const { logActivity } = await import("../services/database.js");
      await logActivity("info", enabled ? "advocacy_member_enabled" : "advocacy_member_disabled", {
        memberSub: String(sub || "").trim()
      }, req.user.sub);
      return r;
    });
    if (result.status === "rejected") return res.status(400).json({ error: result.reason });
    res.json(result);
  } catch (err) {
    platformLog("error", "advocacy_member_toggle_failed", { error: err.message });
    res.status(500).json({ error: "Failed to update advocacy member" });
  }
});

export default router;
