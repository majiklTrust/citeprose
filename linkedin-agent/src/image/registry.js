// ═══════════════════════════════════════════════════════════════
// src/image/registry.js - data-driven provider and model resolution
// ═══════════════════════════════════════════════════════════════
// The ONLY reader of model-profiles.js. Everything here is a pure
// lookup over that data plus an injected env object (defaulting to
// process.env), so tests resolve configuration exactly the way the
// running code does: env value first, data-module default second.
//
// Fail closed: unknown provider ids and model ids throw typed
// ImageErrors. A poisoned base-URL env value throws rather than
// silently falling back to the shipped default. Size and quality
// are validated against the selected model's capability profile;
// an unsupported value is a typed denial, never a silent coercion.
// ═══════════════════════════════════════════════════════════════

import { PROVIDERS, MODELS, IMAGE_LIMITS, ASPECT_PRESETS } from "./model-profiles.js";
import { imageError, IMAGE_ERROR_CODES } from "./errors.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export function getProvider(providerId) {
  if (typeof providerId === "string") {
    const id = providerId.trim();
    const entry = PROVIDERS.find((p) => p.id === id);
    if (entry) return entry;
  }
  throw imageError(
    IMAGE_ERROR_CODES.UNKNOWN_PROVIDER,
    "Unknown image provider selection; refusing to fall back to a default",
    { providerId: String(providerId) }
  );
}

function unavailable(provider, reason) {
  return imageError(IMAGE_ERROR_CODES.PROVIDER_UNAVAILABLE, reason, { providerId: provider.id });
}

// Validates an operator-supplied or default base URL. Poisoned
// values fail closed; they never resolve and never reach the
// egress allowlist. https only, except loopback http for local dev.
function validateBaseUrl(raw, provider, source) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw unavailable(provider, `${source} base URL is not parseable`);
  }
  if (url.username || url.password) {
    throw unavailable(provider, `${source} base URL carries credentials`);
  }
  const httpsOk = url.protocol === "https:";
  const loopbackHttpOk = url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!httpsOk && !loopbackHttpOk) {
    throw unavailable(provider, `${source} base URL scheme not permitted`);
  }
  return raw.replace(/\/+$/, "");
}

export function resolveBaseUrl(provider, env = process.env) {
  const fromEnv = env && typeof env[provider.baseUrlEnv] === "string" ? env[provider.baseUrlEnv].trim() : "";
  if (fromEnv) return validateBaseUrl(fromEnv, provider, `env ${provider.baseUrlEnv}`);
  if (provider.defaultBaseUrl) return validateBaseUrl(provider.defaultBaseUrl, provider, "default");
  throw unavailable(provider, "Provider has no configured base URL");
}

// The egress allowlist is derived from the registry: exactly the
// hosts of base URLs that resolve for configured providers.
export function getAllowedHosts(env = process.env) {
  const hosts = new Set();
  for (const p of PROVIDERS) {
    try {
      hosts.add(new URL(resolveBaseUrl(p, env)).host.toLowerCase());
    } catch {
      // Unconfigured provider contributes nothing to the allowlist.
    }
  }
  return hosts;
}

export function listProviders(env = process.env) {
  return PROVIDERS.map((p) => {
    let configured = true;
    try { resolveBaseUrl(p, env); } catch { configured = false; }
    return { id: p.id, label: p.label, adapterType: p.adapterType, configured };
  });
}

export function listModels(providerId) {
  const provider = getProvider(providerId);
  return MODELS.filter((m) => m.provider === provider.id).map((m) => ({ id: m.id, label: m.label, provider: m.provider }));
}

// First curated model id for a provider, used as the convenience
// default when a tenant selected the vendor but not a model.
export function defaultModelId(providerId) {
  const provider = getProvider(providerId);
  const first = MODELS.find((m) => m.provider === provider.id);
  return first ? first.id : "";
}

function buildProfile(provider, modelId, overrides) {
  const base = provider.defaultProfile;
  const merged = { ...base, ...(overrides || {}) };
  return Object.freeze({
    providerId: provider.id,
    modelId,
    adapterType: provider.adapterType,
    supportedSizes: Object.freeze([...(merged.supportedSizes || [])]),
    supportedQualities: Object.freeze([...(merged.supportedQualities || [])]),
    outputFormats: Object.freeze([...(merged.outputFormats || [])]),
    maxCount: merged.maxCount,
    negativePrompt: merged.negativePrompt,
    alwaysBase64: merged.alwaysBase64 === true,
    defaultSize: merged.defaultSize,
    defaultQuality: merged.defaultQuality,
    defaultOutputFormat: merged.defaultOutputFormat,
    pricing: merged.pricing || null,
    preSpendCeilingUsd: Number.isFinite(merged.preSpendCeilingUsd) ? merged.preSpendCeilingUsd : 0
  });
}

