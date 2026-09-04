// ═══════════════════════════════════════════════════════════════
// src/llm/client.js - the orchestrator (single entry point)
// ═══════════════════════════════════════════════════════════════
// The one function the content pipeline calls to reach ANY Model Provider.
// Safe production order, in this exact sequence:
//   1. resolve the tenant to a provider and model (fail closed on
//      unknown or unprovisioned selections; never a silent default)
//   2. resolve the per-tenant, provider-scoped API key (fail closed)
//   3. build the canonical request once (output cap clamped)
//   4. hand it to the correct adapter for the wire request
//   5. enforce the registry-derived egress allowlist on the host
//   6. call the Model Provider with a timeout
//   7. normalize through the adapter; return canonical result + usage
//
// Dependency discipline: static imports are limited to sibling llm
// modules and pure console helpers. Anything that touches the
// database (agent_state, credential store, the legacy model chain)
// is imported lazily inside the default dependency resolvers, so
// this module loads in any environment and tests inject fakes
// through the deps parameter (factory convention).
//
// Streaming is intentionally not implemented; the canonical
// contract leaves room for a parallel streaming variant later.
// ═══════════════════════════════════════════════════════════════

import {
  getProvider, resolveBaseUrl, getModelProfile, getAllowedHosts,
  resolveOutputTokenCap, resolveTimeoutMs, estimateCostUsd
} from "./registry.js";
import { buildCanonicalRequest, describeCanonicalRequest } from "./canonical.js";
import { assertHostAllowed, redactDeep } from "./security.js";
import { llmError, LLM_ERROR_CODES, isLlmError, normalizeVendorHttpError } from "./errors.js";
import * as anthropicAdapter from "./adapters/anthropic.js";
import * as openAiCompatibleAdapter from "./adapters/openai-compatible.js";
import { platformLog } from "../services/platform-log.js";
import { labRun } from "../services/generation-trace.js";
import { traceEnabled } from "../services/llm-trace.js";
import { yieldDb } from "../db/tenant-workflow.js";

const ADAPTERS = Object.freeze({
  "anthropic": anthropicAdapter,
  "openai-compatible": openAiCompatibleAdapter
});

// Config flag for the call-site cutover. Strict trimmed "1" (same
// discipline as LLM_TRACE): anything else keeps current behavior.
export function isLlmAbstractionEnabled(env = process.env) {
  return traceEnabled(env ? env.LLM_ABSTRACTION : undefined);
}

// ── Default dependencies (lazy: DB modules load on first use) ──

async function defaultGetState(key) {
  const { getAgentState } = await import("../services/database.js");
  return getAgentState(key);
}

async function defaultGetApiKey(providerId) {
  // 2.5.55: the key comes from the resolver CHAIN (trial precedence,
  // tenant vault, platform env). Same string contract as before;
  // provenance rides the activation context, invisible here.
  const { resolveLlmKey } = await import("../spend/key-resolver.js");
  return resolveLlmKey(providerId);
}

async function defaultAnthropicModelChain() {
  const { getAnthropicModel } = await import("../config/ai.js");
  return getAnthropicModel();
}

function resolveDeps(deps = {}) {
  return {
    env: deps.env || process.env,
    fetchImpl: deps.fetchImpl || globalThis.fetch,
    getState: deps.getState || defaultGetState,
    getApiKey: deps.getApiKey || defaultGetApiKey,
    anthropicModelChain: deps.anthropicModelChain || defaultAnthropicModelChain,
    getAllowedHosts: deps.getAllowedHosts || getAllowedHosts,
    log: deps.log || platformLog
  };
}

