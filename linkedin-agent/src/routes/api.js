// ═══════════════════════════════════════════════════════════════
// API Routes — Dashboard backend endpoints (async + per-tenant)
// ═══════════════════════════════════════════════════════════════
// Every data-touching handler wraps its DB work in withTenant
// using req.tenant.id (attached by the TenantResolver middleware
// which runs after requireAuth). RLS enforces per-tenant row
// visibility; the wrapper guarantees the pg client has the
// correct tenant context set for the transaction.
//
// Middleware chain (top-to-bottom for protected routes):
//   requireAuth  →  createTenantResolver()  →  handler
// The resolver is inserted immediately after requireAuth so
// req.tenant is present before any handler executes.

import { Router } from "express";
import {
  getPostStats,
  getAllPosts,
  getPostsByStatus,
  getAgentState,
  setAgentState,
  getActivityLog,
  getPost,
  createPost,
  updatePost,
  updatePostStatus,
  logActivity
} from "../services/database.js";
import {
  approvePost,
  rejectPost,
  canPostNow,
  forceCycle
} from "../services/scheduler.js";
import { generatePost, qualityCheck } from "../services/content-generator.js";
import { validateToken } from "../services/linkedin-api.js";
import { getArticleStats, getArticlesForTopic, pollAllFeeds, pollSingleFeed } from "../services/news-monitor.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { isAuthEnabled } from "../auth/index.js";
import { getServerAddress } from "../services/server-address.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { isPlatformAdmin } from "../tenant/platform-db.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant, currentClient as client } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { isSafeUrl, isImageUrl } from "../services/security.js";
import { getAnthropicModel } from "../config/ai.js";
import { getPublishMode } from "../services/linkedin-publisher.js";
import { handleImageProxy } from "./image-proxy.js";

const router = Router();

// ── Pre-Auth Route Existence Check ────────────────────────────
// Return 404 for any /api/* path that isn't a registered route.
// Registered BEFORE requireAuth so unknown paths can't probe for
// the auth wall — they get a 404 regardless of whether they
// would have been protected. This prevents the "authenticated-
// only 401 leak" pattern where a 401 reveals that a path exists.
// If the path matches a registered route, fall through to auth.
router.use((req, res, next) => {
  const reqPath = req.path;
  const reqMethod = req.method.toLowerCase();

  const matched = router.stack.some(layer => {
    if (!layer.route || !layer.route.path) return false;
    // Path match: either exact or with route params (:id)
    const routePath = layer.route.path;
    const isParam = routePath.includes(':');
    if (!isParam) {
      if (routePath !== reqPath) return false;
    } else {
      // Convert /api/posts/:id → regex-style match
      const pattern = new RegExp('^' + routePath.replace(/:[^/]+/g, '[^/]+') + '$');
      if (!pattern.test(reqPath)) return false;
    }
    // Method match — OPTIONS and HEAD are permitted for CORS preflight
    if (layer.route.methods[reqMethod]) return true;
    if (reqMethod === 'options' || reqMethod === 'head') return true;
    return false;
  });

  if (!matched) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
});

