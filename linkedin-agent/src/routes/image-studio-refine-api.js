// =================================================================
// src/routes/image-studio-refine-api.js - brief drafting + refine
// =================================================================
// Split from image-studio-api.js (2.5.66, the 600-line cap): the
// brief, generate-from-brief, and refine handlers, registered onto
// the SAME router by the main file, so index.js mounting is
// untouched (no new router, no four-place wiring). File-local
// helpers travel as an explicit ctx: the seam is visible.

import { requirePermission } from "../tenant/permissions.js";
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

export function registerBriefRefineRoutes(router, ctx) {
  const { sendError, parseId, toIntOrNull } = ctx;

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
          inputTokens: rendered.usage ? rendered.usage.inputTokens : null,
          outputTokens: rendered.usage ? rendered.usage.outputTokens : null,
          preSpendEstimateUsd: rendered.preSpendEstimateUsd,
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
    const { setRequestType } = await import("../spend/activation-context.js");
    setRequestType("image_refine");
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
          inputTokens: rendered.usage ? rendered.usage.inputTokens : null,
          outputTokens: rendered.usage ? rendered.usage.outputTokens : null,
          preSpendEstimateUsd: rendered.preSpendEstimateUsd,
          createdBy: req.user.sub
        });
        return { stored, usage: rendered.usage, costEstimateUsd: rendered.costEstimateUsd };
      });
      // 2.5.32 (finding 1): a refined image is a NEW row, and any post
      // still bound to the source will publish the OLD image. Say so,
      // and let the page offer the rebind. Never rebind silently.
      const attachedPosts = await withTenant(req.tenant.id, async (client) => {
        const r = await client.query(
          "SELECT id, title FROM posts WHERE generated_image_id = $1 ORDER BY id DESC LIMIT 5", [id]);
        return r.rows.map((row) => ({ id: toIntOrNull(row.id), title: row.title || null }));
      });
      platformLog("info", "image_refined", { fromImageId: id, imageId: out.stored.id, postsStillOnSource: attachedPosts.length });
      return res.status(201).json({
        attachedPosts,
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
}