export function getImageModelProfile(providerId, modelId, env = process.env) {
  const provider = getProvider(providerId);
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (id) {
    const curated = MODELS.find((m) => m.provider === provider.id && m.id === id);
    if (curated) return buildProfile(provider, id, curated.profile);
    if (provider.wireIdPattern && new RegExp(provider.wireIdPattern).test(id)) {
      return buildProfile(provider, id, null);
    }
  }
  throw imageError(
    IMAGE_ERROR_CODES.UNKNOWN_MODEL,
    "Image model is not registered for this provider; refusing to fall back",
    { providerId: provider.id, modelId: String(modelId) }
  );
}

// Resolve size/quality/outputFormat: an omitted value takes the
// profile default; a SUPPLIED value must be in the supported set or
// it is a typed denial (fail closed, never coerced).
export function resolveRenderShape(profile, size, quality, outputFormat) {
  const s = (size === null || size === undefined) ? profile.defaultSize : size;
  if (!profile.supportedSizes.includes(s)) {
    throw imageError(IMAGE_ERROR_CODES.UNSUPPORTED_SIZE,
      "Requested size is not supported by this model", { size: String(size), supported: [...profile.supportedSizes] });
  }
  const q = (quality === null || quality === undefined) ? profile.defaultQuality : quality;
  if (!profile.supportedQualities.includes(q)) {
    throw imageError(IMAGE_ERROR_CODES.UNSUPPORTED_QUALITY,
      "Requested quality is not supported by this model", { quality: String(quality), supported: [...profile.supportedQualities] });
  }
  const f = (outputFormat === null || outputFormat === undefined) ? profile.defaultOutputFormat : outputFormat;
  const format = profile.outputFormats.includes(f) ? f : profile.defaultOutputFormat;
  return { size: s, quality: q, outputFormat: format };
}

function positiveIntFromEnv(env, name, fallback) {
  const raw = env && typeof env[name] === "string" ? env[name].trim() : "";
  if (/^[0-9]+$/.test(raw)) {
    const value = parseInt(raw, 10);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return fallback;
}

export function resolveTimeoutMs(env = process.env) {
  return positiveIntFromEnv(env, IMAGE_LIMITS.timeoutMsEnv, IMAGE_LIMITS.defaultTimeoutMs);
}

export function resolveMaxCountCap(env = process.env) {
  return positiveIntFromEnv(env, IMAGE_LIMITS.maxCountCapEnv, IMAGE_LIMITS.defaultMaxCountCap);
}

// Conservative PRE-spend estimate for the budget gate: token cost
// is unknown until after the call, so reserve the profile's per-
// image ceiling times the image count. The gate reconciles against
// the actual cost after the render.
export function estimatePreSpendCostUsd(profile, count) {
  const n = Number.isInteger(count) && count > 0 ? count : 1;
  const ceiling = profile && Number.isFinite(profile.preSpendCeilingUsd) ? profile.preSpendCeilingUsd : 0;
  return Math.round(ceiling * n * 1e6) / 1e6;
}

// ACTUAL post-render cost from token usage, when the model prices
// by tokens and usage is complete. Returns null otherwise.
export function estimateActualCostUsd(profile, usage) {
  if (!profile || !profile.pricing || !usage) return null;
  const { inputTokens, outputTokens } = usage;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  if (inputTokens < 0 || outputTokens < 0) return null;
  const usd = (inputTokens / 1e6) * profile.pricing.inputPerMTokUsd
    + (outputTokens / 1e6) * profile.pricing.outputPerMTokUsd;
  return Math.round(usd * 1e6) / 1e6;
}

// ── Aspect presets (Phase 3) ───────────────────────────────────
// Resolve a UX aspect preset id to its wire size and composition
// guidance. Fail-closed: an unknown preset is a typed error, never a
// silent default, so a typo cannot render the wrong shape.
export function resolveAspectPreset(aspectId) {
  const found = ASPECT_PRESETS.find((p) => p.id === aspectId);
  if (!found) {
    throw imageError(IMAGE_ERROR_CODES.UNSUPPORTED_ASPECT,
      `Unknown aspect preset "${aspectId}"`,
      { aspectId, supported: ASPECT_PRESETS.map((p) => p.id) });
  }
  return found;
}

export function listAspectPresets() {
  return ASPECT_PRESETS.map((p) => ({ id: p.id, label: p.label, size: p.size }));
}