// ── Step 1: tenant selection -> provider + model + profile ─────
// agent_state keys llm_provider / llm_model own the selection.
// Tenants that never chose (no llm_provider row) keep exactly the
// pre-abstraction behavior: Anthropic with the current model chain
// (agent_state anthropic_model, then env, then the shipped
// default). That documented compatibility default is the ONLY
// defaulting here; an unknown provider or model always throws.
export async function resolveTenantLlmSelection(deps = {}) {
  const d = resolveDeps(deps);
  const rawProvider = await d.getState("llm_provider");
  const selectedId = typeof rawProvider === "string" ? rawProvider.trim() : "";

  let providerEntry;
  let model = "";
  if (!selectedId) {
    providerEntry = getProvider("anthropic");
    model = String(await d.anthropicModelChain() || "").trim();
  } else {
    providerEntry = getProvider(selectedId);
    const rawModel = await d.getState("llm_model");
    model = typeof rawModel === "string" ? rawModel.trim() : "";
    if (!model && providerEntry.id === "anthropic") {
      model = String(await d.anthropicModelChain() || "").trim();
    }
  }
  if (!model) {
    throw llmError(
      LLM_ERROR_CODES.NOT_PROVISIONED,
      `LLM provider ${providerEntry.id} is selected but no model is configured for this workspace`,
      { providerId: providerEntry.id }
    );
  }
  const profile = getModelProfile(providerEntry.id, model, d.env);
  return { provider: providerEntry.id, model, profile, providerEntry };
}

function adapterFor(adapterType) {
  const adapter = ADAPTERS[adapterType];
  if (!adapter) {
    throw llmError(LLM_ERROR_CODES.UNKNOWN_PROVIDER, `No adapter registered for type ${String(adapterType)}`);
  }
  return adapter;
}

function buildCallContext(selection, apiKey, env) {
  const entry = selection.providerEntry;
  const ctx = {
    baseUrl: resolveBaseUrl(entry, env),
    chatPath: entry.chatPath,
    apiKey
  };
  if (entry.versionHeader) {
    const fromEnv = env && typeof env[entry.versionHeader.env] === "string"
      ? env[entry.versionHeader.env].trim()
      : "";
    ctx.version = fromEnv || entry.versionHeader.default;
  }
  return ctx;
}

// Timed Model Provider call. Network faults surface with a FIXED message
// (transport errors can echo headers) and abort maps to TIMEOUT.
async function fetchWithTimeout(d, url, options, providerId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await d.fetchImpl(url, { ...options, signal: controller.signal });
  } catch (err) {
    if ((err && err.name === "AbortError") || controller.signal.aborted) {
      throw llmError(LLM_ERROR_CODES.TIMEOUT,
        `LLM provider ${providerId} call exceeded ${timeoutMs}ms`, { providerId, timeoutMs });
    }
    throw llmError(LLM_ERROR_CODES.VENDOR_HTTP,
      `LLM provider ${providerId} network call failed`,
      { providerId, cause: err && err.name ? err.name : "Error" });
  } finally {
    clearTimeout(timer);
  }
}

async function readModelProviderJson(res, providerId) {
  if (!res.ok) {
    let bodyText = "";
    try { bodyText = await res.text(); } catch { /* body unavailable */ }
    throw normalizeVendorHttpError(providerId, res.status, bodyText);
  }
  try {
    return await res.json();
  } catch {
    throw llmError(LLM_ERROR_CODES.BAD_RESPONSE,
      `LLM provider ${providerId} returned unparseable JSON`, { providerId });
  }
}

function wrapMissingCredential(err, providerId) {
  if (isLlmError(err)) return err;
  const reason = err && typeof err.message === "string" ? err.message : "credential lookup failed";
  return llmError(LLM_ERROR_CODES.MISSING_CREDENTIAL,
    `Missing API key for LLM provider ${providerId} (${reason})`, { providerId });
}

