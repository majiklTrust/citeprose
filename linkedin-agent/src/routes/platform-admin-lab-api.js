// =================================================================
// src/routes/platform-admin-lab-api.js - Generation Lab (Phase 1)
// =================================================================
// Mounted INSIDE the platform-admin router, AFTER its router-level
// requireAuth + requirePlatformAdmin, so every route here inherits
// both gates. There is no tenant-facing path to this surface.
//
// Two routes:
//
//   GET /lab/meta[?tenantId=<uuid>]
//     Everything the Run Setup selectors need to populate and to
//     default correctly. Read only. No vendor call, no write.
//
//     tenantId is OPTIONAL. Omit it and the route resolves the
//     signed in admin's own tenant and reports which one it used.
//     That is what stops the page guessing: the admin's home tenant
//     is a property of the CALLER, not of a tenant, so requiring a
//     tenantId to learn it forced the page to pick one at random,
//     ask, discover it picked wrong, and ask again. One request now
//     answers correctly the first time.
//
//   POST /lab/run
//     Executes the REAL pipeline against REAL tenant data with the
//     vendor calls SUBSTITUTED. Sequencing stays entirely inside
//     generatePost and conductResearch; the Lab supplies a trace
//     collector and a stand in vendor, then reads what the pipeline
//     announced. The Lab never drives the order of anything.
//
//     A run WRITES NOTHING. The pipeline makes activity_log inserts
//     as it goes; the whole run is deliberately rolled back so a
//     developer tool cannot leave rows in a customer's activity log
//     for work that customer did not request. Reads are unaffected,
//     and platform logging is on its own connection so operator
//     audit survives. See runAndRollback below.
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
import { createGenerationTrace, runWithGenerationTrace } from "../services/generation-trace.js";
import { createLabVendorMock } from "../services/lab-vendor-mock.js";
import { generatePost, qualityCheck } from "../services/content-generator.js";
import { getTopicsForGeneration, getTopicBySlug } from "../tenant/topic-store.js";
import { getAgentState } from "../services/database.js";
import { listGenresForKey, getPromptProvenance } from "../services/prompt-vault.js";
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


const GENRE_RE = /^(default|[a-z][a-z0-9_]{1,31})$/;

// The stage ids the page's call sequence knows about, mapped to the
// pipeline function each belongs to. The page renders its spine from
// its own static structure; this is how an announced record finds
// the row it belongs to.
const STAGE_TO_CALL = Object.freeze({
  angle_resolved:         "resolveAngle",
  db_articles:            "gatherRSSMaterial",
  search_queries:         "buildQueries",
  web_search_request:     "webSearch",
  web_search_response:    "webSearch",
  corroboration_sources:  "assembleSources",
  corroboration_request:  "corroborate",
  corroboration_response: "corroborate",
  research_brief:         "buildBrief",
  // research_block belongs to the GENERATION side: it is the brief
  // rendered through the research_brief_* vault template, which is
  // what the generator actually receives. Mapping it to buildBrief
  // silently overwrote the finished brief, so it lands on its own
  // row instead.
  research_block:         "researchBlock",
  metric_block:           "metricBlock",
  generation_request:     "generateContent",
  generation_response:    "generateContent",
  fidelity:               "fidelity",
  quality_request:        "qualityCheck",
  quality_response:       "qualityCheck"
});

// Fold the flat announcement stream into per call records the page
// can drop straight into its inspector. A *_request record fills the
// Request tab, a *_response record fills the Response tab, and
// anything else is what the call was assembled from.
function indexStages(trace) {
  const byCall = {};
  for (const record of trace.toJSON().stages) {
    const callId = STAGE_TO_CALL[record.id];
    if (!callId) continue;
    const slot = byCall[callId] || (byCall[callId] = { status: "done", durMs: 0 });
    if (record.id.endsWith("_request")) slot.request = { caption: "What this call was sent.", data: record.data };
    else if (record.id.endsWith("_response")) slot.response = { caption: "What came back, raw and parsed.", data: record.data };
    else slot.assembled = { caption: "What this call was assembled from.", data: record.data };
    slot.durMs = record.atMs;
  }
  return byCall;
}

// The vault rows this run's prompts actually came from. Genre applies
// only to content_generator; every other key is genre invariant, which
// is exactly how the pipeline reads them.
async function collectPromptSlots(genre, generated) {
  const corroborated = !(generated && generated.researchSummary && generated.researchSummary.corroborationSkipped);
  const wanted = [
    ["research_assistant", "default"],
    ["corroboration_analyst", "default"],
    [corroborated ? "research_brief_corroborated" : "research_brief_uncorroborated", "default"],
    ["content_generator", genre],
    ["quality_reviewer", "default"]
  ];
  const slots = [];
  for (const [key, g] of wanted) {
    let provenance = null;
    try {
      provenance = await getPromptProvenance(key, g);
    } catch (err) {
      platformLog("warn", "lab_prompt_slot_failed", { key, genre: g, error: err.message });
    }
    slots.push(provenance
      ? { key, requestedGenre: g, present: true,
          resolvedGenre: provenance.resolvedGenre, fallback: provenance.fallback,
          description: provenance.description, updatedAt: provenance.updatedAt,
          metricBearing: provenance.metricBearing, fingerprint: provenance.fingerprint,
          placeholders: [...new Set(provenance.template.match(/{{[A-Z_]+}}/g) || [])],
          template: provenance.template }
      : { key, requestedGenre: g, present: false });
  }
  return slots;
}

