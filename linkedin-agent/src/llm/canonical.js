// ═══════════════════════════════════════════════════════════════
// src/llm/canonical.js - the narrow-waist request/response contract
// ═══════════════════════════════════════════════════════════════
// The internal shapes the whole pipeline speaks. Adapters build a
// wire request FROM a canonical request and parse a raw vendor
// response INTO a canonical response; nothing outside src/llm ever
// sees a vendor payload.
//
// Canonical request:  { system, user, maxOutputTokens, temperature,
//                       stopSequences, modelRef }
//   - temperature null means "do not send" (adapter omits it)
//   - maxOutputTokens is clamped to the server-side billing cap
// Canonical response: { text, usage: { promptTokens,
//                       completionTokens, totalTokens }, stopReason }
//
// Streaming is deliberately absent from this contract; a future
// streaming variant would add a parallel build/parse pair without
// changing these shapes.
// ═══════════════════════════════════════════════════════════════

import { llmError, LLM_ERROR_CODES } from "./errors.js";

const MAX_STOP_SEQUENCES = 8;

function invalid(message, details) {
  return llmError(LLM_ERROR_CODES.INVALID_REQUEST, message, details);
}

export function buildCanonicalRequest(input, opts) {
  if (!input || typeof input !== "object") {
    throw invalid("Canonical request input must be an object");
  }
  const cap = opts && opts.outputTokenCap;
  if (!Number.isInteger(cap) || cap <= 0) {
    throw invalid("Output token cap must be a positive integer");
  }

  const { system, user, maxOutputTokens, temperature, stopSequences, modelRef } = input;

  if (typeof user !== "string" || user.length === 0) {
    throw invalid("Canonical request requires non-empty user content");
  }
  if (system !== undefined && system !== null && typeof system !== "string") {
    throw invalid("Canonical system prompt must be a string when present");
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw invalid("maxOutputTokens must be a positive integer");
  }
  let temp = null;
  if (temperature !== undefined && temperature !== null) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature)
      || temperature < 0 || temperature > 2) {
      throw invalid("temperature must be null or a finite number between 0 and 2");
    }
    temp = temperature;
  }
  let stops = null;
  if (stopSequences !== undefined && stopSequences !== null) {
    if (!Array.isArray(stopSequences) || stopSequences.length === 0
      || stopSequences.length > MAX_STOP_SEQUENCES
      || !stopSequences.every((s) => typeof s === "string" && s.length > 0)) {
      throw invalid("stopSequences must be a non-empty array of non-empty strings");
    }
    stops = Object.freeze([...stopSequences]);
  }
  if (!modelRef || typeof modelRef !== "object"
    || typeof modelRef.provider !== "string" || modelRef.provider.length === 0
    || typeof modelRef.model !== "string" || modelRef.model.length === 0) {
    throw invalid("modelRef must name a registry provider and model");
  }

  return Object.freeze({
    system: system === undefined || system === null ? null : system,
    user,
    // Billing guardrail: the cap always wins.
    maxOutputTokens: Math.min(maxOutputTokens, cap),
    temperature: temp,
    stopSequences: stops,
    modelRef: Object.freeze({ provider: modelRef.provider, model: modelRef.model })
  });
}

function toTokenCount(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return null;
}

export function buildCanonicalResponse(input) {
  if (!input || typeof input !== "object" || typeof input.text !== "string") {
    throw llmError(LLM_ERROR_CODES.BAD_RESPONSE, "Canonical response requires text content");
  }
  const promptTokens = toTokenCount(input.promptTokens);
  const completionTokens = toTokenCount(input.completionTokens);
  let totalTokens = toTokenCount(input.totalTokens);
  if (totalTokens === null && promptTokens !== null && completionTokens !== null) {
    totalTokens = promptTokens + completionTokens;
  }
  const stopReason = typeof input.stopReason === "string" && input.stopReason.length > 0
    ? input.stopReason
    : null;
  return Object.freeze({
    text: input.text,
    usage: Object.freeze({ promptTokens, completionTokens, totalTokens }),
    stopReason
  });
}

// Log-safe summary of a canonical request: identifiers and sizes
// only, never prompt or system content.
export function describeCanonicalRequest(req) {
  if (!req || typeof req !== "object") {
    return { provider: null, model: null, promptChars: 0, systemChars: 0, maxOutputTokens: null, temperature: null, stopCount: 0 };
  }
  return {
    provider: req.modelRef ? req.modelRef.provider : null,
    model: req.modelRef ? req.modelRef.model : null,
    promptChars: typeof req.user === "string" ? req.user.length : 0,
    systemChars: typeof req.system === "string" ? req.system.length : 0,
    maxOutputTokens: req.maxOutputTokens ?? null,
    temperature: req.temperature ?? null,
    stopCount: Array.isArray(req.stopSequences) ? req.stopSequences.length : 0
  };
}
