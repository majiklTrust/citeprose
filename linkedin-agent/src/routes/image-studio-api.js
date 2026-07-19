// ═══════════════════════════════════════════════════════════════
// src/routes/image-studio-api.js - the Image Studio HTTP surface
// ═══════════════════════════════════════════════════════════════
// Mounted at /api/image-studio, BEFORE apiRoutes (api.js's guard
// 404s unknown /api/* paths). Own auth + tenant middleware, like
// the Composer and Analytics routers; decoupled from every other
// feature router.
//
// Gate order at the router boundary:
//   requireAuth        -> a session is required
//   resolveTenant      -> req.tenant is set for RLS
//   requireEntitlement("image_studio") -> business_premium capability
//   suspendedWriteGuard() -> mutating verbs are read-only when the
//                         subscription is not in good standing
//   Cache-Control no-store -> tenant image bytes and metadata are
//                         never cached by a browser or intermediary
//
// Per-route role gates reuse existing owner+editor permissions:
//   generate -> preview_post (generation is a preview-class action)
//   attach   -> edit_post    (attaching an image edits the post)
// Viewers hold neither, so they can view (serve) but not create.
//
// One withTenant wraps generate so the budget gate, the render, the
// per-tenant key lookup, and the store all share one tenant
// transaction. KNOWN TRADEOFF (flagged for the hardening step): the
// vendor render happens inside that transaction, holding a pooled
// connection for the duration of the call; moving the vendor call
// outside the transaction is the first optimization once the pipe
// is proven.
// ═══════════════════════════════════════════════════════════════

import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { requireEntitlement, suspendedWriteGuard } from "../services/entitlements.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { render } from "../image/client.js";
import { makeBudgetGate, getBudgetStatus } from "../services/image-budget.js";
import { storeImage, readImageBytes, getImageMeta } from "../services/image-store.js";
import { deriveImageBrief } from "../image/image-brief.js";
import { lockBrief } from "../image/image-fidelity.js";
import { imageError, IMAGE_ERROR_CODES } from "../image/errors.js";
import { getPost } from "../services/database.js";

const router = Router();
const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

router.use(requireAuth);
router.use(resolveTenant);
router.use(requireEntitlement("image_studio"));
router.use(suspendedWriteGuard());
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

// Map an image-domain error code to an HTTP status. Unknown codes
// are a 500: a code we did not anticipate is a server fault, not a
// client one. Messages are the typed error's own; details are not
// echoed so nothing tenant-specific leaks in an error body.
function statusForCode(code) {
  switch (code) {
    case "INVALID_INPUT":
    case "INVALID_REQUEST":
    case "UNSUPPORTED_SIZE":
    case "UNSUPPORTED_QUALITY": return 400;
    case "BUDGET_REQUIRED":
    case "BUDGET_NOT_SET":
    case "BUDGET_EXCEEDED": return 402;
    case "NO_TENANT_CONTEXT": return 403;
    case "IMAGE_NOT_FOUND": return 404;
    case "POST_NOT_FOUND": return 404;
    case "NOT_PROVISIONED":
    case "MISSING_CREDENTIAL":
    case "UNKNOWN_PROVIDER":
    case "UNKNOWN_MODEL": return 409;
    case "CONTENT_REJECTED": return 422;
    case "STORAGE_BACKEND_UNAVAILABLE": return 503;
    case "TIMEOUT": return 504;
    case "EGRESS_BLOCKED":
    case "VENDOR_HTTP":
    case "BAD_RESPONSE": return 502;
    default: return 500;
  }
}
function sendError(res, err) {
  const code = (err && err.code) || "ERROR";
  return res.status(statusForCode(code)).json({ error: (err && err.message) || "Image request failed", code });
}
function parseId(v) { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; }

// GET /api/image-studio/budget - remaining budget for the UI. Read
// only, so it survives a suspended (read-only) subscription.
router.get("/budget", async (req, res) => {
  try {
    const status = await withTenant(req.tenant.id, () => getBudgetStatus());
    return res.status(200).json(status);
  } catch (err) {
    platformLog("warn", "image_budget_status_failed", { code: err && err.code });
    return sendError(res, err);
  }
});

