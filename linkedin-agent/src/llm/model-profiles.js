// ═══════════════════════════════════════════════════════════════
// src/llm/model-profiles.js - provider and model registry DATA
// ═══════════════════════════════════════════════════════════════
// The ONE module in src/llm allowed to carry literals. Base URLs,
// wire model ids, auth schemes, chat paths, capability profiles,
// and pricing are operator-owned configuration: adding a vendor or
// a model is an edit HERE (plus an env var for custom endpoints),
// never an adapter or client change.
//
// Hardcoded values flagged per project convention: every default
// below is env-overridable through the named *_ENV variable, which
// the registry resolves env-first. Nothing in this file is read
// directly by adapters or the orchestrator; they consume it through
// src/llm/registry.js.
//
// Capability profile fields:
//   tokenParam          wire name of the output cap for the model
//   systemPlacement     "top_level" (Anthropic) | "role" (chat msg)
//   supportsTemperature false = adapter DROPS temperature
//   reasoningEffort     null, or a default when the model accepts it
//   silentlyIgnored     params the vendor accepts but quietly drops
//   pricing             optional USD per million tokens, for estimates
// ═══════════════════════════════════════════════════════════════

export const LLM_LIMITS = Object.freeze({
  // Server-side output-token billing guardrail (canonical requests
  // are clamped to this cap regardless of caller input).
  maxOutputTokensCapEnv: "LLM_MAX_OUTPUT_TOKENS",
  defaultMaxOutputTokensCap: 4096,
  // Vendor call timeout.
  timeoutMsEnv: "LLM_TIMEOUT_MS",
  defaultTimeoutMs: 120000
});

export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: "anthropic",
    label: "Anthropic",
    adapterType: "anthropic",
    baseUrlEnv: "LLM_ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com",
    authScheme: "x-api-key",
    chatPath: "/v1/messages",
    modelsPath: "/v1/models",
    versionHeader: Object.freeze({
      name: "anthropic-version",
      env: "LLM_ANTHROPIC_VERSION",
      default: "2023-06-01"
    }),
    // Unlisted wire ids matching this pattern inherit defaultProfile,
    // so tenants provisioned with any Claude model keep working.
    wireIdPattern: "^claude-",
    defaultProfile: Object.freeze({
      tokenParam: "max_tokens",
      systemPlacement: "top_level",
      supportsTemperature: true,
      reasoningEffort: null,
      silentlyIgnored: Object.freeze([])
    })
  }),
  Object.freeze({
    id: "openai",
    label: "OpenAI",
    adapterType: "openai-compatible",
    baseUrlEnv: "LLM_OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com",
    authScheme: "bearer",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    versionHeader: null,
    wireIdPattern: "^(gpt-|o[0-9]|chatgpt-)",
    defaultProfile: Object.freeze({
      tokenParam: "max_completion_tokens",
      systemPlacement: "role",
      supportsTemperature: true,
      reasoningEffort: null,
      silentlyIgnored: Object.freeze([])
    })
  }),
  Object.freeze({
    id: "grok",
    label: "Grok (xAI)",
    adapterType: "openai-compatible",
    baseUrlEnv: "LLM_GROK_BASE_URL",
    defaultBaseUrl: "https://api.x.ai",
    authScheme: "bearer",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    versionHeader: null,
    wireIdPattern: "^grok-",
    defaultProfile: Object.freeze({
      tokenParam: "max_tokens",
      systemPlacement: "role",
      supportsTemperature: true,
      reasoningEffort: null,
      silentlyIgnored: Object.freeze([])
    })
  }),
  Object.freeze({
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    adapterType: "openai-compatible",
    baseUrlEnv: "LLM_CUSTOM_BASE_URL",
    // No default: the operator MUST configure the endpoint before
    // this provider becomes selectable. Tenants can never supply it.
    defaultBaseUrl: null,
    authScheme: "bearer",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    versionHeader: null,
    // Custom models come exclusively from the operator env list;
    // no pattern fallback (null = curated/env list only).
    modelsEnv: "LLM_CUSTOM_MODELS",
    wireIdPattern: null,
    defaultProfile: Object.freeze({
      tokenParam: "max_tokens",
      systemPlacement: "role",
      supportsTemperature: true,
      reasoningEffort: null,
      silentlyIgnored: Object.freeze([])
    })
  })
]);

// Curated model entries shown in the admin UI. `profile` holds
// overrides merged over the owning provider's defaultProfile.
// Pricing is optional (USD per million tokens).
export const MODELS = Object.freeze([
  Object.freeze({
    provider: "anthropic",
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    pricing: Object.freeze({ inputPerMTokUsd: 1, outputPerMTokUsd: 5 })
  }),
  Object.freeze({
    provider: "anthropic",
    id: "claude-sonnet-4-5-20250929",
    label: "Claude Sonnet 4.5",
    pricing: Object.freeze({ inputPerMTokUsd: 3, outputPerMTokUsd: 15 })
  }),
  Object.freeze({
    provider: "openai",
    id: "gpt-4o",
    label: "GPT-4o"
  }),
  Object.freeze({
    provider: "openai",
    id: "gpt-4o-mini",
    label: "GPT-4o mini"
  }),
  Object.freeze({
    provider: "openai",
    id: "gpt-5",
    label: "GPT-5",
    profile: Object.freeze({
      // Reasoning family: fixed sampling temperature; the adapter
      // drops temperature instead of sending a rejected parameter.
      supportsTemperature: false,
      reasoningEffort: "medium"
    })
  }),
  Object.freeze({
    provider: "grok",
    id: "grok-3",
    label: "Grok 3"
  }),
  Object.freeze({
    provider: "grok",
    id: "grok-4",
    label: "Grok 4",
    profile: Object.freeze({
      // xAI reasoning models accept but do not honor stop sequences.
      silentlyIgnored: Object.freeze(["stopSequences"])
    })
  })
]);
