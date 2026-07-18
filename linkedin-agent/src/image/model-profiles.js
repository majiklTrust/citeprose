// ═══════════════════════════════════════════════════════════════
// src/image/model-profiles.js - image provider and model DATA
// ═══════════════════════════════════════════════════════════════
// The ONE module in src/image allowed to carry literals. Base
// URLs, wire model ids, auth schemes, image paths, capability
// profiles, and pricing are operator-owned configuration: adding
// a vendor or a model is an edit HERE (plus an env var for custom
// endpoints), never an adapter or the orchestrator.
//
// Hardcoded values flagged per project convention: every default
// below is env-overridable through the named *_ENV variable, which
// the registry resolves env-first. Nothing in this file is read
// directly by the adapter or the orchestrator; they consume it
// through src/image/registry.js.
//
// Capability profile fields (these DRIVE the UX, so the front end
// enables or disables controls from the selected model's profile
// rather than branching on a vendor name):
//   supportedSizes      wire size strings the model accepts
//   supportedQualities  wire quality tiers the model accepts
//   outputFormats       container formats the model can emit
//   maxCount            most images per request
//   negativePrompt      how a negative prompt is handled:
//                       "fold" (append into the prompt text),
//                       "param" (a dedicated wire field), or
//                       "unsupported" (dropped)
//   alwaysBase64        true when the model always returns b64 and
//                       rejects a response_format field
//   defaultSize/Quality/OutputFormat  used when the caller omits one
//   pricing             token pricing (USD per million) for the
//                       ACTUAL post-render cost from usage
//   preSpendCeilingUsd  a conservative per-image ceiling used for
//                       the pre-spend budget check (we cannot know
//                       token cost until after the call, so the gate
//                       reserves the worst case and reconciles after)
// ═══════════════════════════════════════════════════════════════

export const IMAGE_LIMITS = Object.freeze({
  // Vendor call timeout for a render.
  timeoutMsEnv: "IMAGE_TIMEOUT_MS",
  defaultTimeoutMs: 120000,
  // Server-side hard ceiling on images per request, regardless of
  // caller input or profile.
  maxCountCapEnv: "IMAGE_MAX_COUNT",
  defaultMaxCountCap: 4
});

export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: "openai",
    label: "OpenAI",
    adapterType: "openai-images",
    baseUrlEnv: "IMAGE_OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com",
    authScheme: "bearer",
    imagePath: "/v1/images/generations",
    // Reserved for a future model-listing validation path.
    modelsPath: "/v1/models",
    versionHeader: null,
    // Unlisted wire ids matching this pattern inherit defaultProfile,
    // so tenants provisioned with any gpt-image model keep working.
    wireIdPattern: "^gpt-image-",
    defaultProfile: Object.freeze({
      supportedSizes: Object.freeze(["1024x1024", "1536x1024", "1024x1536", "auto"]),
      supportedQualities: Object.freeze(["low", "medium", "high", "auto"]),
      outputFormats: Object.freeze(["png", "jpeg", "webp"]),
      maxCount: 10,
      // OpenAI images have no negative-prompt field; fold it into
      // the prompt so the intent is not silently lost.
      negativePrompt: "fold",
      // gpt-image models always return b64_json and REJECT a
      // response_format field, so the adapter must never send one.
      alwaysBase64: true,
      defaultSize: "1024x1024",
      defaultQuality: "auto",
      defaultOutputFormat: "png",
      pricing: Object.freeze({ inputPerMTokUsd: 5, outputPerMTokUsd: 40 }),
      preSpendCeilingUsd: 0.25
    })
  })
]);

// Curated model entries shown in the admin UI. `profile` holds
// overrides merged over the owning provider's defaultProfile.
export const MODELS = Object.freeze([
  Object.freeze({
    provider: "openai",
    id: "gpt-image-1",
    label: "GPT Image 1"
  })
]);