// POST /api/image-studio/generate - render one image and store it.
// The budget gate is the real per-cycle gate, injected into render,
// which clears it before any spend. Returns the stored image id and
// metadata; the bytes are fetched separately via /serve.
router.post("/generate", requirePermission("preview_post"), async (req, res) => {
  const b = req.body || {};
  try {
    const out = await withTenant(req.tenant.id, async () => {
      const rendered = await render(
        {
          prompt: b.prompt,
          negativePrompt: b.negativePrompt,
          size: b.size,
          quality: b.quality,
          count: b.count,
          aspect: b.aspect,
          lensId: b.lensId,
          grounding: {
            sourceKind: b.sourceKind,
            sourcePostId: Number.isInteger(b.sourcePostId) ? b.sourcePostId : null,
            sourceTopicId: Number.isInteger(b.sourceTopicId) ? b.sourceTopicId : null
          },
          purpose: "studio_generate"
        },
        { budgetGate: makeBudgetGate() }
      );
      const image = rendered.images[0];
      const stored = await storeImage({
        image,
        provider: rendered.provider,
        model: rendered.model,
        prompt: b.prompt,
        sourceKind: b.sourceKind,
        sourcePostId: Number.isInteger(b.sourcePostId) ? b.sourcePostId : null,
        sourceTopicId: Number.isInteger(b.sourceTopicId) ? b.sourceTopicId : null,
        humanName: typeof b.humanName === "string" ? b.humanName : null,
        lensId: typeof b.lensId === "string" ? b.lensId : null,
        aspect: typeof b.aspect === "string" ? b.aspect : null,
        costEstimateUsd: rendered.costEstimateUsd,
        createdBy: req.user.sub
      });
      return { stored, usage: rendered.usage, costEstimateUsd: rendered.costEstimateUsd };
    });
    platformLog("info", "image_generated", { imageId: out.stored.id, backend: out.stored.storageBackend });
    return res.status(201).json({
      id: out.stored.id,
      mime: out.stored.mime,
      byteSize: out.stored.byteSize,
      storageBackend: out.stored.storageBackend,
      usage: out.usage,
      costEstimateUsd: out.costEstimateUsd
    });
  } catch (err) {
    platformLog("warn", "image_generate_failed", { code: err && err.code });
    return sendError(res, err);
  }
});

// GET /api/image-studio/:id/serve - stream the stored bytes. RLS
// scopes the read to the tenant, so a cross-tenant id is a 404.
router.get("/:id/serve", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid image id", code: "INVALID_INPUT" });
  try {
    const out = await withTenant(req.tenant.id, () => readImageBytes(id));
    const buf = Buffer.isBuffer(out.bytes) ? out.bytes : Buffer.from(out.bytes);
    res.set("Content-Type", out.mime || "application/octet-stream");
    res.set("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (err) {
    return sendError(res, err);
  }
});

// POST /api/image-studio/:id/attach - point a post at a stored
// image (posts.generated_image_id). Both the image and the post are
// tenant-scoped by RLS; a missing image is 404, a missing post is 404.
router.post("/:id/attach", requirePermission("edit_post"), async (req, res) => {
  const id = parseId(req.params.id);
  const postId = parseId((req.body || {}).postId);
  if (!id || !postId) return res.status(400).json({ error: "Invalid image or post id", code: "INVALID_INPUT" });
  try {
    const attached = await withTenant(req.tenant.id, async (client) => {
      await getImageMeta(id); // throws IMAGE_NOT_FOUND if not this tenant's
      const upd = await client.query("UPDATE posts SET generated_image_id = $1 WHERE id = $2 RETURNING id", [id, postId]);
      return upd.rows.length > 0;
    });
    if (!attached) return res.status(404).json({ error: "Post not found", code: "POST_NOT_FOUND" });
    platformLog("info", "image_attached", { imageId: id, postId });
    return res.status(200).json({ attached: true, imageId: id, postId });
  } catch (err) {
    return sendError(res, err);
  }
});