// Auth middleware receives platformLog instead of the tenant-scoped
// logActivity. Auth-path events (token_expired, issuer_unknown,
// jwks_fetch_failed) fire BEFORE tenant resolution — there is no
// tenant context at that point. platformLog writes to the console
// so these events are preserved in the diagnostic trail rather
// than silently swallowed by safeLog's rejection handler.
const { requireAuth, optionalAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

// ── Public Routes (no auth required) ────────────────────────
// /api/status is reachable without a token. optionalAuth reads
// the session if present but never blocks. It has no tenant
// scope — data returned is platform-level (server address, auth
// config) or left null when no tenant is available.

router.get("/api/status", optionalAuth, async (req, res) => {
  try {
    // Platform-level data — no tenant context required
    const serverAddress = getServerAddress().display;
    const authRequired = isAuthEnabled() && !req.devBypass;
    const maxPostsPer10Days = parseInt(process.env.MAX_POSTS_PER_10_DAYS || "4", 10);

    // Tenant-scoped data — only available if caller is authenticated
    // AND has a tenant. Otherwise omit (dashboard handles nulls).
    let stats = null, mode = null, paused = false, corroboration = "enabled";
    let researchStats = null;
    let cadence = null;
    let tokenStatus = { valid: false };
    let anthropicModel = null;
    let tenantRole = null;

    if (req.user && req.user.sub) {
      // Try to resolve the tenant from the session user. If the
      // caller is authenticated but has no tenant, check for a
      // pending invite before giving up.
      try {
        const { findTenantByAuthIdentity, findPendingInviteByEmail, claimInvite } = await import("../tenant/platform-db.js");
        const provider = req.user.authMethod === "bearer"
          ? (req.authProvider || "auth0")
          : "auth0";
        let tenant = await findTenantByAuthIdentity(provider, req.user.sub);

        // ── Invite claim (mirrors resolveTenant Path 2) ──────
        // If no membership exists but the user's email matches a
        // pending invite, claim it now. This is the first API call
        // after login — if we don't claim here, the dashboard shows
        // "No Membership" and the resolver never gets a chance.
        if (!tenant && req.user.email) {
          try {
            const invite = await findPendingInviteByEmail(req.user.email);
            if (invite) {
              tenant = await claimInvite(invite.id, provider, req.user.sub);
              if (tenant) {
                platformLog("info", "invite_claimed_via_status", {
                  email: req.user.email,
                  tenantId: tenant.id,
                  tenantSlug: tenant.slug
                });
              }
            }
          } catch (claimErr) {
            platformLog("warn", "invite_claim_failed_in_status", {
              email: req.user.email,
              error: claimErr.message
            });
          }
        }

        if (tenant) {
          tenantRole = tenant.role || null;
          await withTenant(tenant.id, async () => {
            stats = await getPostStats();
            mode = await getAgentState("mode");
            const p = await getAgentState("paused");
            paused = p === "true";
            corroboration = (await getAgentState("corroboration")) || "enabled";
            try { researchStats = await getArticleStats(); } catch { /* monitor not ready */ }
            // Cadence and LinkedIn token status are tenant-scoped
            // (each tenant has their own post history and their own
            // LinkedIn credentials). Populate them inside the tenant
            // block so currentTenantId() returns a valid UUID.
            cadence = await canPostNow();
            tokenStatus = await validateToken().catch(() => ({ valid: false, reason: "Check failed" }));
            anthropicModel = await getAnthropicModel();
          });
        }
      } catch {
        // Tenant lookup failed — return platform-level data only
      }
    }

    res.json({
      authRequired,
      devBypass: !!req.devBypass,
      user: req.user ? {
        name: req.user.name || null,
        email: req.user.email || null,
        sub: req.user.sub || null,
        role: tenantRole,
        isPlatformAdmin: isPlatformAdmin(req.user.sub),
      } : null,
      serverAddress,
      mode,
      paused,
      corroboration,
      cadence,
      stats,
      maxPostsPer10Days,
      researchStats,
      feedLimit: parseInt(process.env.DASHBOARD_FEED_LIMIT) || 8,
      linkedinConnected: tokenStatus.valid,
      linkedinProfile: tokenStatus.valid ? tokenStatus.name : null,
      anthropicModel,
      publishMode: getPublishMode()
    });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── Protected Routes (auth + tenant required) ─────────────────
// Everything below this line:
//   1. requires a valid Bearer token or session (requireAuth)
//   2. requires a tenant membership (resolveTenant sets req.tenant)
//   3. runs all DB work inside withTenant(req.tenant.id, ...)

router.use(requireAuth);
router.use(resolveTenant);

// ── Posts ─────────────────────────────────────────────────────

router.get("/api/posts", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50");
    const status = req.query.status;
    const posts = await withTenant(req.tenant.id, async () => {
      return status ? await getPostsByStatus(status) : await getAllPosts(limit);
    });
    res.json({ posts });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.get("/api/posts/:id", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const post = await withTenant(req.tenant.id, async () => {
      return getPost(parseInt(req.params.id));
    });
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json({ post });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── Edit Pending Post ────────────────────────────────────────
// Patches editable fields (title, content, hashtags) on a post.
// Restricted to pending_approval posts — see updatePost guard in
// database.js. Body shape: { title?, content?, hashtags?, image_url? }.
// Any supplied field is updated; omitted fields are left unchanged.
// image_url accepts a string URL or null (clears image for text-only).
//
// Status mapping for known database errors:
//   NOT_FOUND     → 404
//   NOT_EDITABLE  → 409 (conflict — wrong state for this operation)
//   NO_FIELDS     → 400
//   anything else → 500
router.patch("/api/posts/:id", requirePermission("edit_post"), async (req, res) => {
  try {
    const { title, content, hashtags, image_url } = req.body || {};
    const fields = {};
    if (title !== undefined)   fields.title = title;
    if (content !== undefined) fields.content = content;
    if (hashtags !== undefined) fields.hashtags = hashtags;
    if (image_url !== undefined) {
      // null clears the image; string must pass SSRF check
      if (image_url !== null && typeof image_url === "string" && image_url.length > 0) {
        if (!isImageUrl(image_url)) {
          return res.status(400).json({ error: "URL must be a valid HTTPS image (JPEG, PNG, GIF, or WebP)" });
        }
        fields.image_url = image_url;
      } else {
        fields.image_url = null;
      }
    }

    const updated = await withTenant(req.tenant.id, async () => {
      const row = await updatePost(parseInt(req.params.id), fields);
      await logActivity("info", "post_edited", {
        postId: row.id,
        fieldsChanged: Object.keys(fields)
      }, req.user?.sub || null);
      return row;
    });

    res.json({ success: true, post: updated });
  } catch (err) {
    if (err.code === "NOT_FOUND")    return res.status(404).json({ error: err.message });
    if (err.code === "NOT_EDITABLE") return res.status(409).json({ error: err.message });
    if (err.code === "NO_FIELDS")    return res.status(400).json({ error: err.message });
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── Approval Flow ────────────────────────────────────────────
// approvePost and rejectPost must run inside withTenant because
// they both modify posts. The scheduler services are converted
// in delivery 0.45.1.16 to accept the tenant context via
// AsyncLocalStorage (they will read currentTenantId internally).

router.post("/api/posts/:id/approve", requirePermission("approve_reject_post"), async (req, res) => {
  try {
    const result = await withTenant(req.tenant.id, async () => {
      return approvePost(parseInt(req.params.id), req.user?.sub || null);
    });
    res.json({ success: true, result });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/posts/:id/reject", requirePermission("approve_reject_post"), async (req, res) => {
  try {
    await withTenant(req.tenant.id, async () => {
      return rejectPost(parseInt(req.params.id), req.body.reason || "", req.user?.sub || null);
    });
    res.json({ success: true });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── Mode Control ─────────────────────────────────────────────

router.post("/api/mode", requirePermission("change_mode"), async (req, res) => {
  try {
    const { mode } = req.body;
    if (!["auto", "manual"].includes(mode)) {
      return res.status(400).json({ error: "Mode must be 'auto' or 'manual'" });
    }
    await withTenant(req.tenant.id, async () => {
      await setAgentState("mode", mode);
    });
    res.json({ mode });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/pause", requirePermission("change_mode"), async (req, res) => {
  try {
    const { paused } = req.body;
    await withTenant(req.tenant.id, async () => {
      await setAgentState("paused", String(!!paused));
    });
    res.json({ paused: !!paused });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/corroboration", requirePermission("toggle_corroboration"), async (req, res) => {
  try {
    const { enabled } = req.body;
    const value = enabled === false ? "disabled" : "enabled";
    await withTenant(req.tenant.id, async () => {
      await setAgentState("corroboration", value);
      await logActivity("info", "corroboration_toggled", { corroboration: value }, req.user?.sub || null);
    });
    res.json({ corroboration: value });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── Manual Triggers ──────────────────────────────────────────

router.post("/api/generate-preview", requirePermission("preview_post"), async (req, res) => {
  try {
    const topicId = req.body.topicId || null;
    const result = await withTenant(req.tenant.id, async () => {
      const g = await generatePost(topicId);
      if (g.blocked) return { generated: g, quality: null, postId: null };
      const q = await qualityCheck(g.content, g.researchSummary);

      // Auto-save as draft — content persists even if the session
      // expires before the user clicks "Queue for Approval."
      const storedContext = {
        angle: g.angle || "",
        sourcesUsed: g.sourcesUsed || [],
        researchSummary: g.researchSummary || null,
        qualityScores: q?.scores,
        factualFlags: q?.factual_flags,
        articleImages: Array.isArray(g.articleImages) ? g.articleImages.slice(0, 20) : []
      };

      const postId = await createPost({
        topicId: g.topicId,
        title: g.title,
        content: g.content,
        hashtags: g.hashtags || [],
        newsContext: storedContext,
        scheduledFor: null,
        imageUrl: null
      });

      await logActivity("info", "preview_auto_saved", {
        postId, title: g.title, topicId: g.topicId
      }, req.user?.sub || null);

      return { generated: g, quality: q, postId };
    });

    if (result.generated.blocked) {
      return res.json({
        blocked: true, reason: result.generated.reason,
        topicId: result.generated.topicId, angle: result.generated.angle
      });
    }
    res.json({ post: result.generated, quality: result.quality, postId: result.postId });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/save-preview", requirePermission("edit_post"), async (req, res) => {
  try {
    const { postId, topicId, title, content, hashtags, angle, sourcesUsed, researchSummary, quality, imageUrl, articleImages } = req.body;

    // Validate postId if provided — must be integer to prevent DB type errors
    if (postId !== undefined && postId !== null && (!Number.isInteger(postId) || postId < 1)) {
      return res.status(400).json({ error: "Invalid postId" });
    }

    // Validate image URL if provided
    let validatedImageUrl = null;
    if (imageUrl && typeof imageUrl === "string" && imageUrl.length > 0) {
      if (!isImageUrl(imageUrl)) {
        return res.status(400).json({ error: "Image URL must be a valid HTTPS image" });
      }
      validatedImageUrl = imageUrl;
    }

    const savedId = await withTenant(req.tenant.id, async () => {
      // If postId provided, promote the existing draft
      if (postId) {
        // Update editable fields in case user modified them
        if (title || content || hashtags) {
          const c = client();
          await c.query(
            `UPDATE posts SET
               title = COALESCE($1, title),
               content = COALESCE($2, content),
               hashtags = COALESCE($3::jsonb, hashtags),
               image_url = $4
             WHERE id = $5 AND tenant_id = current_tenant_id() AND status = 'draft'`,
            [title || null, content || null, hashtags ? JSON.stringify(hashtags) : null, validatedImageUrl, postId]
          );
        }
        await updatePostStatus(postId, "pending_approval");
        await logActivity("info", "draft_promoted_to_queue", { postId, title }, req.user?.sub || null);
        return postId;
      }

      // Fallback: create new post if no postId (legacy flow)
      if (!topicId || !title || !content) {
        throw new Error("Missing required fields: topicId, title, content");
      }

      const storedContext = {
        angle: angle || "",
        sourcesUsed: sourcesUsed || [],
        researchSummary: researchSummary || null,
        qualityScores: quality?.scores,
        factualFlags: quality?.factual_flags,
        articleImages: Array.isArray(articleImages) ? articleImages.slice(0, 20) : []
      };

      const id = await createPost({
        topicId,
        title,
        content,
        hashtags: hashtags || [],
        newsContext: storedContext,
        scheduledFor: null,
        imageUrl: validatedImageUrl
      });
      await updatePostStatus(id, "pending_approval");
      await logActivity("info", "preview_saved_to_queue", { postId: id, title }, req.user?.sub || null);
      return id;
    });

    res.json({ success: true, postId: savedId });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/force-cycle", requirePermission("force_cycle"), async (req, res) => {
  try {
    const topicId = req.body.topicId || null;
    await withTenant(req.tenant.id, async () => {
      return forceCycle(topicId, req.user?.sub || null);
    });
    res.json({ success: true, message: "Scheduler cycle executed", topicId: topicId || "auto" });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── Research & News Monitor ──────────────────────────────────

router.get("/api/research/stats", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const stats = await withTenant(req.tenant.id, async () => getArticleStats());
    res.json(stats);
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.get("/api/research/articles", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const topicId = req.query.topic;
    const maxAge = parseInt(req.query.maxAge || "14");
    const limit = parseInt(req.query.limit || "20");

    if (!topicId) {
      return res.status(400).json({ error: "topic query parameter required" });
    }

    const articles = await withTenant(req.tenant.id, async () => {
      return getArticlesForTopic(topicId, maxAge, limit);
    });
    res.json({ articles });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/research/poll", requirePermission("refresh_feeds"), async (req, res) => {
  try {
    const newArticles = await withTenant(req.tenant.id, async () => pollAllFeeds());
    res.json({ success: true, newArticles });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/research/single", requirePermission("refresh_feeds"), async (req, res) => {
  try {
    const { feedId } = req.body;
    if (!feedId) {
      return res.status(400).json({ error: "feedId is required" });
    }
    const result = await withTenant(req.tenant.id, async () => pollSingleFeed(feedId));
    res.json(result);
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── Image Proxy ─────────────────────────────────────────────
// Server-side proxy for article image thumbnails. Handler in
// src/routes/image-proxy.js — validates URL, fetches with SSRF
// guard, confirms magic bytes, returns binary with cache headers.

router.get("/api/image-proxy", requirePermission("view_dashboard"), handleImageProxy);

// ── Activity Log ─────────────────────────────────────────────

router.get("/api/logs", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "100");
    const logs = await withTenant(req.tenant.id, async () => getActivityLog(limit));
    res.json({ logs });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// ── LinkedIn Auth ────────────────────────────────────────────

router.get("/api/linkedin/status", requirePermission("view_dashboard"), async (req, res) => {
  try {
    // validateToken reads tenant-scoped LinkedIn credentials;
    // runs inside withTenant so the credential store can resolve.
    const status = await withTenant(req.tenant.id, async () => {
      return validateToken().catch(() => ({ valid: false }));
    });
    res.json(status);
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

export default router;
