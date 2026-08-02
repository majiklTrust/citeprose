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
import { resolveAspectPreset, listAspectPresets, getImageModelProfile } from "../image/registry.js";
import { getPost, getAgentState } from "../services/database.js";
import { annotateActivation } from "../spend/activation-middleware.js";
import { registerBriefRefineRoutes } from "./image-studio-refine-api.js";

const router = Router();
router.use(annotateActivation("image_studio"));
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
    case "PRICING_UNAVAILABLE":
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
    const status = await withTenant(req.tenant.id, async () => {
      const base = await getBudgetStatus();
      // Provider-onboarding honesty (Phase 5): the page can tell the
      // person WHY generation is not ready instead of failing later.
      // Cheap reads; never throws the probe.
      let provisioned = false;
      let keyed = false;
      let provider = null;
      let model = null;
      try {
        const rawProvider = await getAgentState("image_provider");
        provisioned = typeof rawProvider === "string" && rawProvider.trim() !== "";
        if (provisioned) {
          provider = rawProvider.trim();
          const rawModel = await getAgentState("image_model");
          model = typeof rawModel === "string" && rawModel.trim() !== "" ? rawModel.trim() : null;
          const { hasLlmApiKey } = await import("../tenant/credential-store.js");
          keyed = await hasLlmApiKey(provider);
        }
      } catch { /* readiness stays false; the render gates enforce regardless */ }
      return { ...base, provisioned, keyed, provider, model };
    });
    return res.status(200).json(status);
  } catch (err) {
    platformLog("warn", "image_budget_status_failed", { code: err && err.code });
    return sendError(res, err);
  }
});

