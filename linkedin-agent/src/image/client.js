// ═══════════════════════════════════════════════════════════════
// src/image/client.js - the render orchestrator (single entry)
// ═══════════════════════════════════════════════════════════════
// The one function the Image Studio calls to reach ANY image
// vendor: render(RenderProperties, deps). Safe production order,
// in this exact sequence:
//   1. resolve the tenant to a provider and model (fail closed on
//      unknown or unprovisioned selections; no silent default -
//      image generation has no safe fallback vendor)
//   2. build the RenderProperties request (count clamped) and
//      resolve/validate the render shape against the model profile
//   3. reserve the pre-spend cost and CLEAR the budget gate before
//      any spend (fail closed: a missing gate refuses to render)
//   4. resolve the per-tenant, provider-scoped API key (fail closed)
//   5. hand the request to the adapter for the wire request
//   6. enforce the shared egress allowlist on the host
//   7. call the vendor with a timeout
//   8. normalize through the adapter; return canonical images,
//      usage, and the reconciled actual cost
//
// Decoupling: this seam reuses the SHARED egress and redaction
// kernel (assertHostAllowed, redactDeep from ../llm/security.js)
// and the shared per-tenant credential store, but depends on NO
// other part of the text seam. Anything that touches the database
// (agent_state, credential store) is imported lazily inside the
// default dependency resolvers, so this module loads in any
// environment and tests inject fakes through the deps parameter.
//
// The budget gate is INJECTED, never imported here: the seam does
// not know how a budget is computed, only that it must clear one
// before spending. This keeps the seam decoupled from billing.
// ═══════════════════════════════════════════════════════════════

import {
  getProvider, getImageModelProfile, resolveBaseUrl, getAllowedHosts,
  resolveTimeoutMs, resolveMaxCountCap, resolveRenderShape, defaultModelId
} from "./registry.js";
import { buildRenderRequest, describeRenderRequest } from "./canonical.js";
import { imageError, IMAGE_ERROR_CODES, isImageError, normalizeVendorHttpError } from "./errors.js";
import * as openAiImagesAdapter from "./adapters/openai-images.js";
// Shared kernel reuse (NOT the text seam's registry or adapters).
import { assertHostAllowed, redactDeep } from "../llm/security.js";
import { platformLog } from "../services/platform-log.js";
import { traceEnabled } from "../services/llm-trace.js";

const ADAPTERS = Object.freeze({
  "openai-images": openAiImagesAdapter
});

// ── Default dependencies (lazy: DB modules load on first use) ──

async function defaultGetState(key) {
  const { getAgentState } = await import("../services/database.js");
  return getAgentState(key);
}

async function defaultGetApiKey(providerId) {
  // 2.5.58: image generation resolves through the SAME chain as
  // text: trial precedence and key provenance apply to images too.
  const { resolveLlmKey } = await import("../spend/key-resolver.js");
  return resolveLlmKey(providerId);
}

function resolveDeps(deps = {}) {
  return {
    env: deps.env || process.env,
    fetchImpl: deps.fetchImpl || globalThis.fetch,
    getState: deps.getState || defaultGetState,
    getApiKey: deps.getApiKey || defaultGetApiKey,
    getAllowedHosts: deps.getAllowedHosts || getAllowedHosts,
    log: deps.log || platformLog,
    // No default: a render must clear an explicit budget gate. An
    // absent gate is a fail-closed refusal, never a silent spend.
    budgetGate: typeof deps.budgetGate === "function" ? deps.budgetGate : null,
    // Injectable pricing (tests, alternatives); default resolves the
    // versioned platform tables lazily.
    pricing: deps.pricing || null
  };
}

function adapterFor(adapterType) {
  const adapter = ADAPTERS[adapterType];
  if (!adapter) {
    throw imageError(IMAGE_ERROR_CODES.UNKNOWN_PROVIDER, `No image adapter registered for type ${String(adapterType)}`);
  }
  return adapter;
}

