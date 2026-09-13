// ═══════════════════════════════════════════════════════════════
// src/routes/registration-catalog.js: the vendor and model catalog
// a new customer chooses from
// ═══════════════════════════════════════════════════════════════
// 4.25111.98 (defect D84-2). Until now the register page offered a
// vendor list hardcoded in its template and filled its model list
// from the Model Provider's live catalog returned by validate-key,
// while the /app/admin card offers the registry's configured
// providers (with the coming-soon note) and the registry's models
// (GET /api/admin/ai-config in admin-ai-api.js). A customer setting
// up a workspace could therefore pick a parked vendor, or a model
// the registry refuses at /api/register/complete, and never saw the
// choices the owner sees afterwards.
//
// This module answers the SAME catalog for the registration door:
// configured providers, id, label, availability, notice, registry
// models, in the registry's order. It is a deliberate duplicate of
// the admin card's mapping (owner's ruling, 2026-09-13: duplication
// is acceptable here), not an import from it: the two routers stay
// separately mounted (owner session versus registration token) and
// neither reaches into the other. If the mapping changes on one
// side it must change here too; test-register-catalog1-design pins
// both against the registry.
//
// Served ONLY on the token-authorized init answer
// (POST /api/register/init, after validateRegistrationToken), never
// on an anonymous route. Pure: registry reads, no database, no log,
// no network. Nothing here names a credential.
// ═══════════════════════════════════════════════════════════════

import { listProviders, listModels, TEXT_GENERATION_NOTICE } from "../llm/registry.js";

export function registrationProviderCatalog(env = process.env) {
  return listProviders(env)
    .filter((p) => p.configured)
    .map((p) => ({
      id: p.id,
      label: p.label,
      textGeneration: p.textGeneration || "available",
      textGenerationNotice: p.textGenerationNotice || TEXT_GENERATION_NOTICE,
      models: listModels(p.id, env)
    }));
}