// Set an agent_state value INSIDE the current transaction only. The
// row never survives, because the transaction is rolled back.
async function setAgentStateInTransaction(key, value) {
  const { currentClient } = await import("../db/with-tenant.js");
  await currentClient().query(
    `INSERT INTO agent_state (tenant_id, key, value) VALUES (current_tenant_id(), $1, $2)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    [key, value]
  );
}

// Run inside a tenant transaction and ALWAYS roll it back.
//
// withTenant commits when its callback returns and rolls back when
// it throws. A Lab run must never leave rows behind, so the result
// is carried out on a sentinel error: the rollback is the normal
// path here, not the failure path. Reads inside the transaction are
// unaffected, and platformLog writes on its own connection so the
// operator audit trail survives.
class LabRunComplete extends Error {
  constructor(value) { super("lab run complete"); this.value = value; }
}

async function runAndRollback(tenantId, fn) {
  try {
    await withTenant(tenantId, async () => { throw new LabRunComplete(await fn()); });
  } catch (err) {
    if (err instanceof LabRunComplete) return err.value;
    throw err;
  }
  // Unreachable: the callback always throws.
  throw new Error("Lab run did not complete");
}

export default function createPlatformAdminLabRoutes() {
  const router = express.Router();

  // Per-run operator material: never cached, never revalidated.
  router.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // ── GET /lab/meta ─────────────────────────────────────────────
  router.get("/meta", async (req, res) => {
    const requested = String(req.query.tenantId || "");
    if (requested && !UUID_RE.test(requested)) {
      return res.status(400).json({ error: "A valid tenantId is required", code: "INVALID_TENANT_ID" });
    }
    const homeTenantId = await resolveHomeTenantId(req.user);
    // No explicit choice falls back to the caller's own tenant. An
    // admin who holds no membership has no home to fall back to, and
    // the route refuses rather than picking a tenant on their behalf.
    const tenantId = requested || homeTenantId || "";
    if (!tenantId) {
      return res.status(400).json({
        error: "No tenant selected, and this account holds no tenant membership to default to",
        code: "NO_HOME_TENANT",
        homeTenantId: null
      });
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
        // Which tenant this payload actually describes, and which one
        // the caller belongs to. They differ whenever the operator
        // has switched away from their own.
        tenantId,
        homeTenantId,
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

  // ── POST /lab/run ─────────────────────────────────────────────
  // Body: { tenantId, topicId, angle?, genre?, corroboration? }
  //
  // Provider, model and research tool are shown on the page but are
  // NOT honoured here: Phase 2 substitutes the vendor entirely, so
  // claiming to route to a vendor would be false. Phase 3 makes them
  // live.
  router.post("/run", async (req, res) => {
    const body = req.body || {};
    const tenantId = String(body.tenantId || "");
    const topicId = String(body.topicId || "");
    if (!UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: "A valid tenantId is required", code: "INVALID_TENANT_ID" });
    }
    if (!topicId) {
      return res.status(400).json({ error: "A topic is required", code: "TOPIC_REQUIRED" });
    }
    const genre = typeof body.genre === "string" && GENRE_RE.test(body.genre) ? body.genre : "default";
    if (genre === INTERNAL_REFINE_GENRE) {
      return res.status(400).json({ error: "The refine genre is a rewrite instruction, not a content style", code: "RESERVED_GENRE" });
    }
    const angle = typeof body.angle === "string" && body.angle.trim() ? body.angle.trim() : null;
    const forceCorroboration = body.corroboration === "on" ? true
      : body.corroboration === "off" ? false : null;

    const trace = createGenerationTrace();
    try {
      const out = await runAndRollback(tenantId, async () => {
        const topic = await getTopicBySlug(topicId);
        if (!topic) {
          const e = new Error(`Topic not found: ${topicId}`);
          e.labStatus = 404;
          throw e;
        }
        // Corroboration is a tenant setting the pipeline reads for
        // itself. Honouring the operator's choice means setting that
        // value inside the rolled back transaction, so the pipeline
        // reads it the ordinary way and the tenant's stored value is
        // never actually changed.
        if (forceCorroboration !== null) {
          await setAgentStateInTransaction("corroboration", forceCorroboration ? "enabled" : "disabled");
        }

        const vendor = createLabVendorMock({ topicName: topic.name || topic.slug, angle: angle || "" });

        // The pipeline sequences itself. The Lab supplies a collector
        // and a stand in vendor, then reads what was announced.
        const result = await runWithGenerationTrace({ trace, vendor }, async () => {
          const generated = await generatePost(topicId, req.user?.sub || null, null, angle, genre);
          let quality = null;
          if (!generated.blocked) {
            quality = await qualityCheck(generated.content, generated.researchSummary || null, generated.cycleId);
          }
          return { generated, quality };
        });

        // Which vault row served each prompt this run used. Read
        // AFTER the run so a genre fallback is reported as it
        // actually resolved.
        const promptSlots = await collectPromptSlots(genre, result.generated);
        return { ...result, promptSlots };
      });

      platformLog("info", "lab_run_complete", {
        tenantId, topicId, genre,
        blocked: !!out.generated.blocked,
        stages: trace.toJSON().stages.length
      });
      res.json({
        result: out.generated,
        quality: out.quality,
        promptSlots: out.promptSlots,
        stages: indexStages(trace),
        trace: trace.toJSON()
      });
    } catch (err) {
      const status = err && err.labStatus ? err.labStatus : 500;
      platformLog("error", "lab_run_failed", { tenantId, topicId, error: err.message });
      res.status(status).json({
        error: status === 404 ? err.message : `Lab run failed: ${err.message}`,
        stages: indexStages(trace),
        trace: trace.toJSON()
      });
    }
  });

  return router;
}
