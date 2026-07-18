// ═══════════════════════════════════════════════════════════════
// src/image/canonical.js - the RenderProperties contract
// ═══════════════════════════════════════════════════════════════
// The internal shapes the whole image pipeline speaks. The adapter
// builds a wire request FROM a RenderProperties request and parses
// a raw vendor response INTO a canonical response; nothing outside
// src/image ever sees a vendor payload.
//
// RenderProperties (canonical request):
//   { prompt, negativePrompt, size, quality, count, outputFormat,
//     aspect, lensId, seed, modelRef, grounding }
//   - prompt is required, non-empty
//   - count is clamped to the server-side cap
//   - size/quality are validated for SHAPE here; membership in the
//     selected model's supported set is checked by the registry
//     (fail closed there), keeping this module provider-agnostic
//   - grounding is provenance only (never sent to the vendor)
//
// Canonical response:
//   { images: [ { b64, mime, width, height } ],
//     usage: { inputTokens, outputTokens, totalTokens } }
//
// This module validates SHAPE and never performs I/O.
// ═══════════════════════════════════════════════════════════════

import { imageError, IMAGE_ERROR_CODES } from "./errors.js";

const MAX_PROMPT_CHARS = 32000;

function invalid(message, details) {
  return imageError(IMAGE_ERROR_CODES.INVALID_REQUEST, message, details);
}

export function buildRenderRequest(input, opts) {
  if (!input || typeof input !== "object") {
    throw invalid("RenderProperties input must be an object");
  }
  const cap = opts && opts.maxCountCap;
  if (!Number.isInteger(cap) || cap <= 0) {
    throw invalid("Max count cap must be a positive integer");
  }

  const {
    prompt, negativePrompt, size, quality, count, outputFormat,
    aspect, lensId, seed, modelRef, grounding
  } = input;

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw invalid("RenderProperties requires a non-empty prompt");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw invalid("RenderProperties prompt exceeds the maximum length");
  }
  if (negativePrompt !== undefined && negativePrompt !== null && typeof negativePrompt !== "string") {
    throw invalid("negativePrompt must be a string when present");
  }
  if (size !== undefined && size !== null && typeof size !== "string") {
    throw invalid("size must be a string when present");
  }
  if (quality !== undefined && quality !== null && typeof quality !== "string") {
    throw invalid("quality must be a string when present");
  }
  if (outputFormat !== undefined && outputFormat !== null && typeof outputFormat !== "string") {
    throw invalid("outputFormat must be a string when present");
  }
  let n = 1;
  if (count !== undefined && count !== null) {
    if (!Number.isInteger(count) || count <= 0) {
      throw invalid("count must be a positive integer");
    }
    n = count;
  }
  if (!modelRef || typeof modelRef !== "object"
    || typeof modelRef.provider !== "string" || modelRef.provider.length === 0
    || typeof modelRef.model !== "string" || modelRef.model.length === 0) {
    throw invalid("modelRef must name a registry provider and model");
  }

  // Grounding is provenance the pipeline records; it is NEVER sent
  // to the vendor. Normalize to a frozen, log-safe shape.
  const g = grounding && typeof grounding === "object" ? grounding : {};
  const groundingOut = Object.freeze({
    sourceKind: typeof g.sourceKind === "string" ? g.sourceKind : "blank",
    sourcePostId: Number.isInteger(g.sourcePostId) ? g.sourcePostId : null,
    sourceTopicId: Number.isInteger(g.sourceTopicId) ? g.sourceTopicId : null,
    verifiedMetricRef: typeof g.verifiedMetricRef === "string" ? g.verifiedMetricRef : null
  });

  return Object.freeze({
    prompt: prompt.trim(),
    negativePrompt: (negativePrompt === undefined || negativePrompt === null || negativePrompt.trim().length === 0)
      ? null : negativePrompt.trim(),
    size: (size === undefined || size === null) ? null : size,
    quality: (quality === undefined || quality === null) ? null : quality,
    outputFormat: (outputFormat === undefined || outputFormat === null) ? null : outputFormat,
    // Billing guardrail: the cap always wins.
    count: Math.min(n, cap),
    aspect: typeof aspect === "string" ? aspect : null,
    lensId: typeof lensId === "string" ? lensId : null,
    seed: typeof seed === "string" ? seed : null,
    modelRef: Object.freeze({ provider: modelRef.provider, model: modelRef.model }),
    grounding: groundingOut
  });
}

function toTokenCount(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return null;
}

export function buildRenderResponse(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.images) || input.images.length === 0) {
    throw imageError(IMAGE_ERROR_CODES.BAD_RESPONSE, "Canonical response requires at least one image");
  }
  const images = input.images.map((im) => {
    if (!im || typeof im !== "object" || typeof im.b64 !== "string" || im.b64.length === 0) {
      throw imageError(IMAGE_ERROR_CODES.BAD_RESPONSE, "Each canonical image requires base64 content");
    }
    return Object.freeze({
      b64: im.b64,
      mime: typeof im.mime === "string" && im.mime.length > 0 ? im.mime : "image/png",
      width: Number.isInteger(im.width) ? im.width : null,
      height: Number.isInteger(im.height) ? im.height : null
    });
  });
  const inputTokens = toTokenCount(input.inputTokens);
  const outputTokens = toTokenCount(input.outputTokens);
  let totalTokens = toTokenCount(input.totalTokens);
  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens;
  }
  return Object.freeze({
    images: Object.freeze(images),
    usage: Object.freeze({ inputTokens, outputTokens, totalTokens })
  });
}

// Log-safe summary of a render request: identifiers and sizes
// only, never the prompt, negative prompt, or grounding content.
export function describeRenderRequest(req) {
  if (!req || typeof req !== "object") {
    return { provider: null, model: null, promptChars: 0, count: 0, size: null, quality: null, lensId: null };
  }
  return {
    provider: req.modelRef ? req.modelRef.provider : null,
    model: req.modelRef ? req.modelRef.model : null,
    promptChars: typeof req.prompt === "string" ? req.prompt.length : 0,
    negativeChars: typeof req.negativePrompt === "string" ? req.negativePrompt.length : 0,
    count: req.count ?? null,
    size: req.size ?? null,
    quality: req.quality ?? null,
    lensId: req.lensId ?? null,
    sourceKind: req.grounding ? req.grounding.sourceKind : null
  };
}
