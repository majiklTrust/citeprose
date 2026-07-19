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
import { storeImage, readImageBytes, getImageMeta, listImages } from "../services/image-store.js";
import { deriveImageBrief } from "../image/image-brief.js";
import { lockBrief } from "../image/image-fidelity.js";
import { imageError, IMAGE_ERROR_CODES } from "../image/errors.js";
import { requireLens, applyLens, listLenses, LENSES } from "../image/image-lenses.js";
import { resolveAspectPreset, listAspectPresets } from "../image/registry.js";
import { getPost, getAgentState } from "../services/database.js";

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
    case "UNKNOWN_LENS":
    case "UNSUPPORTED_ASPECT":
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

// Coerce a DB-sourced id to a positive integer. pg returns BIGINT
// columns as STRINGS (pool.js sets no int8 parser), so a strict
// Number.isInteger test on a row value silently fails. Mirrors the
// number-or-digit-string handling of requireTopicRef in the metric
// store, the codebase's own idiom for exactly this.
function toIntOrNull(v) {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = parseInt(v.trim(), 10);
    return n > 0 ? n : null;
  }
  return null;
}

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

// GET /api/image-studio/lenses - the Story Lens and aspect-preset
// catalog for pickers. Read-only data; survives a suspended
// (read-only) subscription like /budget does.
router.get("/lenses", (req, res) => {
  return res.status(200).json({ lenses: listLenses(), aspects: listAspectPresets() });
});