// GET /api/image-studio/lenses - the Story Lens and aspect-preset
// catalog for pickers. Read-only data; survives a suspended
// (read-only) subscription like /budget does.
router.get("/lenses", async (req, res) => {
  // 2.5.39: the catalog also answers what size the Default chip
  // means: the TENANT's configured model's defaultSize, resolved
  // through the registry, never a client constant. Unprovisioned
  // workspaces answer null and the page shows no size for Default.
  let defaultSize = null;
  try {
    defaultSize = await withTenant(req.tenant.id, async () => {
      const provider = await getAgentState("image_provider");
      const model = await getAgentState("image_model");
      if (typeof provider !== "string" || provider.trim() === "") return null;
      const profile = getImageModelProfile(provider.trim(),
        (typeof model === "string" && model.trim() !== "") ? model.trim() : undefined, process.env);
      return profile.defaultSize || null;
    });
  } catch { /* readiness surfaces elsewhere; the catalog stays serving */ }
  return res.status(200).json({ lenses: listLenses(), aspects: listAspectPresets(), defaultSize });
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
    const VALID_SOURCE_KINDS = new Set(["post", "topic", "blank", "brief"]);
    if (b.sourceKind != null && !VALID_SOURCE_KINDS.has(b.sourceKind)) {
      return res.status(400).json({ error: "Unknown sourceKind", code: "INVALID_INPUT" });
    }
    const lens = b.lensId != null ? requireLens(b.lensId) : null;
    const preset = b.aspect != null ? resolveAspectPreset(b.aspect) : null;
    const out = await withTenant(req.tenant.id, async () => {
      // Grounding provenance, bigint-safe and fail-closed (2.5.21):
      // pg serializes BIGINT ids as strings, so strict integer checks
      // silently dropped the panel's post id and shipped source_kind
      // 'post' with a null id. toIntOrNull coerces; a post-kind
      // request without a resolvable, tenant-visible post refuses
      // BEFORE any spend.
      let sourcePostId = toIntOrNull(b.sourcePostId);
      let sourceTopicId = toIntOrNull(b.sourceTopicId);
      if (b.sourceKind === "post") {
        if (!sourcePostId) {
          throw imageError(IMAGE_ERROR_CODES.INVALID_INPUT, "sourceKind post requires a valid sourcePostId");
        }
        const post = await getPost(sourcePostId);   // RLS: not this tenant's means not found
        if (!post) {
          throw imageError(IMAGE_ERROR_CODES.POST_NOT_FOUND, "Source post not found in this workspace", { sourcePostId });
        }
        if (sourceTopicId === null) sourceTopicId = toIntOrNull(post.topic_num_id);
      }

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
            sourcePostId,
            sourceTopicId
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
        // The operator's pristine entry (2.5.31): what the person
        // TYPED, before any lens or palette composition, persists as
        // the image's brief and captions it everywhere it appears.
        brief: typeof b.prompt === "string" ? b.prompt.trim() : null,
        sourceKind: b.sourceKind,
        sourcePostId,
        sourceTopicId,
        humanName: typeof b.humanName === "string" ? b.humanName : null,
        lensId: composed.lensId,
        aspect: preset ? preset.id : null,
        costEstimateUsd: rendered.costEstimateUsd,
        inputTokens: rendered.usage ? rendered.usage.inputTokens : null,
        outputTokens: rendered.usage ? rendered.usage.outputTokens : null,
        preSpendEstimateUsd: rendered.preSpendEstimateUsd,
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
// GET /api/image-studio/:id/meta - provenance and cost for one image
// (Phase 5 surfacing). Everything here is the tenant's own record:
// where the image came from (post, brief, topic, blank), the lens and
// shape that styled it, the vendor and model that rendered it, the
// human-approved brief, and the money: the pre-spend the budget gate
// charged, the reconciled actual cost, and the token usage behind it.
router.get("/:id/meta", async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid image id", code: "INVALID_INPUT" });
  try {
    const meta = await withTenant(req.tenant.id, () => getImageMeta(id));
    return res.status(200).json({
      id: meta.id,
      sourceKind: meta.source_kind,
      sourcePostId: meta.source_post_id,
      sourceTopicId: meta.source_topic_id,
      humanName: meta.human_name,
      brief: meta.brief,
      lensId: meta.lens_id,
      aspect: meta.aspect,
      provider: meta.provider,
      model: meta.model,
      mime: meta.mime,
      byteSize: meta.byte_size,
      storageBackend: meta.storage_backend,
      verifiedMetricRef: meta.verified_metric_ref,
      costEstimateUsd: meta.cost_estimate_usd,
      preSpendEstimateUsd: meta.pre_spend_estimate_usd,
      inputTokens: meta.input_tokens,
      outputTokens: meta.output_tokens,
      createdBy: meta.created_by,
      createdAt: meta.created_at
    });
  } catch (err) {
    return sendError(res, err);
  }
});

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
    const outcome = await withTenant(req.tenant.id, async (client) => {
      const meta = await getImageMeta(id); // throws IMAGE_NOT_FOUND if not this tenant's
      // 2.5.32: only a servable image may bind to a post. Anything
      // else would pass attach and fail days later at publish time.
      if (meta.status !== "stored") {
        throw imageError(IMAGE_ERROR_CODES.INVALID_INPUT, "The image is not in a publishable state", { imageId: id, status: meta.status });
      }
      // Capture the prior binding BEFORE the update so a replacement
      // is visible, never silent (finding 3).
      const prevQ = await client.query("SELECT generated_image_id FROM posts WHERE id = $1", [postId]);
      if (prevQ.rows.length === 0) return { found: false };
      const previousImageId = toIntOrNull(prevQ.rows[0].generated_image_id);
      await client.query("UPDATE posts SET generated_image_id = $1 WHERE id = $2", [id, postId]);
      return { found: true, previousImageId };
    });
    if (!outcome.found) return res.status(404).json({ error: "Post not found", code: "POST_NOT_FOUND" });
    const replaced = outcome.previousImageId !== null && outcome.previousImageId !== id;
    platformLog("info", "image_attached", { imageId: id, postId, previousImageId: outcome.previousImageId });
    return res.status(200).json({ attached: true, imageId: id, postId, previousImageId: outcome.previousImageId, replaced });
  } catch (err) {
    return sendError(res, err);
  }
});

// POST /api/image-studio/detach { postId }: remove the post's AI
// attachment so the URL choices become the publish truth again.
// The inverse of attach, equally visible: previous id in response
// and log, caches taught through the same client callback.
router.post("/detach", async (req, res) => {
  const postId = parseId((req.body || {}).postId);
  if (!postId) return res.status(400).json({ error: "Invalid postId", code: "INVALID_INPUT" });
  try {
    const outcome = await withTenant(req.tenant.id, async (client) => {
      const prevQ = await client.query("SELECT generated_image_id FROM posts WHERE id = $1", [postId]);
      if (prevQ.rows.length === 0) return { found: false };
      const previousImageId = toIntOrNull(prevQ.rows[0].generated_image_id);
      await client.query("UPDATE posts SET generated_image_id = NULL WHERE id = $1", [postId]);
      return { found: true, previousImageId };
    });
    if (!outcome.found) return res.status(404).json({ error: "Post not found", code: "POST_NOT_FOUND" });
    platformLog("info", "image_detached", { postId, previousImageId: outcome.previousImageId });
    return res.status(200).json({ detached: true, postId, previousImageId: outcome.previousImageId });
  } catch (err) {
    return sendError(res, err);
  }
});

// Brief drafting and refine live in their own module (2.5.66),
// registered SYNCHRONOUSLY so no request can beat the routes to
// the router at boot.
registerBriefRefineRoutes(router, { sendError, parseId, toIntOrNull });

export default router;
