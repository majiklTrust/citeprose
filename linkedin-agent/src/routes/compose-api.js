// ═══════════════════════════════════════════════════════════════
// compose-api.js   (Composer feature — Cycle 2)
// ═══════════════════════════════════════════════════════════════
// The Composer's OWN generation entry point, mounted at /api/compose.
// Deliberately decoupled from the Preview workflow (/api/generate-
// preview in api.js): separate router, separate handler, no shared
// glue. Both paths lean on the same STABLE primitives — generatePost,
// createActionToken, withTenant — but neither imports the other, so a
// future change here cannot reach Preview.
//
// Cycle 2 scope: validate a requested genre at the boundary (Zero
// Trust) and generate a draft from that genre's content_generator
// template. The draft is returned, not yet persisted — the Composer's
// own save/quality/approval flow lands in a later cycle. Genre reaches
// ONLY the content_generator template (enforced inside generatePost);
// research, verification, and injection-defense prompts stay invariant.
// ═══════════════════════════════════════════════════════════════

import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { generatePost } from "../services/content-generator.js";
import { createActionToken } from "../services/prompt-actions.js";
import { genreExists } from "../services/prompt-vault.js";

const router = Router();

const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

// Authenticated + tenant-scoped for every Composer route.
router.use(requireAuth);
router.use(resolveTenant);

// Mirrors the DB CHECK in 19-prompt-genre.sql. 'default' is valid.
const GENRE_RE = /^[a-z][a-z0-9_]{1,31}$/;

// POST /api/compose/generate
// Body: { topicId?, angle?, genre? }
// Generates a draft from the chosen genre and returns it. Does not
// persist — saving is a later Composer cycle.
router.post("/generate", requirePermission("preview_post"), async (req, res) => {
  try {
    const topicId = req.body.topicId || null;
    const angle = typeof req.body.angle === "string" ? req.body.angle : null;
    const rawGenre = typeof req.body.genre === "string" ? req.body.genre.trim() : "";
    const genre = rawGenre || "default";

    // Boundary validation: format first, then existence. Reject an
    // unknown genre outright rather than silently using default — the
    // operator picked it, so a wrong pick should be visible. 'default'
    // is guaranteed to exist (the base template) so it skips the lookup.
    if (!GENRE_RE.test(genre)) {
      return res.status(400).json({ error: "Invalid genre format." });
    }
    if (genre !== "default") {
      const exists = await genreExists("content_generator", genre);
      if (!exists) {
        return res.status(400).json({ error: "Unknown genre: " + genre });
      }
    }

    platformLog("info", "compose_generate_requested", {
      user: req.user.sub, topicId, genre, hasAngle: !!angle
    });

    const actionToken = createActionToken("generate-content", req.user.sub);
    const result = await withTenant(req.tenant.id, async () => {
      return generatePost(topicId, null, actionToken, angle, genre);
    });

    // generatePost returns { blocked, reason, ... } on a fail-safe stop
    // (e.g. metric fidelity). Surface it as a normal response, not a 500.
    if (result && result.blocked) {
      return res.json({
        blocked: true, reason: result.reason,
        topicId: result.topicId, angle: result.angle, genre
      });
    }

    res.json({ draft: result });
  } catch (err) {
    platformLog("error", "compose_generate_failed", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

export default router;