// ── The single entry point the pipeline calls ─────────────────
// input: { system?, user, maxOutputTokens, temperature?,
//          stopSequences?, purpose?, cycleId? }
// Returns frozen { text, usage, stopReason, provider, model,
//                  costEstimateUsd }.
export async function generateWithTenantLlm(input, deps = {}) {
  const d = resolveDeps(deps);
  const purpose = input && typeof input.purpose === "string" ? input.purpose : "generation";
  const cycleId = input && typeof input.cycleId === "string" ? input.cycleId : null;

  let selection;
  // An observed Lab run routes to the operator's chosen provider and
  // model on the PLATFORM key. This is NOT the resolver chain and does
  // not disturb it: ruling 2.5.65 stands for every other caller.
  //
  // The selection is built with all FOUR properties the code below
  // reads. A two-property object here threw TypeError at the adapter
  // lookup before any wire request existed, which is how the earlier
  // implementation failed every Lab run that reached this function.
  // Resolving the profile here also turns an unusable model into the
  // registry's own typed UNKNOWN_MODEL refusal instead of a crash.
  const lab = labRun();
  try {
    let apiKey;
    if (lab && lab.apiKey) {
      const labProvider = getProvider(lab.provider || "anthropic");
      selection = {
        provider: labProvider.id,
        model: lab.model,
        profile: getModelProfile(labProvider.id, lab.model, d.env),
        providerEntry: labProvider
      };
      apiKey = lab.apiKey;
    } else {
      selection = await resolveTenantLlmSelection(d);
      try {
        apiKey = await d.getApiKey(selection.provider);
      } catch (err) {
        throw wrapMissingCredential(err, selection.provider);
      }
    }
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw llmError(LLM_ERROR_CODES.MISSING_CREDENTIAL,
        `Missing API key for LLM provider ${selection.provider}`, { providerId: selection.provider });
    }

    const canonReq = buildCanonicalRequest({
      system: input ? input.system : null,
      user: input ? input.user : undefined,
      maxOutputTokens: input ? input.maxOutputTokens : undefined,
      temperature: input ? input.temperature : null,
      stopSequences: input ? input.stopSequences : null,
      modelRef: { provider: selection.provider, model: selection.model }
    }, { outputTokenCap: resolveOutputTokenCap(d.env) });

    const adapter = adapterFor(selection.profile.adapterType);
    const wire = adapter.buildWireRequest(canonReq, selection.profile, buildCallContext(selection, apiKey, d.env));

    assertHostAllowed(wire.url, d.getAllowedHosts(d.env));

    d.log("info", "llm_request_orchestrated", {
      ...describeCanonicalRequest(canonReq),
      purpose, cycleId,
      translations: adapter.describeTranslations(canonReq, selection.profile)
    });
    if (traceEnabled(d.env ? d.env.LLM_TRACE : undefined)) {
      d.log("debug", "llm_payload_orchestrated", redactDeep({ purpose, cycleId, request: wire }));
    }

    // Item #1 Phase 3 (4.25111.40): every database read this call
    // needed (agent_state selection, the tenant credential through
    // the resolver chain) has happened, and the payload is built.
    // Surrender the lease HERE, before the wire, or the credential
    // read's lease sits open through the whole provider wait: the
    // call-site yields in content-generator cannot cover reads that
    // happen INSIDE this function. The Lab path never showed this
    // hole because a Lab run rides the platform key from env and
    // reads nothing. No-op under classic withTenant and when no
    // lease is open.
    await yieldDb();

    const timeoutMs = resolveTimeoutMs(d.env);
    const startedMs = Date.now();
    const res = await fetchWithTimeout(d, wire.url, {
      method: wire.method,
      headers: wire.headers,
      body: JSON.stringify(wire.body)
    }, selection.provider, timeoutMs);
    const raw = await readModelProviderJson(res, selection.provider);

    const response = adapter.parseWireResponse(raw);
    const durationMs = Date.now() - startedMs;
    const costEstimateUsd = estimateCostUsd(selection.profile, response.usage);

    d.log("info", "llm_response_orchestrated", {
      provider: selection.provider, model: selection.model, purpose, cycleId,
      usage: response.usage, stopReason: response.stopReason, durationMs, costEstimateUsd
    });

    // 4.25111.20, ruling: real spend is always recorded, Lab runs
    // included. The old `if (!lab)` gate here is gone because its
    // job moved to the ONE seam that writes rows: spend-recorder
    // consults the ambient lab frame itself and attributes lab
    // calls to key_source 'platform' / workflow 'generation_lab',
    // so an ungated call can no longer file platform spend against
    // the tenant the Lab was pointed at.
    try {
      const { recordSpend } = await import("../spend/spend-recorder.js");
      await recordSpend({ requestType: "text_generation", provider: selection.provider,
        model: selection.model, usage: response.usage, costEstimateUsd, status: "ok" });
    } catch (recErr) {
      // The recorder logs its own failures; this catch fires only if
      // the recorder itself cannot load or crashed pre-log. That
      // must never be silent (2.5.81).
      // 4.25111.58: persisted; the [PLATFORM:ERROR] console line used
      // to look like a platform log row and was not one.
      platformLog("error", "spend_recorder_unreachable", { requestType: "text_generation", error: recErr && recErr.message });
    }

    return Object.freeze({
      text: response.text,
      usage: response.usage,
      stopReason: response.stopReason,
      provider: selection.provider,
      model: selection.model,
      costEstimateUsd,
      // 4.25111.16 (refactor item 1): the duration this orchestrator
      // already measures around the Model Provider call, previously logged
      // and discarded. Returned so callers report the MEASURED number
      // instead of inferring one downstream from announcement times.
      durationMs
    });
  } catch (err) {
    d.log("error", "llm_orchestrated_failed", {
      provider: selection ? selection.provider : null,
      model: selection ? selection.model : null,
      purpose, cycleId,
      code: isLlmError(err) ? err.code : (err && err.name) || "Error"
    });
    try {
      // Same seam rule as the success path (4.25111.20): the lab
      // gate is gone, the recorder attributes lab failures itself.
      if (selection) {
        const { recordSpend } = await import("../spend/spend-recorder.js");
        const timedOut = isLlmError(err) && err.code === "TIMEOUT";
        await recordSpend({ requestType: "text_generation", provider: selection.provider,
          model: selection.model, usage: null, costEstimateUsd: null,
          status: timedOut ? "unknown_usage" : "failed" });
      }
    } catch (recErr) {
      // never mask the real error. 4.25111.58: but do record that the
      // failure row itself did not land (the money side of a failed
      // call was silent here).
      platformLog("error", "spend_recorder_unreachable", { requestType: "text_generation", onErrorPath: true, error: recErr && recErr.message });
    }
    throw err;
  }
}

