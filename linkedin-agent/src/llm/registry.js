// ═══════════════════════════════════════════════════════════════
// src/llm/registry.js - data-driven provider and model resolution
// ═══════════════════════════════════════════════════════════════
// The ONLY reader of model-profiles.js. Everything here is a pure
// lookup over that data plus an injected env object (defaulting to
// process.env), so tests resolve configuration exactly the way the
// running code does: env value first, data-module default second.
//
// Fail closed: unknown provider ids and model ids throw typed
// LlmErrors. A poisoned base-URL env value throws rather than
// silently falling back to the shipped default, so a compromised
// deployment variable can never silently redirect traffic.
// ═══════════════════════════════════════════════════════════════

import { PROVIDERS, MODELS, LLM_LIMITS, TEXT_GENERATION_NOTICE } from "./model-profiles.js";
import { llmError, LLM_ERROR_CODES } from "./errors.js";

// Re-exported so routes keep the "registry is the only reader of
// model-profiles" boundary while sharing one notice string (2.6.1).
export { TEXT_GENERATION_NOTICE };

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export function getProvider(providerId) {
  if (typeof providerId === "string") {
    const id = providerId.trim();
    const entry = PROVIDERS.find((p) => p.id === id);
    if (entry) return entry;
  }
  throw llmError(
    LLM_ERROR_CODES.UNKNOWN_PROVIDER,
    "Unknown LLM provider selection; refusing to fall back to a default",
    { providerId: String(providerId) }
  );
}

// Validates an operator-supplied or default base URL. Poisoned
// values fail closed with PROVIDER_UNAVAILABLE; they never resolve
// and never reach the egress allowlist.
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

function unavailable(provider, reason) {
  return llmError(LLM_ERROR_CODES.PROVIDER_UNAVAILABLE, reason, { providerId: provider.id });
}

export function resolveBaseUrl(provider, env = process.env) {
  const fromEnv = env && typeof env[provider.baseUrlEnv] === "string"
    ? env[provider.baseUrlEnv].trim()
    : "";
  if (fromEnv) {
    return validateBaseUrl(fromEnv, provider, `env ${provider.baseUrlEnv}`);
  }
  if (provider.defaultBaseUrl) {
    return validateBaseUrl(provider.defaultBaseUrl, provider, "default");
  }
  throw unavailable(provider, "Provider has no configured base URL");
}

export function listProviders(env = process.env) {
  return PROVIDERS.map((p) => {
    let configured = true;
    try {
      resolveBaseUrl(p, env);
    } catch {
      configured = false;
    }
    return {
      id: p.id,
      label: p.label,
      adapterType: p.adapterType,
      configured,
      textGeneration: textGenerationAvailability(p.id),
      textGenerationNotice: textGenerationNotice(p.id)
    };
  });
}

// ── Text-generation availability (2.6.1) ─────────────────────
// Whether a provider may be SELECTED as the workspace text vendor.
// Data-driven from the provider entry; a missing field reads as
// "available" so existing entries keep their behavior. Unknown
// provider ids throw (getProvider fail-closed), so availability can
// never be minted for an id the registry does not know.
export function textGenerationAvailability(providerId) {
  const entry = getProvider(providerId);
  return entry.textGeneration === "coming_soon" ? "coming_soon" : "available";
}

export function isTextProviderAvailable(providerId) {
  return textGenerationAvailability(providerId) === "available";
}

// Per-vendor parked-selection copy (2.6.5). Each parked provider
// tells its own true story (the OpenAI notice routes the key to the
// Image Model section; the Grok notice must not). Falls back to the
// shared notice when an entry carries no copy of its own. Unknown
// ids throw via getProvider, fail-closed like every lookup here.
export function textGenerationNotice(providerId) {
  const entry = getProvider(providerId);
  return (typeof entry.textGenerationNotice === "string" && entry.textGenerationNotice)
    || TEXT_GENERATION_NOTICE;
}

// The egress allowlist is derived from the registry: exactly the
// hosts of base URLs that resolve for configured providers.
export function getAllowedHosts(env = process.env) {
  const hosts = new Set();
  for (const p of PROVIDERS) {
    try {
      hosts.add(new URL(resolveBaseUrl(p, env)).host.toLowerCase());
    } catch {
      // Unconfigured provider (e.g. custom without its env var):
      // contributes nothing to the allowlist.
    }
  }
  return hosts;
}

function customModelIds(provider, env) {
  const raw = env && typeof env[provider.modelsEnv] === "string" ? env[provider.modelsEnv] : "";
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

export function listModels(providerId, env = process.env) {
  const provider = getProvider(providerId);
  if (provider.modelsEnv) {
    return customModelIds(provider, env).map((id) => ({ id, label: id, provider: provider.id }));
  }
  return MODELS
    .filter((m) => m.provider === provider.id)
    .map((m) => ({ id: m.id, label: m.label, provider: m.provider }));
}

function buildProfile(provider, modelId, overrides, pricing) {
  const base = provider.defaultProfile;
  const merged = { ...base, ...(overrides || {}) };
  return Object.freeze({
    providerId: provider.id,
    modelId,
    adapterType: provider.adapterType,
    tokenParam: merged.tokenParam,
    systemPlacement: merged.systemPlacement,
    supportsTemperature: merged.supportsTemperature,
    reasoningEffort: merged.reasoningEffort,
    silentlyIgnored: Object.freeze([...(merged.silentlyIgnored || [])]),
    pricing: pricing || null
  });
}

export function getModelProfile(providerId, modelId, env = process.env) {
  const provider = getProvider(providerId);
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (id) {
    const curated = MODELS.find((m) => m.provider === provider.id && m.id === id);
    if (curated) {
      return buildProfile(provider, id, curated.profile, curated.pricing);
    }
    if (provider.modelsEnv && customModelIds(provider, env).includes(id)) {
      return buildProfile(provider, id, null, null);
    }
    if (provider.wireIdPattern && new RegExp(provider.wireIdPattern).test(id)) {
      return buildProfile(provider, id, null, null);
    }
  }
  throw llmError(
    LLM_ERROR_CODES.UNKNOWN_MODEL,
    "Model is not registered for this provider; refusing to fall back",
    { providerId: provider.id, modelId: String(modelId) }
  );
}

function positiveIntFromEnv(env, name, fallback) {
  const raw = env && typeof env[name] === "string" ? env[name].trim() : "";
  if (/^[0-9]+$/.test(raw)) {
    const value = parseInt(raw, 10);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return fallback;
}

// Billing guardrail: the server-side output token cap. Junk env
// values degrade to the data-module default, never to zero or an
// unbounded value.
export function resolveOutputTokenCap(env = process.env) {
  return positiveIntFromEnv(env, LLM_LIMITS.maxOutputTokensCapEnv, LLM_LIMITS.defaultMaxOutputTokensCap);
}

export function resolveTimeoutMs(env = process.env) {
  return positiveIntFromEnv(env, LLM_LIMITS.timeoutMsEnv, LLM_LIMITS.defaultTimeoutMs);
}

// Optional cost estimate from profile pricing. Returns null when
// the model has no pricing data or usage is incomplete.
export function estimateCostUsd(profile, usage) {
  if (!profile || !profile.pricing || !usage) return null;
  const { promptTokens, completionTokens } = usage;
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return null;
  if (promptTokens < 0 || completionTokens < 0) return null;
  const usd = (promptTokens / 1e6) * profile.pricing.inputPerMTokUsd
    + (completionTokens / 1e6) * profile.pricing.outputPerMTokUsd;
  return Math.round(usd * 1e6) / 1e6;
}
