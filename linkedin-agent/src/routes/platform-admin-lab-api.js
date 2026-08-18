// =================================================================
// src/routes/platform-admin-lab-api.js - Generation Lab (Phase 1)
// =================================================================
// Mounted INSIDE the platform-admin router, AFTER its router-level
// requireAuth + requirePlatformAdmin, so every route here inherits
// both gates. There is no tenant-facing path to this surface.
//
// Phase 1 exposes ONE route:
//
//   GET /lab/meta?tenantId=<uuid>
//     Everything the Run Setup selectors need to populate and to
//     default correctly. Read only. No vendor call, no spend, no
//     write of any kind.
//
// Every value is read through a function that already exists and is
// already the source of truth for that value elsewhere in the
// product. Nothing here reimplements a lookup:
//
//   topics + angles   getTopicsForGeneration (tenant/topic-store)
//   genres            listGenresForKey       (services/prompt-vault)
//   corroboration     getAgentState          (services/database)
//   provider + model  resolveTenantLlmSelection (llm/client)
//   provider catalog  listProviders          (llm/registry)
//   model catalog     listModels             (llm/registry)
//   research tools    listWebSearchTools     (config/ai)
//   home tenant       findTenantByAuthIdentity (tenant/platform-db)
//
// Zero Trust:
//   - Both gates inherited from the parent router.
//   - tenantId is validated as a UUID BEFORE it reaches withTenant,
//     which is the only way tenant scoped reads happen here. RLS
//     applies inside that block exactly as it does in production.
//   - NO secret is returned. Not an API key, not a key fingerprint,
//     not prompt plaintext. listGenresForKey reads metadata only and
//     never touches prompt_vault.value_enc.
//   - Responses are no-store: this is per-request operator material.
//   - Errors are generic to the client and detailed only in the
//     platform log.
// =================================================================
import express from "express";
import { withTenant } from "../db/with-tenant.js";
import { getTopicsForGeneration } from "../tenant/topic-store.js";
import { getAgentState } from "../services/database.js";
import { listGenresForKey } from "../services/prompt-vault.js";
import { listProviders, listModels } from "../llm/registry.js";
import { resolveTenantLlmSelection } from "../llm/client.js";
import { listWebSearchTools, getWebSearchTool } from "../config/ai.js";
import { findTenantByAuthIdentity } from "../tenant/platform-db.js";
import { platformLog } from "../services/platform-log.js";

// The rewrite prompt lives under the content_generator key as this
// reserved genre. It is a rewrite instruction over an EXISTING post,
// not a content style, so it is filtered exactly as compose-api
// filters it. Unlike the composer, metric bearing genres ARE offered
// here: the Lab exists to exercise the pipeline, and the metric
// block is part of the pipeline.
const INTERNAL_REFINE_GENRE = "refine";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors resolver.js: the platform-admin router does not run the
// tenant resolver, so req.tenant does not exist here and the caller's
// own membership has to be looked up directly.
function inferProvider(sub) {
  if (!sub || typeof sub !== "string") return null;
  if (sub.startsWith("auth0|") || sub.startsWith("google-oauth2|")) return "auth0";
  if (sub.startsWith("user_")) return "workos";
  return null;
}

// The tenant the signed in admin belongs to, or null when the admin
// holds no membership. A null is a legitimate answer, not an error:
// the selector simply falls back to the first tenant in the list.
async function resolveHomeTenantId(user) {
  const sub = user && user.sub;
  const provider = (user && user.provider) || inferProvider(sub);
  if (!sub || !provider) return null;
  try {
    const tenant = await findTenantByAuthIdentity(provider, sub);
    return tenant ? tenant.id : null;
  } catch (err) {
    platformLog("warn", "lab_home_tenant_lookup_failed", { error: err.message });
    return null;
  }
}

// agent_state llm_provider / llm_model, resolved the SAME way
// generation resolves them so the page reports what a run would
// actually use rather than what is merely stored.
//
// Provider and model are returned BOTH SET or BOTH EMPTY. A partial
// selection (provider chosen, model never set) makes the resolver
// throw NOT_PROVISIONED; reporting the provider alone would put half
// an unusable selection on screen as though it were usable.
async function resolveCurrentSelection() {
  try {
    const selection = await resolveTenantLlmSelection();
    return { provider: selection.provider, model: selection.model };
  } catch (err) {
    return { provider: "", model: "" };
  }
}

export default function createPlatformAdminLabRoutes() {
  const router = express.Router();

  // Per-run operator material: never cached, never revalidated.
  router.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // ── GET /lab/meta ─────────────────────────────────────────────
  router.get("/meta", async (req, res) => {
    const tenantId = String(req.query.tenantId || "");
    if (!UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: "A valid tenantId is required", code: "INVALID_TENANT_ID" });
    }
    try {
      // Tenant scoped reads, under RLS, exactly as production reads.
      const scoped = await withTenant(tenantId, async () => {
        const topics = await getTopicsForGeneration(null);
        return {
          topics: (topics || []).map((t) => ({
            id: t.slug,
            label: t.name || t.slug,
            angles: Array.isArray(t.content_angles) ? t.content_angles : []
          })),
          // agent_state reads enabled unless the row says disabled,
          // the same test content-generator applies.
          corroboration: (await getAgentState("corroboration")) !== "disabled",
          current: await resolveCurrentSelection()
        };
      });

      // Platform wide reads: no tenant scope, no ciphertext.
      const genres = (await listGenresForKey("content_generator"))
        .filter((g) => g.genre !== INTERNAL_REFINE_GENRE)
        .map((g) => g.genre);

      // Only providers this deployment can actually reach. The
      // parked ones are RETURNED, carrying their own notice, so the
      // page can show them disabled: a hidden vendor is an absence
      // the operator cannot explain.
      const providers = listProviders(process.env)
        .filter((p) => p.configured)
        .map((p) => ({
          id: p.id,
          label: p.label,
          textGeneration: p.textGeneration || "available",
          textGenerationNotice: p.textGenerationNotice || null
        }));

      const models = {};
      for (const p of providers) {
        models[p.id] = listModels(p.id, process.env).map((m) => ({ id: m.id, label: m.label }));
      }

      res.json({
        homeTenantId: await resolveHomeTenantId(req.user),
        topics: scoped.topics,
        genres: genres.length ? genres : ["default"],
        corroboration: scoped.corroboration,
        providers,
        models,
        current: scoped.current,
        research: { tools: listWebSearchTools(), current: getWebSearchTool() }
      });
    } catch (err) {
      platformLog("error", "lab_meta_failed", { tenantId, error: err.message });
      res.status(500).json({ error: "Could not load run setup" });
    }
  });

  return router;
}