// ── Provider-aware key validation (validate before store) ─────
// One implementation serves registration and the owner admin
// screen. Valid means valid FOR THE SELECTED VENDOR: the key is
// presented to that Model Provider's models endpoint using the provider's
// own auth scheme, behind the same egress gate as generation.
// Returns { valid: true, models } or { valid: false, status }.
export async function validateProviderKey(providerId, apiKey, deps = {}) {
  const d = resolveDeps(deps);
  const provider = getProvider(providerId);
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw llmError(LLM_ERROR_CODES.INVALID_REQUEST, "API key required for validation");
  }
  const candidate = apiKey.trim();
  const url = resolveBaseUrl(provider, d.env) + provider.modelsPath;
  assertHostAllowed(url, d.getAllowedHosts(d.env));

  const headers = {};
  if (provider.authScheme === "x-api-key") {
    headers["x-api-key"] = candidate;
    if (provider.versionHeader) {
      const fromEnv = d.env && typeof d.env[provider.versionHeader.env] === "string"
        ? d.env[provider.versionHeader.env].trim()
        : "";
      headers[provider.versionHeader.name] = fromEnv || provider.versionHeader.default;
    }
  } else {
    headers.authorization = `Bearer ${candidate}`;
  }

  const res = await fetchWithTimeout(d, url, { method: "GET", headers }, provider.id, resolveTimeoutMs(d.env));
  if (res.status === 401 || res.status === 403) {
    return { valid: false, status: res.status };
  }
  const raw = await readModelProviderJson(res, provider.id);
  if (!raw || !Array.isArray(raw.data)) {
    throw llmError(LLM_ERROR_CODES.BAD_RESPONSE,
      `LLM provider ${provider.id} models listing has no data array`, { providerId: provider.id });
  }
  const pattern = provider.wireIdPattern ? new RegExp(provider.wireIdPattern) : null;
  const models = raw.data
    .filter((m) => m && typeof m.id === "string" && (!pattern || pattern.test(m.id)))
    .map((m) => ({
      id: m.id,
      name: (typeof m.display_name === "string" && m.display_name) || m.id,
      created: m.created_at ?? m.created ?? null
    }))
    .sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
  return { valid: true, models };
}