// GET /api/image-studio/library - the tenant-shared library: stored
// images, newest first, metadata only (bytes stream via /serve). RLS
// scopes rows to the tenant; the store clamps limit and offset, so
// hostile paging values shape the page, never the load. Read-only,
// so it survives a suspended subscription like /budget and /lenses.
router.get("/library", async (req, res) => {
  try {
    const images = await withTenant(req.tenant.id, () =>
      listImages({ limit: req.query.limit, offset: req.query.offset }));
    return res.status(200).json({ images });
  } catch (err) {
    platformLog("warn", "image_library_failed", { code: err && err.code });
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
    // Lens and aspect validate fail-closed BEFORE any tenant work or
    // spend: a typo is a 400, never a silent unstyled render.
    const lens = b.lensId != null ? requireLens(b.lensId) : null;
    const preset = b.aspect != null ? resolveAspectPreset(b.aspect) : null;
    const out = await withTenant(req.tenant.id, async () => {
      const palette = await getAgentState("image_brand_palette");
      const composed = applyLens(b.prompt, {
        lens,
        palette,
        aspectGuidance: preset ? preset.guidance : null,
        negativePrompt: b.negativePrompt
      });
      const rendered = await render(
        {
          prompt: composed.prompt,
          negativePrompt: composed.negativePrompt,
          size: b.size || (preset ? preset.size : undefined), // explicit size wins over the preset
          quality: b.quality,
          count: b.count,
          aspect: preset ? preset.id : null,
          lensId: composed.lensId,
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
        prompt: composed.prompt,
        sourceKind: b.sourceKind,
        sourcePostId: Number.isInteger(b.sourcePostId) ? b.sourcePostId : null,
        sourceTopicId: Number.isInteger(b.sourceTopicId) ? b.sourceTopicId : null,
        humanName: typeof b.humanName === "string" ? b.humanName : null,
        lensId: composed.lensId,
        aspect: preset ? preset.id : null,
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
      if (!post) throw imageError(IMAGE_ERROR_CODES.POST_NOT_FOUND, "Post not found");
      return deriveImageBrief({
        topic: post.topic_id,                 // topic slug/name for the brief
        postContent: post.content,
        research: post.news_context || "",    // the research that grounded the post
        sourceKind: "post",
        sourcePostId: postId,
        sourceTopicId: toIntOrNull(post.topic_num_id)
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
    // Lens and aspect validate fail-closed before any tenant work.
    const lens = b.lensId != null ? requireLens(b.lensId) : null;
    const preset = b.aspect != null ? resolveAspectPreset(b.aspect) : null;
    const out = await withTenant(req.tenant.id, async () => {
      let topicRef = null;
      let sourcePostId = null;
      if (postId) {
        const post = await getPost(postId);
        if (!post) throw imageError(IMAGE_ERROR_CODES.POST_NOT_FOUND, "Post not found");
        topicRef = toIntOrNull(post.topic_num_id);
        sourcePostId = postId;
      }
      // FIDELITY LOCK: reject fabricated stats before spending on an
      // image. The lock checks the RAW brief; lens composition runs
      // AFTER it, and lens data is digit-free by rule, so styling can
      // never introduce an unverified number past the lock.
      const verdict = await lockBrief(brief, { topicRef });
      if (!verdict.ok) {
        throw imageError(IMAGE_ERROR_CODES.CONTENT_REJECTED,
          "Brief contains unverified numbers or metric tokens",
          { unverifiedNumbers: verdict.unverifiedNumbers, unknownTokens: verdict.unknownTokens, metricTokens: verdict.metricTokens });
      }
      const palette = await getAgentState("image_brand_palette");
      const composed = applyLens(brief, {
        lens,
        palette,
        aspectGuidance: preset ? preset.guidance : null
      });
      const rendered = await render(
        {
          prompt: composed.prompt,
          negativePrompt: composed.negativePrompt,
          size: b.size || (preset ? preset.size : undefined), // explicit size wins over the preset
          quality: b.quality, count: b.count,
          aspect: preset ? preset.id : null,
          lensId: composed.lensId,
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
        brief,                       // the human-approved text, as approved
        prompt: composed.prompt,     // the final styled prompt actually rendered
        sourceKind: postId ? "post" : "brief",
        sourcePostId,
        sourceTopicId: topicRef,
        lensId: composed.lensId,
        aspect: preset ? preset.id : null,
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

// POST /api/image-studio/:id/refine - refine-by-conversation. Takes a
// stored image and a plain-language instruction ("warmer light, less
// clutter") and renders a NEW image (a new budget-gated spend); the
// original is untouched, so refinement is iteration, not mutation.
//
// Lock semantics, precise by design: every piece of HUMAN text is
// fidelity-locked exactly once, and system-composed styling is never
// re-locked. If the image has a stored brief, the lock checks
// brief + instruction together and the stored lens re-applies to that
// combined text. If only a styled prompt exists (raw-prompt images),
// the lock checks the NEW instruction alone, because the styled
// prompt already carries owner palette text whose color codes could
// false-reject a re-lock, and the instruction appends to the prompt
// without re-styling (the styling is already baked in).
//
// Stored lens and aspect are PROVENANCE, not user input, so unknown
// values (older rows) degrade tolerantly to null with a log instead
// of failing the refine the user asked for.
const REFINE_MAX_CHARS = 500;
router.post("/:id/refine", requirePermission("preview_post"), async (req, res) => {
  const id = parseId(req.params.id);
  const instruction = typeof (req.body || {}).instruction === "string" ? req.body.instruction.trim() : "";
  if (!id) return res.status(400).json({ error: "Invalid image id", code: "INVALID_INPUT" });
  if (!instruction || instruction.length > REFINE_MAX_CHARS) {
    return res.status(400).json({ error: `A refinement instruction of 1 to ${REFINE_MAX_CHARS} characters is required`, code: "INVALID_INPUT" });
  }
  try {
    const out = await withTenant(req.tenant.id, async () => {
      const meta = await getImageMeta(id); // throws IMAGE_NOT_FOUND (404) if not this tenant's
      const topicRef = toIntOrNull(meta.source_topic_id);

      let lens = null;
      if (meta.lens_id) {
        lens = LENSES.find((l) => l.id === meta.lens_id) || null;
        if (!lens) platformLog("warn", "image_refine_unknown_lens", { imageId: id, lensId: meta.lens_id });
      }
      let preset = null;
      if (meta.aspect) {
        try { preset = resolveAspectPreset(meta.aspect); }
        catch { platformLog("warn", "image_refine_unknown_aspect", { imageId: id, aspect: meta.aspect }); }
      }

      let finalPrompt;
      let negativePrompt = null;
      let newBrief = null;
      let lensId = meta.lens_id || null;
      if (typeof meta.brief === "string" && meta.brief.trim() !== "") {
        const combined = `${meta.brief.trim()} Refinement: ${instruction}`;
        const verdict = await lockBrief(combined, { topicRef });        // human text, locked once
        if (!verdict.ok) {
          throw imageError(IMAGE_ERROR_CODES.CONTENT_REJECTED,
            "Refined brief contains unverified numbers or metric tokens",
            { unverifiedNumbers: verdict.unverifiedNumbers, unknownTokens: verdict.unknownTokens, metricTokens: verdict.metricTokens });
        }
        const palette = await getAgentState("image_brand_palette");
        const composed = applyLens(combined, { lens, palette, aspectGuidance: preset ? preset.guidance : null });
        finalPrompt = composed.prompt;
        negativePrompt = composed.negativePrompt;
        newBrief = combined;
        lensId = composed.lensId || lensId;
      } else {
        const verdict = await lockBrief(instruction, { topicRef });     // only the NEW human text
        if (!verdict.ok) {
          throw imageError(IMAGE_ERROR_CODES.CONTENT_REJECTED,
            "Refinement contains unverified numbers or metric tokens",
            { unverifiedNumbers: verdict.unverifiedNumbers, unknownTokens: verdict.unknownTokens, metricTokens: verdict.metricTokens });
        }
        finalPrompt = `${meta.prompt} Refinement: ${instruction}`;      // styling already baked in; no re-style
      }

      const rendered = await render(
        {
          prompt: finalPrompt,
          negativePrompt,
          size: preset ? preset.size : undefined,
          aspect: preset ? preset.id : null,
          lensId,
          grounding: {
            sourceKind: meta.source_kind,
            sourcePostId: toIntOrNull(meta.source_post_id),
            sourceTopicId: topicRef
          },
          purpose: "image_refine"
        },
        { budgetGate: makeBudgetGate() }
      );
      const image = rendered.images[0];
      const stored = await storeImage({
        image,
        provider: rendered.provider,
        model: rendered.model,
        brief: newBrief,
        prompt: finalPrompt,
        sourceKind: meta.source_kind,
        sourcePostId: toIntOrNull(meta.source_post_id),
        sourceTopicId: topicRef,
        humanName: meta.human_name || null,
        lensId,
        aspect: preset ? preset.id : (meta.aspect || null),
        costEstimateUsd: rendered.costEstimateUsd,
        createdBy: req.user.sub
      });
      return { stored, usage: rendered.usage, costEstimateUsd: rendered.costEstimateUsd };
    });
    platformLog("info", "image_refined", { fromImageId: id, imageId: out.stored.id });
    return res.status(201).json({
      id: out.stored.id,
      mime: out.stored.mime,
      byteSize: out.stored.byteSize,
      storageBackend: out.stored.storageBackend,
      usage: out.usage,
      costEstimateUsd: out.costEstimateUsd
    });
  } catch (err) {
    platformLog("warn", "image_refine_failed", { code: err && err.code });
    return sendError(res, err);
  }
});

export default router;
