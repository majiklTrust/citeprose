// ═══════════════════════════════════════════════════════════════
// src/llm/adapters/anthropic.js - bespoke Anthropic adapter
// ═══════════════════════════════════════════════════════════════
// Pure translator between the canonical contract and the Anthropic
// Messages dialect. No network I/O lives here: the orchestrator
// owns fetch, behind the egress allowlist.
//
// Dialect facts this adapter encodes:
//   - auth is the x-api-key header plus the anthropic-version
//     header (both values arrive via ctx; never literals here)
//   - the system prompt is a separate top-level field
//   - the output cap's wire name comes from profile.tokenParam
//   - the reply is assembled from the content block array
//   - usage maps input_tokens/output_tokens; stop maps stop_reason
// ═══════════════════════════════════════════════════════════════

import { llmError, LLM_ERROR_CODES } from "../errors.js";
import { buildCanonicalResponse } from "../canonical.js";

function requireCallContext(canonReq, profile, ctx) {
  if (!canonReq || typeof canonReq !== "object" || typeof canonReq.user !== "string") {
    throw llmError(LLM_ERROR_CODES.INVALID_REQUEST, "Adapter needs a canonical request");
  }
  if (!profile || typeof profile !== "object" || typeof profile.tokenParam !== "string") {
    throw llmError(LLM_ERROR_CODES.INVALID_REQUEST, "Adapter needs a model profile");
  }
  if (!ctx || typeof ctx.apiKey !== "string" || ctx.apiKey.length === 0) {
    throw llmError(LLM_ERROR_CODES.INVALID_REQUEST, "Adapter needs an API key in the call context");
  }
  if (typeof ctx.baseUrl !== "string" || ctx.baseUrl.length === 0
    || typeof ctx.chatPath !== "string" || !ctx.chatPath.startsWith("/")) {
    throw llmError(LLM_ERROR_CODES.INVALID_REQUEST, "Adapter needs a base URL and chat path");
  }
}

export function buildWireRequest(canonReq, profile, ctx) {
  requireCallContext(canonReq, profile, ctx);

  const body = {
    model: profile.modelId,
    [profile.tokenParam]: canonReq.maxOutputTokens,
    messages: [{ role: "user", content: canonReq.user }]
  };
  if (typeof canonReq.system === "string" && profile.systemPlacement === "top_level") {
    body.system = canonReq.system;
  } else if (typeof canonReq.system === "string") {
    // Data-driven escape hatch: a profile may place system as a
    // leading role message even on this dialect.
    body.messages.unshift({ role: "system", content: canonReq.system });
  }
  if (canonReq.temperature !== null && profile.supportsTemperature) {
    body.temperature = canonReq.temperature;
  }
  if (Array.isArray(canonReq.stopSequences)) {
    body.stop_sequences = [...canonReq.stopSequences];
  }

  const headers = {
    "content-type": "application/json",
    "x-api-key": ctx.apiKey
  };
  if (typeof ctx.version === "string" && ctx.version.length > 0) {
    headers["anthropic-version"] = ctx.version;
  }

  return {
    method: "POST",
    url: ctx.baseUrl + ctx.chatPath,
    headers,
    body
  };
}

export function parseWireResponse(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.content)) {
    throw llmError(LLM_ERROR_CODES.BAD_RESPONSE, "Anthropic response has no content block array");
  }
  const textBlocks = raw.content.filter((b) => b && b.type === "text");
  if (textBlocks.length === 0) {
    throw llmError(LLM_ERROR_CODES.BAD_RESPONSE, "Anthropic response contains no text blocks");
  }
  if (!textBlocks.every((b) => typeof b.text === "string")) {
    throw llmError(LLM_ERROR_CODES.BAD_RESPONSE, "Anthropic text block carries non-string content");
  }
  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
  return buildCanonicalResponse({
    text: textBlocks.map((b) => b.text).join(""),
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: null,
    stopReason: raw.stop_reason
  });
}

// Plain-language report of the translations performed, for logs
// and diagnostics. Never includes prompt content or key material.
export function describeTranslations(canonReq, profile) {
  const notes = [];
  if (canonReq && typeof canonReq.system === "string") {
    notes.push(profile && profile.systemPlacement === "top_level"
      ? "system prompt sent as the separate top-level system field"
      : "system prompt sent as a leading system role message");
  } else {
    notes.push("no system prompt; system field omitted");
  }
  if (profile) {
    notes.push(`output cap sent as ${profile.tokenParam}`);
  }
  if (!canonReq || canonReq.temperature === null) {
    notes.push("temperature omitted (null means do not send)");
  } else if (profile && !profile.supportsTemperature) {
    notes.push("temperature dropped: this model does not accept it");
  } else {
    notes.push("temperature sent unchanged");
  }
  if (canonReq && Array.isArray(canonReq.stopSequences)) {
    notes.push("stop sequences sent as stop_sequences");
  }
  if (profile && Array.isArray(profile.silentlyIgnored) && profile.silentlyIgnored.length > 0) {
    notes.push(`vendor accepts but silently ignores: ${profile.silentlyIgnored.join(", ")}`);
  }
  notes.push("auth via x-api-key header plus the version header");
  return notes;
}
