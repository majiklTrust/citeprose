// ═══════════════════════════════════════════════════════════════
// src/llm/adapters/openai-compatible.js - parameterized adapter
// ═══════════════════════════════════════════════════════════════
// ONE adapter for every endpoint speaking the Chat Completions
// shape: OpenAI, Grok (xAI), and any custom OpenAI-compatible
// endpoint. All vendor variation arrives through the provider
// entry and the model capability profile; nothing here branches
// on a vendor name.
//
// Dialect facts this adapter encodes:
//   - auth is a Bearer authorization header
//   - the system prompt is a leading system role message
//   - the output cap's wire name comes from profile.tokenParam
//     (it varies by model family)
//   - temperature is dropped when the profile says the model
//     rejects it; reasoning effort is sent when the profile
//     carries a default
//   - the reply is the first choice's message content
//   - usage maps prompt/completion/total; stop maps finish_reason
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

  const messages = [];
  if (typeof canonReq.system === "string" && profile.systemPlacement === "role") {
    messages.push({ role: "system", content: canonReq.system });
  }
  messages.push({ role: "user", content: canonReq.user });

  const body = {
    model: profile.modelId,
    messages,
    [profile.tokenParam]: canonReq.maxOutputTokens
  };
  if (typeof canonReq.system === "string" && profile.systemPlacement === "top_level") {
    // Data-driven escape hatch for endpoints that accept a
    // top-level system field despite the chat shape.
    body.system = canonReq.system;
  }
  if (canonReq.temperature !== null && profile.supportsTemperature) {
    body.temperature = canonReq.temperature;
  }
  if (Array.isArray(canonReq.stopSequences)) {
    body.stop = [...canonReq.stopSequences];
  }
  if (typeof profile.reasoningEffort === "string" && profile.reasoningEffort.length > 0) {
    body.reasoning_effort = profile.reasoningEffort;
  }

  return {
    method: "POST",
    url: ctx.baseUrl + ctx.chatPath,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.apiKey}`
    },
    body
  };
}

export function parseWireResponse(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw llmError(LLM_ERROR_CODES.BAD_RESPONSE, "Chat Completions response has no choices");
  }
  const first = raw.choices[0];
  const message = first && typeof first === "object" ? first.message : null;
  if (!message || typeof message !== "object" || typeof message.content !== "string") {
    throw llmError(LLM_ERROR_CODES.BAD_RESPONSE, "First choice carries no string message content");
  }
  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
  return buildCanonicalResponse({
    text: message.content,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    stopReason: first.finish_reason
  });
}

// Plain-language report of the translations performed, for logs
// and diagnostics. Never includes prompt content or key material.
export function describeTranslations(canonReq, profile) {
  const notes = [];
  if (canonReq && typeof canonReq.system === "string") {
    notes.push(profile && profile.systemPlacement === "role"
      ? "system prompt sent as a leading system role message"
      : "system prompt sent as a top-level system field");
  } else {
    notes.push("no system prompt; no system message added");
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
    notes.push("stop sequences sent as stop");
  }
  if (profile && typeof profile.reasoningEffort === "string" && profile.reasoningEffort.length > 0) {
    notes.push(`reasoning effort default sent as reasoning_effort (${profile.reasoningEffort})`);
  }
  if (profile && Array.isArray(profile.silentlyIgnored) && profile.silentlyIgnored.length > 0) {
    notes.push(`vendor accepts but silently ignores: ${profile.silentlyIgnored.join(", ")}`);
  }
  notes.push("auth via Bearer authorization header");
  return notes;
}
