// ═══════════════════════════════════════════════════════════════
// src/routes/admin-ai-api.js - owner AI vendor/model/key config
// ═══════════════════════════════════════════════════════════════
// Factory router mounted INSIDE admin-api.js, so every request has
// already passed requireAuth -> resolveTenant -> requireNoDevBypass
// -> requirePermission("manage_users"). A defense-in-depth owner
// check runs here as well: even mounted bare, these endpoints fail
// closed for anyone but a clean tenant owner.
//
//   GET /ai-config  vendor + model choices (from the registry, so
//                   the options track what the abstraction actually
//                   supports) plus the tenant's current selection
//                   and whether a key is stored (never the key).
//   PUT /ai-config  save provider + model (+ api_key). The key is
//                   validated against the SELECTED vendor through
//                   the provider abstraction BEFORE it is stored;
//                   a key that fails validation is never persisted.
//                   Switching vendor without a stored or supplied
//                   key fails closed.
//
// Factory + injectable deps (project convention): defaults reach
// the real registry, orchestrator validator, tenant context, and
// encrypted credential store. DB-touching defaults load lazily so
// the module imports cleanly anywhere.
// ═══════════════════════════════════════════════════════════════

import { Router } from "express";
import { platformLog } from "../services/platform-log.js";
import { listProviders, listModels, getProvider, getModelProfile } from "../llm/registry.js";
import { validateProviderKey, resolveTenantLlmSelection } from "../llm/client.js";

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
  // Payments (2.3.5), ruling 2026-07-14: vendor management is an
  // owner-only capability, explicit (manage_llm_vendor) rather
  // than inherited through the parent chain's manage_users.
  router.use(async (req, res, next) => {
    try {
      const { hasPermission } = await import("../tenant/platform-db.js");
      const role = req.tenant && req.tenant.role;
      if (role && await hasPermission(role, "manage_llm_vendor")) return next();
      return res.status(403).json({ error: "Managing the AI vendor requires owner access" });
    } catch {
      return res.status(403).json({ error: "Managing the AI vendor requires owner access" });
    }
  });

  router.get("/ai-config", async (req, res) => {
    try {
      const providers = d.listProviders(d.env)
        .filter((p) => p.configured)
        .map((p) => ({
          id: p.id,
          label: p.label,
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

  // ── Save vendor + model (+ key), validate-before-store ──────
  router.put("/ai-config", async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const provider = body.provider;
      const model = body.model;
      const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";

      // Zero Trust boundary: the selection must resolve in the
      // registry or the request dies here, before any side effect.
      let providerEntry;
      let profile;
      try {
        providerEntry = d.getProvider(provider);
        profile = d.getModelProfile(providerEntry.id, typeof model === "string" ? model.trim() : "", d.env);
      } catch {
        d.log("warn", "ai_config_rejected", { reason: "unknown_provider_or_model" });
        return res.status(400).json({ error: "Unknown provider or model selection" });
      }

      // Authoritative validate-before-store. The client-side check
      // is UX only; this is the gate that counts.
      if (apiKey) {
        let verdict;
        try {
          verdict = await d.validateKey(providerEntry.id, apiKey);
        } catch (err) {
          d.log("warn", "ai_config_key_validation_unavailable", {
            provider: providerEntry.id, code: err && err.code ? err.code : null
          });
          return res.status(502).json({ error: "Unable to verify API key with the selected provider" });
        }
        if (!verdict || verdict.valid !== true) {
          d.log("warn", "ai_config_rejected", { reason: "key_invalid_for_provider", provider: providerEntry.id });
          return res.status(400).json({ error: "API key is not valid for the selected provider" });
        }
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

  // ── Remove the vendor selection (2.3.5) ─────────────────────
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
      res.status(500).json({ error: "Failed to remove the vendor selection" });
    }
  });

  return router;
}
