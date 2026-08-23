// ═══════════════════════════════════════════════════════════════
// src/routes/admin-ai-api.js - owner AI Model Provider/model/key config
// ═══════════════════════════════════════════════════════════════
// Factory router mounted INSIDE admin-api.js, so every request has
// already passed requireAuth -> resolveTenant -> requireNoDevBypass
// -> requirePermission("manage_users"). A defense-in-depth owner
// check runs here as well: even mounted bare, these endpoints fail
// closed for anyone but a clean tenant owner.
//
//   GET /ai-config  Model Provider + model choices (from the registry, so
//                   the options track what the abstraction actually
//                   supports) plus the tenant's current selection
//                   and whether a key is stored (never the key).
//   PUT /ai-config  save provider + model (+ apiKey). The key is
//                   validated against the SELECTED Model Provider through
//                   the provider abstraction BEFORE it is stored;
//                   a key that fails validation is never persisted.
//                   Switching Model Provider without a stored or supplied
//                   key fails closed.
//
// Factory + injectable deps (project convention): defaults reach
// the real registry, orchestrator validator, tenant context, and
// encrypted credential store. DB-touching defaults load lazily so
// the module imports cleanly anywhere.
// ═══════════════════════════════════════════════════════════════

import { Router } from "express";
import { platformLog } from "../services/platform-log.js";
import { listProviders, listModels, getProvider, getModelProfile,
         textGenerationAvailability, textGenerationNotice,
         TEXT_GENERATION_NOTICE } from "../llm/registry.js";
import { validateProviderKey, resolveTenantLlmSelection } from "../llm/client.js";
import { validateModelProviderSelection, isModelProviderSelectionError } from "../llm/model-provider-selection.js";

async function defaultWithTenant(tenantId, fn) {
  const { withTenant } = await import("../db/with-tenant.js");
  return withTenant(tenantId, fn);
}
async function defaultGetState(key) {
  const { getAgentState } = await import("../services/database.js");
  return getAgentState(key);
}
async function defaultSetState(key, value) {
  const { setAgentState } = await import("../services/database.js");
  return setAgentState(key, value);
}
async function defaultHasKey(providerId) {
  const { hasLlmApiKey } = await import("../tenant/credential-store.js");
  return hasLlmApiKey(providerId);
}
async function defaultStoreKey(providerId, plaintext) {
  const { storeCredential, llmCredentialKeyFor } = await import("../tenant/credential-store.js");
  return storeCredential(llmCredentialKeyFor(providerId), plaintext);
}
async function defaultDeleteKey(providerId) {
  const { deleteCredential, llmCredentialKeyFor } = await import("../tenant/credential-store.js");
  return deleteCredential(llmCredentialKeyFor(providerId));
}
async function defaultHasPermission(role, permission) {
  const { hasPermission } = await import("../tenant/platform-db.js");
  return hasPermission(role, permission);
}