// ── Step 1: tenant selection -> provider + model + profile ─────
// agent_state keys image_provider / image_model own the selection.
// Unlike text, there is NO compatibility default vendor: an unset
// provider is NOT_PROVISIONED, because the default text vendor
// (Anthropic) cannot generate images. An unset model falls back to
// the provider's first curated model.
export async function resolveTenantImageSelection(deps = {}) {
  const d = resolveDeps(deps);
  const rawProvider = await d.getState("image_provider");
  const selectedId = typeof rawProvider === "string" ? rawProvider.trim() : "";
  if (!selectedId) {
    throw imageError(IMAGE_ERROR_CODES.NOT_PROVISIONED,
      "No image provider is configured for this workspace; connect an image-capable vendor first");
  }
  const providerEntry = getProvider(selectedId);
  const rawModel = await d.getState("image_model");
  let model = typeof rawModel === "string" ? rawModel.trim() : "";
  if (!model) model = defaultModelId(providerEntry.id);
  if (!model) {
    throw imageError(IMAGE_ERROR_CODES.NOT_PROVISIONED,
      `Image provider ${providerEntry.id} is selected but no model is configured`,
      { providerId: providerEntry.id });
  }
  const profile = getImageModelProfile(providerEntry.id, model, d.env);
  return { provider: providerEntry.id, model, profile, providerEntry };
}

function buildCallContext(selection, apiKey, shape, env) {
  return {
    baseUrl: resolveBaseUrl(selection.providerEntry, env),
    imagePath: selection.providerEntry.imagePath,
    apiKey,
    shape
  };
}

async function fetchWithTimeout(d, url, options, providerId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await d.fetchImpl(url, { ...options, signal: controller.signal });
  } catch (err) {
    if ((err && err.name === "AbortError") || controller.signal.aborted) {
      throw imageError(IMAGE_ERROR_CODES.TIMEOUT,
        `Image provider ${providerId} call exceeded ${timeoutMs}ms`, { providerId, timeoutMs });
    }
    throw imageError(IMAGE_ERROR_CODES.VENDOR_HTTP,
      `Image provider ${providerId} network call failed`,
      { providerId, cause: err && err.name ? err.name : "Error" });
  } finally {
    clearTimeout(timer);
  }
}

async function readVendorJson(res, providerId) {
  if (!res.ok) {
    let bodyText = "";
    try { bodyText = await res.text(); } catch { /* body unavailable */ }
    throw normalizeVendorHttpError(providerId, res.status, bodyText);
  }
  try {
    return await res.json();
  } catch {
    throw imageError(IMAGE_ERROR_CODES.BAD_RESPONSE,
      `Image provider ${providerId} returned unparseable JSON`, { providerId });
  }
}

function wrapMissingCredential(err, providerId) {
  if (isImageError(err)) return err;
  const reason = err && typeof err.message === "string" ? err.message : "credential lookup failed";
  return imageError(IMAGE_ERROR_CODES.MISSING_CREDENTIAL,
    `Missing API key for image provider ${providerId} (${reason})`, { providerId });
}

