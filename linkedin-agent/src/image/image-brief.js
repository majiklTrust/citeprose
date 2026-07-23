// ═══════════════════════════════════════════════════════════════
// src/image/image-brief.js - Phase 2 grounding: research -> brief
// ═══════════════════════════════════════════════════════════════
// Derives an image BRIEF from a post's research and context through
// the TEXT seam (generateWithTenantLlm), producing a grounded prompt
// for the Phase 1 IMAGE seam. deriveImageBrief() returns { prompt };
// that prompt is fed straight into render() as RenderProperties.prompt
// by the later generate-from-brief step. This module is the bridge
// from Phase 2 (grounding, text) to Phase 1 (render, image).
//
// SECURITY: every untrusted field (the post body, the research) is
// wrapped by the shared untrusted-content framing before it reaches
// the model, so instructions embedded in ingested research cannot
// escape into the model's instruction space and steer the image.
// This is the Phase 2 adversarial guarantee.
//
// All heavy dependencies (vault, framing, text seam) are lazy-imported
// so this module is importable without a database, and injectable via
// deps so the pure assembly is unit-testable. Mirrors the
// getPrompt -> frame -> renderPrompt -> generateWithTenantLlm flow
// that content-generator.js uses for post text.
// ═══════════════════════════════════════════════════════════════

import { imageError, IMAGE_ERROR_CODES } from "./errors.js";
import { platformLog } from "../services/platform-log.js";

const BRIEF_PROMPT_KEY = "image_brief";
const BRIEF_MAX_TOKENS = 600;      // a brief is a short visual description
const BRIEF_TEMPERATURE = 0.7;

function toText(v) {
  if (typeof v === "string") return v;
  return v == null ? "" : String(v);
}

// Default dependency resolvers. Each is lazy so a static import of this
// module never pulls the pg pool (prompt-vault imports it); each is
// overridable via deps so the assembly can be tested without a DB.
function resolveDeps(deps) {
  return {
    getTemplate: deps.getTemplate ||
      (async (key) => (await import("../services/prompt-vault.js")).getPrompt(key)),
    renderTemplate: deps.renderTemplate ||
      (async (tpl, vars) => (await import("../services/prompt-vault.js")).renderPrompt(tpl, vars)),
    frame: deps.frame ||
      (async (content) => (await import("../services/prompt-framing.js")).frameUntrustedContent(content)),
    generate: deps.generate ||
      (async (input) => (await import("../llm/client.js")).generateWithTenantLlm(input))
  };
}

// input: { topic, angle, postContent, research, humanName,
//          sourceKind, sourcePostId, sourceTopicId }
// Returns a frozen { prompt, usage, grounding }.
export async function deriveImageBrief(input = {}, deps = {}) {
  const d = resolveDeps(deps);

  const template = await d.getTemplate(BRIEF_PROMPT_KEY);
  if (typeof template !== "string" || template.trim() === "") {
    throw imageError(IMAGE_ERROR_CODES.NOT_PROVISIONED,
      "image_brief prompt template is not seeded", { key: BRIEF_PROMPT_KEY });
  }

  // Frame the untrusted inputs BEFORE they enter the template, so any
  // embedded instructions are contained as quoted data, not commands.
  const safePost = await d.frame(toText(input.postContent));
  const safeResearch = await d.frame(toText(input.research));

  const user = await d.renderTemplate(template, {
    TOPIC: toText(input.topic),
    ANGLE: toText(input.angle),
    POST: safePost,
    RESEARCH: safeResearch,
    HUMAN_NAME: toText(input.humanName)
  });

  const out = await d.generate({
    system: null,
    user,
    maxOutputTokens: BRIEF_MAX_TOKENS,
    temperature: BRIEF_TEMPERATURE,
    purpose: "image_brief"
  });

  const prompt = out && typeof out.text === "string" ? out.text.trim() : "";
  if (!prompt) {
    throw imageError(IMAGE_ERROR_CODES.BAD_RESPONSE, "empty image brief from the text seam");
  }

  platformLog("info", "image_brief_derived", { chars: prompt.length });

  return Object.freeze({
    prompt,                                   // feeds render() RenderProperties.prompt
    usage: (out && out.usage) || null,
    grounding: Object.freeze({
      sourceKind: input.sourceKind || null,
      sourcePostId: Number.isInteger(input.sourcePostId) ? input.sourcePostId : null,
      sourceTopicId: Number.isInteger(input.sourceTopicId) ? input.sourceTopicId : null
    })
  });
}