export function createAiConfigRoutes(overrides = {}) {
  const d = {
    env: overrides.env || process.env,
    listProviders: overrides.listProviders || listProviders,
    listModels: overrides.listModels || listModels,
    getProvider: overrides.getProvider || getProvider,
    getModelProfile: overrides.getModelProfile || getModelProfile,
    validateKey: overrides.validateKey || validateProviderKey,
    deleteKey: overrides.deleteKey || defaultDeleteKey,
    resolveSelection: overrides.resolveSelection || resolveTenantLlmSelection,
    withTenant: overrides.withTenant || defaultWithTenant,
    getState: overrides.getState || defaultGetState,
    setState: overrides.setState || defaultSetState,
    hasKey: overrides.hasKey || defaultHasKey,
    hasPermission: overrides.hasPermission || defaultHasPermission,
    storeKey: overrides.storeKey || defaultStoreKey,
    anthropicModelChain: overrides.anthropicModelChain,
    log: overrides.log || platformLog
  };

  const router = Router();

  // Defense in depth: the blanket admin chain already enforces the
  // owner permission; this guard keeps the endpoints fail-closed
  // even if the router were ever mounted outside that chain.
  router.use((req, res, next) => {
    if (!req.user || !req.user.sub || !req.tenant || !req.tenant.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.devBypass || req.tenant.role !== "owner") {
      return res.status(403).json({ error: "Permission denied" });
    }
    next();
  });

  // ── Read the choices and the current selection ──────────────
  // Payments (2.3.5), ruling 2026-07-14: Model Provider management is an
  // owner-only capability, explicit (manage_llm_vendor) rather
  // than inherited through the parent chain's manage_users.
  router.use(async (req, res, next) => {
    try {
      const role = req.tenant && req.tenant.role;
      if (role && await d.hasPermission(role, "manage_llm_vendor")) return next();
      return res.status(403).json({ error: "Managing the AI Model Provider requires owner access" });
    } catch {
      return res.status(403).json({ error: "Managing the AI Model Provider requires owner access" });
    }
  });

  router.get("/ai-config", async (req, res) => {
    try {
      const providers = d.listProviders(d.env)
        .filter((p) => p.configured)
        .map((p) => ({
          id: p.id,
          label: p.label,
          // 2.6.1: availability travels with the option so the page
          // renders the coming-soon note from server data, never from
          // a hardcoded client list. 2.6.5: the notice itself is
          // per-Model Provider data too, so each parked Model Provider tells its own
          // true story on the page.
          textGeneration: p.textGeneration || "available",
          textGenerationNotice: p.textGenerationNotice || TEXT_GENERATION_NOTICE,
          models: d.listModels(p.id, d.env)
        }));

      const current = { provider: null, model: null, hasKey: false };
      await d.withTenant(req.tenant.id, async () => {
        try {
          const selection = await d.resolveSelection({
            env: d.env,
            getState: d.getState,
            anthropicModelChain: d.anthropicModelChain
          });
          current.provider = selection.provider;
          current.model = selection.model;
        } catch {
          // Unprovisioned or unknown selection: report the raw
          // provider choice (or the compatibility default) with no
          // model, so the owner can complete it. Never guess.
          const raw = await d.getState("llm_provider");
          current.provider = (typeof raw === "string" && raw.trim()) || "anthropic";
        }
        try {
          current.hasKey = await d.hasKey(current.provider);
        } catch {
          current.hasKey = false;
        }
      });

      res.json({ providers, current });
    } catch (err) {
      d.log("error", "ai_config_read_failed", { error: err.message });
      res.status(500).json({ error: "Failed to load AI configuration" });
    }
  });

  // ── Save Model Provider + model (+ key), validate-before-store ──────
  router.put("/ai-config", async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const provider = body.provider;
      const model = body.model;
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

      // Zero Trust boundary, now enforced through the shared
      // validator (4.25111.17, closing refactor item 8) so this card
      // and the registration workflow can never diverge on what a
      // storable selection is. Check order is unchanged: provider
      // and model resolve in the registry, then the 2.6.1
      // availability gate (a Model Provider whose text generation is
      // not yet available can never become the workspace text
      // provider, and the 2.6.5 refusal carries that provider's OWN
      // notice), then validate-before-store on the key, so no Model
      // Provider call is spent on a refused selection. Key
      // validation stays authoritative here; the client-side check
      // is UX only. This does NOT gate key storage for the image
      // seam (Image Model section).
      let providerEntry;
      let profile;
      try {
        const validated = await validateModelProviderSelection({
          providerId: provider,
          modelId: typeof model === "string" ? model : "",
          apiKey: apiKey || null,
          env: d.env,
          validateKey: d.validateKey,
          getProviderFn: d.getProvider,
          getModelProfileFn: d.getModelProfile
        });
        providerEntry = validated.providerEntry;
        profile = validated.profile;
      } catch (err) {
        if (!isModelProviderSelectionError(err)) throw err;
        if (err.code === "UNKNOWN_PROVIDER" || err.code === "UNKNOWN_MODEL") {
          d.log("warn", "ai_config_rejected", { reason: "unknown_provider_or_model" });
          return res.status(400).json({ error: "Unknown provider or model selection" });
        }
        if (err.code === "TEXT_PROVIDER_COMING_SOON") {
          d.log("warn", "ai_config_rejected", {
            reason: "text_provider_coming_soon", provider: provider
          });
          return res.status(409).json({
            error: err.message,
            code: "TEXT_PROVIDER_COMING_SOON"
          });
        }
        if (err.code === "KEY_VALIDATION_UNAVAILABLE") {
          d.log("warn", "ai_config_key_validation_unavailable", {
            provider: provider, code: err.causeCode
          });
          return res.status(502).json({ error: "Unable to verify API key with the selected provider" });
        }
        // KEY_INVALID
        d.log("warn", "ai_config_rejected", { reason: "key_invalid_for_provider", provider: provider });
        return res.status(400).json({ error: "API key is not valid for the selected provider" });
      }

      const outcome = await d.withTenant(req.tenant.id, async () => {
        if (!apiKey) {
          const existing = await d.hasKey(providerEntry.id);
          if (!existing) return { ok: false };
        } else {
          await d.storeKey(providerEntry.id, apiKey);
        }
        await d.setState("llm_provider", providerEntry.id);
        await d.setState("llm_model", profile.modelId);
        if (providerEntry.id === "anthropic") {
          // Keep the pre-abstraction model chain coherent while the
          // cutover flag is off.
          await d.setState("anthropic_model", profile.modelId);
        }
        return { ok: true };
      });
      // 2.5.57 (F6): trial auto-retirement runs only AFTER the tenant
      // transaction committed. Retiring first and rolling back the
      // key store would strand the tenant with neither trial nor key.
      if (apiKey && (!outcome || outcome.ok !== false)) {
        const { retireTrialForStoredKey } = await import("../spend/trial-store.js");
        await retireTrialForStoredKey(req.tenant.id, providerEntry.id, req.user && req.user.sub, { log: d.log });
      }


      if (!outcome.ok) {
        d.log("warn", "ai_config_rejected", { reason: "no_key_for_provider", provider: providerEntry.id });
        return res.status(400).json({
          error: "An API key for this provider must be provided and validated before it can be selected"
        });
      }

      d.log("info", "ai_config_updated", {
        tenant: req.tenant.id, provider: providerEntry.id, model: profile.modelId, keyStored: !!apiKey
      });
      res.json({ success: true, provider: providerEntry.id, model: profile.modelId, hasKey: true, keyStored: !!apiKey });
    } catch (err) {
      d.log("error", "ai_config_update_failed", { error: err.message });
      res.status(500).json({ error: "Failed to update AI configuration" });
    }
  });

  // ── Remove the Model Provider selection (2.3.5) ─────────────────────
  // Clears the selection states so resolution falls back to the
  // platform default chain; removeKey=true also deletes the
  // stored credential for the removed provider. Honest outcome
  // either way: the response names what remains.
  router.delete("/ai-config", async (req, res) => {
    try {
      const removeKey = req.query.removeKey === "true";
      let removedProvider = null;
      await d.withTenant(req.tenant.id, async () => {
        const raw = await d.getState("llm_provider");
        removedProvider = (typeof raw === "string" && raw.trim()) || null;
        await d.setState("llm_provider", "");
        await d.setState("llm_model", "");
        if (removeKey && removedProvider) {
          await d.deleteKey(removedProvider);
        }
      });
      d.log("info", "ai_config_removed", { provider: removedProvider, keyRemoved: removeKey && !!removedProvider });
      res.json({ ok: true, removedProvider, keyRemoved: removeKey && !!removedProvider,
                 nowUsing: "platform default (anthropic chain) if configured" });
    } catch (err) {
      d.log("error", "ai_config_remove_failed", { error: err.message });
      res.status(500).json({ error: "Failed to remove the Model Provider selection" });
    }
  });

  return router;
}