// POST /api/image-studio/brief - derive an image brief from a post
// (preview). Grounds in the post's content and the research
// (news_context) that produced it, through the text seam. Returns the
// brief text for the human to review or edit before spending on an
// image. Owner+editor.
router.post("/brief", requirePermission("preview_post"), async (req, res) => {
  const postId = parseId((req.body || {}).postId);
  if (!postId) return res.status(400).json({ error: "Invalid post id", code: "INVALID_INPUT" });
  try {
    const out = await withTenant(req.tenant.id, async () => {
      const post = await getPost(postId);
      if (!post) { const pe = new Error("Post not found"); pe.code = "POST_NOT_FOUND"; throw pe; }
      return deriveImageBrief({
        topic: post.topic_id,                 // topic slug/name for the brief
        postContent: post.content,
        research: post.news_context || "",    // the research that grounded the post
        sourceKind: "post",
        sourcePostId: postId,
        sourceTopicId: Number.isInteger(post.topic_num_id) ? post.topic_num_id : null
      });
    });
    return res.status(200).json({ brief: out.prompt, grounding: out.grounding, usage: out.usage });
  } catch (err) {
    platformLog("warn", "image_brief_failed", { code: err && err.code });
    return sendError(res, err);
  }
});

// POST /api/image-studio/generate-from-brief - lock a brief against
// verified metrics, then render and store. The grounding topic is
// resolved from the post authoritatively (not client-trusted), so the
// fidelity lock reads the right tenant metrics. A fabricated statistic
// is rejected here, BEFORE any spend, as a 422. Owner+editor.
router.post("/generate-from-brief", requirePermission("preview_post"), async (req, res) => {
  const b = req.body || {};
  const brief = typeof b.brief === "string" ? b.brief.trim() : "";
  const postId = parseId(b.postId);
  if (!brief) return res.status(400).json({ error: "A brief is required", code: "INVALID_INPUT" });
  try {
    const out = await withTenant(req.tenant.id, async () => {
      let topicRef = null;
      let sourcePostId = null;
      if (postId) {
        const post = await getPost(postId);
        if (!post) { const pe = new Error("Post not found"); pe.code = "POST_NOT_FOUND"; throw pe; }
        topicRef = Number.isInteger(post.topic_num_id) ? post.topic_num_id : null;
        sourcePostId = postId;
      }
      // FIDELITY LOCK: reject fabricated stats before spending on an image.
      const verdict = await lockBrief(brief, { topicRef });
      if (!verdict.ok) {
        throw imageError(IMAGE_ERROR_CODES.CONTENT_REJECTED,
          "Brief contains unverified numbers",
          { unverifiedNumbers: verdict.unverifiedNumbers, unknownTokens: verdict.unknownTokens });
      }
      const rendered = await render(
        {
          prompt: brief,
          size: b.size, quality: b.quality, count: b.count, aspect: b.aspect,
          grounding: { sourceKind: postId ? "post" : "brief", sourcePostId, sourceTopicId: topicRef },
          purpose: "generate_from_brief"
        },
        { budgetGate: makeBudgetGate() }
      );
      const image = rendered.images[0];
      const stored = await storeImage({
        image,
        provider: rendered.provider,
        model: rendered.model,
        prompt: brief,
        sourceKind: postId ? "post" : "brief",
        sourcePostId,
        sourceTopicId: topicRef,
        costEstimateUsd: rendered.costEstimateUsd,
        createdBy: req.user.sub
      });
      return { stored, usage: rendered.usage, costEstimateUsd: rendered.costEstimateUsd };
    });
    platformLog("info", "image_generated_from_brief", { imageId: out.stored.id, backend: out.stored.storageBackend });
    return res.status(201).json({
      id: out.stored.id,
      mime: out.stored.mime,
      byteSize: out.stored.byteSize,
      storageBackend: out.stored.storageBackend,
      usage: out.usage,
      costEstimateUsd: out.costEstimateUsd
    });
  } catch (err) {
    platformLog("warn", "image_generate_from_brief_failed", { code: err && err.code });
    return sendError(res, err);
  }
});

export default router;
