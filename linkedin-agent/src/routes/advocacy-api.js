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
  setSelfMode, disconnectSelf, setVoiceNotes
} from "../services/advocacy-members.js";
import { generateVariantsForPost } from "../services/advocacy-generator.js";
import { publishApprovedVariant } from "../services/advocacy-publisher.js";
import { getAdvocacyReach } from "../services/advocacy-reach.js";
import { createActionToken } from "../services/prompt-actions.js";
import { runOutputFilter } from "../services/output-filter.js";
import { sanitizeLongText } from "../services/advocacy-generator.js";

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

// ── Member queue (Step 2, self-scoped) ────────────────────────
// Every query is bound to req.user.sub; a variant id belonging to
// another member is indistinguishable from a nonexistent one
// (FR-P2-08: no cross-member information leak).

router.get("/me/variants", async (req, res) => {
  try {
    const rows = await withTenant(req.tenant.id, async () => {
      const { currentClient } = await import("../db/with-tenant.js");
      const { rows } = await currentClient().query(
        `SELECT id, source_post_id, content, hashtags, status, member_edited,
                quality, created_at, resolved_at, published_at
           FROM advocacy_variants
          WHERE member_sub = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [req.user.sub]
      );
      return rows;
    });
    res.json({ variants: rows });
  } catch (err) {
    platformLog("error", "advocacy_variants_list_failed", { error: err.message });
    res.status(500).json({ error: "Failed to load variants" });
  }
});

// Approve, with an optional member edit. Approval queues the
// variant for publishing; the publisher itself is Step 3, so an
// approved variant holds at 'approved' until that delivery.
router.post("/me/variants/:id/approve", async (req, res) => {
  try {
    const variantId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      return res.status(400).json({ error: "invalid variant id" });
    }
    const edited = typeof (req.body || {}).content === "string" ? req.body.content : null;
    let finalContent = null;
    if (edited !== null) {
      finalContent = sanitizeLongText(edited);
      if (!finalContent) {
        return res.status(400).json({ error: "edited content is empty after sanitization" });
      }
      const filter = runOutputFilter(finalContent);
      if (filter.blocked) {
        return res.status(400).json({ error: `edited content blocked: ${filter.reason}` });
      }
    }
    const out = await withTenant(req.tenant.id, async () => {
      const { currentClient } = await import("../db/with-tenant.js");
      const r = await currentClient().query(
        `UPDATE advocacy_variants
            SET status = 'approved',
                content = COALESCE($3, content),
                member_edited = member_edited OR $4,
                resolved_at = now()
          WHERE id = $1 AND member_sub = $2 AND status = 'pending_approval'
          RETURNING id`,
        [variantId, req.user.sub, finalContent, edited !== null]
      );
      if (r.rowCount > 0) {
        const { logActivity } = await import("../services/database.js");
        await logActivity("info", "advocacy_variant_approved", {
          variantId, memberEdited: edited !== null
        }, req.user.sub);
      }
      return r.rowCount;
    });
    if (out === 0) return res.status(404).json({ error: "no pending variant with that id in your queue" });
    // Manual mode publishes on approval (Step 3). The approval
    // stands regardless; a publish failure reports its code and
    // marks the variant per the signed design.
    const pub = await withTenant(req.tenant.id, () =>
      publishApprovedVariant(variantId, req.user.sub)
    );
    if (pub.status === "published") {
      return res.json({ status: "published", variantId, linkedinId: pub.linkedinId, note: "Approved and published to your profile." });
    }
    res.status(502).json({
      status: "publish_failed", variantId, code: pub.code || null,
      error: "Approved, but publishing failed" + (pub.code ? ` (${pub.code})` : "")
    });
  } catch (err) {
    platformLog("error", "advocacy_variant_approve_failed", { error: err.message });
    res.status(500).json({ error: "Failed to approve variant" });
  }
});

router.post("/me/variants/:id/reject", async (req, res) => {
  try {
    const variantId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      return res.status(400).json({ error: "invalid variant id" });
    }
    const out = await withTenant(req.tenant.id, async () => {
      const { currentClient } = await import("../db/with-tenant.js");
      const r = await currentClient().query(
        `UPDATE advocacy_variants
            SET status = 'rejected', resolved_at = now()
          WHERE id = $1 AND member_sub = $2 AND status = 'pending_approval'
          RETURNING id`,
        [variantId, req.user.sub]
      );
      if (r.rowCount > 0) {
        const { logActivity } = await import("../services/database.js");
        await logActivity("info", "advocacy_variant_rejected", { variantId }, req.user.sub);
      }
      return r.rowCount;
    });
    if (out === 0) return res.status(404).json({ error: "no pending variant with that id in your queue" });
    res.json({ status: "rejected", variantId });
  } catch (err) {
    platformLog("error", "advocacy_variant_reject_failed", { error: err.message });
    res.status(500).json({ error: "Failed to reject variant" });
  }
});

router.post("/me/variants/:id/publish", async (req, res) => {
  try {
    const variantId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(variantId) || variantId <= 0) {
      return res.status(400).json({ error: "invalid variant id" });
    }
    const pub = await withTenant(req.tenant.id, () =>
      publishApprovedVariant(variantId, req.user.sub)
    );
    if (pub.status === "not_publishable") {
      return res.status(404).json({ error: "no approved variant with that id in your queue" });
    }
    if (pub.status === "published") {
      return res.json({ status: "published", variantId, linkedinId: pub.linkedinId });
    }
    res.status(502).json({ status: "publish_failed", variantId, code: pub.code || null });
  } catch (err) {
    platformLog("error", "advocacy_variant_publish_failed", { error: err.message });
    res.status(500).json({ error: "Failed to publish variant" });
  }
});

// ── Owner generation surface (Step 2) ─────────────────────────

router.post("/generate", requirePermission("manage_advocacy"), async (req, res) => {
  try {
    const { postId } = req.body || {};
    const actionToken = createActionToken("advocacy-variant", req.user.sub);
    const result = await withTenant(req.tenant.id, () =>
      generateVariantsForPost(postId, actionToken, req.user.sub)
    );
    if (result.status === "rejected") return res.status(400).json({ error: result.reason });
    if (result.status === "no_members") {
      return res.status(409).json({ error: "No connected advocacy members to generate for", code: "NO_CONNECTED_MEMBERS" });
    }
    if (result.status === "prompt_not_configured") {
      return res.status(409).json({
        error: "The advocacy_variant prompt is not seeded in the vault for this workspace",
        code: "PROMPT_NOT_CONFIGURED"
      });
    }
    res.json(result);
  } catch (err) {
    platformLog("error", "advocacy_generate_failed", { error: err.message });
    res.status(500).json({ error: "Failed to generate variants" });
  }
});

// Aggregate queue visibility for the owner: counts only, no
// content editing surface (FR-P2-04: approval is the member's).
router.get("/variants/status", requirePermission("manage_advocacy"), async (req, res) => {
  try {
    const rows = await withTenant(req.tenant.id, async () => {
      const { currentClient } = await import("../db/with-tenant.js");
      const { rows } = await currentClient().query(
        `SELECT member_sub, status, COUNT(*)::int AS n
           FROM advocacy_variants
          GROUP BY member_sub, status
          ORDER BY member_sub`
      );
      return rows;
    });
    res.json({ counts: rows });
  } catch (err) {
    platformLog("error", "advocacy_status_failed", { error: err.message });
    res.status(500).json({ error: "Failed to load variant status" });
  }
});

router.post("/members/voice-notes", requirePermission("manage_advocacy"), async (req, res) => {
  try {
    const { sub, voiceNotes } = req.body || {};
    const result = await withTenant(req.tenant.id, async () => {
      const r = await setVoiceNotes(sub, voiceNotes);
      if (r.status === "stored") {
        const { logActivity } = await import("../services/database.js");
        await logActivity("info", "advocacy_voice_notes_set", {
          memberSub: String(sub || "").trim(), cleared: r.cleared
        }, req.user.sub);
      }
      return r;
    });
    if (result.status === "rejected") return res.status(400).json({ error: result.reason });
    res.json(result);
  } catch (err) {
    platformLog("error", "advocacy_voice_notes_failed", { error: err.message });
    res.status(500).json({ error: "Failed to store voice notes" });
  }
});

// ── Reach (Step 4, FR-P2-05): the amplification numbers the
// Analytics page renders. Same read gate as analytics.
router.get("/reach", requirePermission("view_analytics"), async (req, res) => {
  try {
    const reach = await withTenant(req.tenant.id, () => getAdvocacyReach());
    res.json(reach);
  } catch (err) {
    platformLog("error", "advocacy_reach_failed", { error: err.message });
    res.status(500).json({ error: "Failed to load advocacy reach" });
  }
});

export default router;
