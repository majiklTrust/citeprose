// ═══════════════════════════════════════════════════════════════
// src/image/adapters/openai-images.js - OpenAI images translator
// ═══════════════════════════════════════════════════════════════
// Pure translator between the RenderProperties contract and the
// OpenAI /v1/images/generations dialect. No network I/O lives here:
// the orchestrator owns fetch, behind the egress allowlist.
//
// Dialect facts this adapter encodes (pinned against OpenAI's
// reference for the gpt-image family):
//   - auth is a Bearer authorization header (value arrives via ctx)
//   - request carries model, prompt, n, size, quality, output_format
//   - gpt-image models ALWAYS return b64_json and REJECT a
//     response_format field, so we never send one
//   - OpenAI images have no negative-prompt field; when the profile
//     says "fold", the negative prompt is appended to the prompt so
//     the intent is not silently lost
//   - the reply is data[].b64_json; usage maps input/output/total
// ═══════════════════════════════════════════════════════════════

import { imageError, IMAGE_ERROR_CODES } from "../errors.js";
import { buildRenderResponse } from "../canonical.js";

const MIME_BY_FORMAT = Object.freeze({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" });

function requireCallContext(renderReq, profile, ctx) {
  if (!renderReq || typeof renderReq !== "object" || typeof renderReq.prompt !== "string") {
    throw imageError(IMAGE_ERROR_CODES.INVALID_REQUEST, "Adapter needs a render request");
  }
  if (!profile || typeof profile !== "object" || typeof profile.modelId !== "string") {
    throw imageError(IMAGE_ERROR_CODES.INVALID_REQUEST, "Adapter needs a model profile");
  }
  if (!ctx || typeof ctx.apiKey !== "string" || ctx.apiKey.length === 0) {
    throw imageError(IMAGE_ERROR_CODES.INVALID_REQUEST, "Adapter needs an API key in the call context");
  }
  if (typeof ctx.baseUrl !== "string" || ctx.baseUrl.length === 0
    || typeof ctx.imagePath !== "string" || !ctx.imagePath.startsWith("/")) {
    throw imageError(IMAGE_ERROR_CODES.INVALID_REQUEST, "Adapter needs a base URL and image path");
  }
  if (!ctx.shape || typeof ctx.shape !== "object") {
    throw imageError(IMAGE_ERROR_CODES.INVALID_REQUEST, "Adapter needs a resolved render shape");
  }
}

function widthHeightFromSize(size) {
  if (typeof size === "string" && /^[0-9]+x[0-9]+$/.test(size)) {
    const [w, h] = size.split("x").map((v) => parseInt(v, 10));
    return { width: w, height: h };
  }
  return { width: null, height: null };  // "auto" and unknowns
}

export function buildWireRequest(renderReq, profile, ctx) {
  requireCallContext(renderReq, profile, ctx);
  const { size, quality, outputFormat } = ctx.shape;

  // Fold the negative prompt into the prompt when the profile says
  // so; OpenAI images accept no dedicated negative field.
  let prompt = renderReq.prompt;
  if (renderReq.negativePrompt && profile.negativePrompt === "fold") {
    prompt = `${prompt}\n\nAvoid the following in the image: ${renderReq.negativePrompt}`;
  }

  const body = {
    model: profile.modelId,
    prompt,
    n: renderReq.count,
    size,
    quality,
    output_format: outputFormat
  };
  // Deliberately NO response_format: gpt-image models reject it and
  // always return base64. Sending it is a 400.

  return {
    method: "POST",
    url: ctx.baseUrl + ctx.imagePath,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.apiKey}`
    },
    body,
    // Resolved facts the parser needs to shape the canonical images.
    resolved: {
      mime: MIME_BY_FORMAT[outputFormat] || "image/png",
      ...widthHeightFromSize(size)
    }
  };
}

export function parseWireResponse(raw, resolved) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.data) || raw.data.length === 0) {
    throw imageError(IMAGE_ERROR_CODES.BAD_RESPONSE, "OpenAI images response has no data array");
  }
  const mime = resolved && typeof resolved.mime === "string" ? resolved.mime : "image/png";
  const width = resolved && Number.isInteger(resolved.width) ? resolved.width : null;
  const height = resolved && Number.isInteger(resolved.height) ? resolved.height : null;

  const images = raw.data.map((d) => {
    if (!d || typeof d !== "object" || typeof d.b64_json !== "string" || d.b64_json.length === 0) {
      throw imageError(IMAGE_ERROR_CODES.BAD_RESPONSE, "OpenAI image item carries no base64 content");
    }
    return { b64: d.b64_json, mime, width, height };
  });

  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
  return buildRenderResponse({
    images,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    // Three-category cost split (text vs image input), when the
    // vendor reports it. Absent details degrade to the aggregate.
    inputTextTokens: usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? usage.input_tokens_details.text_tokens : undefined,
    inputImageTokens: usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? usage.input_tokens_details.image_tokens : undefined
  });
}

// Plain-language report of the translations performed, for logs and
// diagnostics. Never includes prompt content or key material.
export function describeTranslations(renderReq, profile) {
  const notes = [];
  notes.push("auth via Bearer authorization header");
  if (renderReq && renderReq.negativePrompt) {
    notes.push(profile && profile.negativePrompt === "fold"
      ? "negative prompt folded into the prompt text (vendor has no negative field)"
      : "negative prompt dropped: this model does not accept one");
  }
  notes.push("response_format omitted: gpt-image models always return base64 and reject the field");
  if (renderReq) notes.push(`requested ${renderReq.count} image(s)`);
  return notes;
}