// ── The single entry point the Studio calls ───────────────────
// input: RenderProperties plus optional { purpose, cycleId }.
// deps.budgetGate(estimatedCostUsd) MUST be supplied; it throws to
// deny an unaffordable render. Returns frozen { images, usage,
// costEstimateUsd, preSpendEstimateUsd, provider, model }.
export async function render(input, deps = {}) {
  const d = resolveDeps(deps);
  const purpose = input && typeof input.purpose === "string" ? input.purpose : "render";
  const cycleId = input && typeof input.cycleId === "string" ? input.cycleId : null;

  let selection;
  try {
    selection = await resolveTenantImageSelection(d);

    const canonReq = buildRenderRequest({
      prompt: input ? input.prompt : undefined,
      negativePrompt: input ? input.negativePrompt : null,
      size: input ? input.size : null,
      quality: input ? input.quality : null,
      count: input ? input.count : null,
      outputFormat: input ? input.outputFormat : null,
      aspect: input ? input.aspect : null,
      lensId: input ? input.lensId : null,
      seed: input ? input.seed : null,
      grounding: input ? input.grounding : null,
      modelRef: { provider: selection.provider, model: selection.model }
    }, { maxCountCap: resolveMaxCountCap(d.env) });

    const shape = resolveRenderShape(selection.profile, canonReq.size, canonReq.quality, canonReq.outputFormat);

    // Reserve the conservative pre-spend cost and CLEAR the budget
    // gate BEFORE any spend. A missing gate is a fail-closed refusal.
    // Gate presence is validated BEFORE any pricing work: an
    // unusable call refuses without touching the database.
    if (!d.budgetGate) {
      throw imageError(IMAGE_ERROR_CODES.BUDGET_REQUIRED,
        "render() requires a budgetGate; refusing to spend ungated");
    }
    // EXACT pre-spend from the versioned platform price tables, keyed
    // by the resolved shape. FAIL-CLOSED: an unpriced (model, size,
    // quality) refuses the render; a zero estimate would walk through
    // the budget gate, so null never degrades to zero.
    const pricing = d.pricing || await import("../services/image-pricing.js");
    const preSpendUsd = await pricing.resolvePreSpendUsd(
      selection.provider, selection.model, shape.size, shape.quality, canonReq.count);
    if (preSpendUsd === null) {
      throw imageError(IMAGE_ERROR_CODES.PRICING_UNAVAILABLE,
        `No price row for ${selection.provider}/${selection.model} at ${shape.size}/${shape.quality}; seed 41-image-model-pricing.sql`,
        { provider: selection.provider, model: selection.model, size: shape.size, quality: shape.quality });
    }
    await d.budgetGate(preSpendUsd);

    let apiKey;
    try {
      apiKey = await d.getApiKey(selection.provider);
    } catch (err) {
      throw wrapMissingCredential(err, selection.provider);
    }
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw imageError(IMAGE_ERROR_CODES.MISSING_CREDENTIAL,
        `Missing API key for image provider ${selection.provider}`, { providerId: selection.provider });
    }

    const adapter = adapterFor(selection.profile.adapterType);
    const wire = adapter.buildWireRequest(canonReq, selection.profile, buildCallContext(selection, apiKey, shape, d.env));

    assertHostAllowed(wire.url, d.getAllowedHosts(d.env));

    d.log("info", "image_render_orchestrated", {
      ...describeRenderRequest(canonReq),
      purpose, cycleId, preSpendUsd,
      translations: adapter.describeTranslations(canonReq, selection.profile)
    });
    if (traceEnabled(d.env ? d.env.IMAGE_TRACE : undefined)) {
      d.log("debug", "image_payload_orchestrated", redactDeep({ purpose, cycleId, request: wire }));
    }

    const timeoutMs = resolveTimeoutMs(d.env);
    const startedMs = Date.now();
    const res = await fetchWithTimeout(d, wire.url, {
      method: wire.method,
      headers: wire.headers,
      body: JSON.stringify(wire.body)
    }, selection.provider, timeoutMs);
    const raw = await readVendorJson(res, selection.provider);

    const response = adapter.parseWireResponse(raw, wire.resolved);
    const durationMs = Date.now() - startedMs;
    const rates = await pricing.resolveModelRates(selection.provider, selection.model);
    const costEstimateUsd = pricing.computeActualCostUsd(rates, response.usage);

    d.log("info", "image_response_orchestrated", {
      provider: selection.provider, model: selection.model, purpose, cycleId,
      imageCount: response.images.length, usage: response.usage,
      durationMs, costEstimateUsd, preSpendUsd
    });
    try {
      const { recordSpend } = await import("../spend/spend-recorder.js");
      await recordSpend({ requestType: "image_generation", fallbackWorkflow: "image_studio",
        provider: selection.provider, model: selection.model,
        usage: response.usage, costEstimateUsd, status: "ok" });
    } catch (recErr) {
      console.error("[PLATFORM:ERROR] spend_recorder_unreachable", JSON.stringify({ error: recErr && recErr.message }));
    }

    return Object.freeze({
      images: response.images,
      usage: response.usage,
      costEstimateUsd,
      preSpendEstimateUsd: preSpendUsd,
      provider: selection.provider,
      model: selection.model
    });
  } catch (err) {
    d.log("error", "image_orchestrated_failed", {
      provider: selection ? selection.provider : null,
      model: selection ? selection.model : null,
      purpose, cycleId,
      code: isImageError(err) ? err.code : (err && err.code) || (err && err.name) || "Error"
    });
    throw err;
  }
}
