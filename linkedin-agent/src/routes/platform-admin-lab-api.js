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
//     default correctly. Read only. No Model Provider call, no write.
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
//     Executes the REAL pipeline against REAL tenant data with REAL
//     Model Provider calls on the PLATFORM key (Phase 3; the header
//     said "substituted" long after the mock was retired, corrected
//     4.25111.20). Sequencing stays entirely inside generatePost and
//     conductResearch; the Lab supplies a trace collector, the
//     credential and routing, then reads what the pipeline
//     announced. The Lab never drives the order of anything.
//
//     A run leaves NO TENANT CONTENT behind. As of 4.25111.21 that
//     is PREVENTION, not destruction: activity_log writes are
//     suppressed at the source under the Lab frame, the forced
//     corroboration choice rides the frame instead of being written,
//     and so the run's transaction holds no tenant writes and no
//     locks at all. The rollback in runAndRollback REMAINS as
//     defense in depth for any future write nobody gated. Two
//     record classes deliberately persist (ruling 2026-08-24: real
//     spend is always recorded): llm_spend_events and
//     llm_activations rows, written by the spend recorder in its
//     own transaction and attributed to key_source 'platform' /
//     workflow 'generation_lab' by the recorder's lab seam, and
//     platform_log audit lines, written on their own pooled
//     connection.
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
import { getPlatformApiKey } from "../config/platform-keys.js";
import { getProvider, getModelProfile, estimateCostUsd } from "../llm/registry.js";
import { generatePost, qualityCheck } from "../services/content-generator.js";
import { getTopicsForGeneration, getTopicBySlug } from "../tenant/topic-store.js";
import { getAgentState } from "../services/database.js";
import { listGenresForKey, getPromptProvenance, templateUsesMetricBlock } from "../services/prompt-vault.js";
import { listProviders, listModels } from "../llm/registry.js";
import { resolveTenantLlmSelection, isLlmAbstractionEnabled } from "../llm/client.js";
import { findTenantByAuthIdentity } from "../tenant/platform-db.js";
import { keyFingerprintOf } from "../spend/key-resolver.js";
import { annotateActivation } from "../spend/activation-middleware.js";
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

// Prompt keys the pipeline knows how to substitute. Adding a key here
// without adding the matching substitution in the pipeline would make
// the Lab accept an override it then ignores, so the two move
// together.
const OVERRIDABLE_PROMPTS = Object.freeze(new Set(["content_generator"]));
const MAX_OVERRIDE_CHARS = 100000;

// The stage ids the page's call sequence knows about, mapped to the
// pipeline function each belongs to. The page renders its spine from
// its own static structure; this is how an announced record finds
// the row it belongs to.
// An id ending in _arguments belongs to whichever row its prefix
// names, so this map needs no entry per row for them.
const ARGUMENTS_SUFFIX = "_arguments";

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

// ── Run cost (4.25111.20) ────────────────────────────────────
// The four crossings that spend money, in pipeline order. The cost
// summary reads the SAME folded records the inspector reads, so the
// two can never disagree about what a call reported.
const COSTED_CALLS = Object.freeze(["webSearch", "corroborate", "generateContent", "qualityCheck"]);

// Usage arrives in two dialects: the raw SDK's snake_case on the
// research crossings and the orchestrator's camelCase on generation
// and quality. One normalizer, applied at fold time, so neither
// dialect leaks to the page.
function normalizeUsage(u) {
  if (!u || typeof u !== "object") return null;
  const pick = (...vals) => { for (const v of vals) if (Number.isFinite(v)) return v; return null; };
  const norm = {
    inputTokens: pick(u.promptTokens, u.inputTokens, u.input_tokens),
    outputTokens: pick(u.completionTokens, u.outputTokens, u.output_tokens),
    cacheReadTokens: pick(u.cacheReadTokens, u.cache_read_input_tokens),
    cacheWriteTokens: pick(u.cacheWriteTokens, u.cache_creation_input_tokens)
  };
  return (norm.inputTokens === null && norm.outputTokens === null) ? null : norm;
}

// Per-stage and total token spend with dollar estimates. A lab run
// is one model on the platform key throughout, so ONE resolved
// profile prices every crossing, including the two research calls
// that bypass the orchestrator's own estimate. Rules the page
// relies on: a null estimate means UNPRICED, never zero; the totals
// carry how many usage-bearing stages went unpriced; and the
// web_search_requests count is a separately billed axis with no
// price entry, totaled but never folded into the dollar figure.
function buildRunCost(byCall, profile, provider, model) {
  const perStage = [];
  const totals = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    webSearchRequests: 0, costEstimateUsd: 0, pricedStages: 0, unpricedStages: 0
  };
  let sawCost = false;
  for (const call of COSTED_CALLS) {
    const slot = byCall[call];
    if (!slot) continue;
    const data = slot.response && slot.response.data;
    const rawUsage = data && data.usage;
    const usage = normalizeUsage(rawUsage);
    const webSearchRequests = rawUsage && rawUsage.server_tool_use
      && Number.isFinite(rawUsage.server_tool_use.web_search_requests)
      ? rawUsage.server_tool_use.web_search_requests : null;
    // The orchestrator's own estimate is authoritative when the
    // stage carried one; the profile prices the research stages.
    let costEstimateUsd = data && Number.isFinite(data.costEstimateUsd) ? data.costEstimateUsd : null;
    if (costEstimateUsd === null && usage && profile) {
      const est = estimateCostUsd(profile, {
        promptTokens: usage.inputTokens, completionTokens: usage.outputTokens
      });
      costEstimateUsd = Number.isFinite(est) ? est : null;
    }
    perStage.push({
      call, status: slot.status || "done",
      usage, webSearchRequests, costEstimateUsd,
      priced: costEstimateUsd !== null
    });
    if (usage) {
      totals.inputTokens += usage.inputTokens || 0;
      totals.outputTokens += usage.outputTokens || 0;
      totals.cacheReadTokens += usage.cacheReadTokens || 0;
      totals.cacheWriteTokens += usage.cacheWriteTokens || 0;
      if (costEstimateUsd === null) totals.unpricedStages += 1;
    }
    if (webSearchRequests) totals.webSearchRequests += webSearchRequests;
    if (costEstimateUsd !== null) {
      totals.costEstimateUsd += costEstimateUsd;
      totals.pricedStages += 1;
      sawCost = true;
    }
  }
  totals.costEstimateUsd = sawCost ? Math.round(totals.costEstimateUsd * 1e6) / 1e6 : null;
  return { provider, model, keySource: "platform", perStage, totals };
}

// Fold the flat announcement stream into per call records the page
// can drop straight into its inspector. A *_request record fills the
// Request tab, a *_response record fills the Response tab, and
// anything else is what the call was assembled from.
function indexStages(trace) {
  const byCall = {};
  for (const record of trace.toJSON().stages) {
    // Argument records name their own row in the id prefix, so they
    // are resolved directly rather than through the map.
    if (record.id.endsWith(ARGUMENTS_SUFFIX)) {
      const argRow = record.id.slice(0, -ARGUMENTS_SUFFIX.length);
      const argSlot = byCall[argRow] || (byCall[argRow] = { status: "done", durMs: null });
      argSlot.args = { data: record.data };
      continue;
    }
    const callId = STAGE_TO_CALL[record.id];
    if (!callId) continue;
    const slot = byCall[callId] || (byCall[callId] = { status: "done", durMs: null });
    if (record.id.endsWith("_request")) slot.request = { data: record.data };
    else if (record.id.endsWith("_response")) {
      slot.response = { data: record.data };
      // A stage that announced its own failure marks the ROW failed,
      // so the sequence shows where the run broke instead of a row
      // that merely looks finished.
      if (record.data && record.data.failed) {
        slot.status = "failed";
        slot.error = record.data.error || record.data.note || record.data.reason || "(no detail)";
      }
    }
    else slot.assembled = { data: record.data };
    // 4.25111.16 (refactor item 1). durMs is the SUM of the MEASURED
    // durations this call's records carry, or null when none was
    // measured, which the page shows as blank. The old line here,
    // slot.durMs = record.atMs, stored a point on the run's clock
    // under a duration's name: every row showed how far into the run
    // its last record landed, so numbers grew monotonically down the
    // spine and the last row always wore the whole run's wall time.
    if (Number.isFinite(record.tookMs)) {
      slot.durMs = (slot.durMs || 0) + record.tookMs;
    }
  }
  // One rounding pass at the end so repeated additions cannot
  // accumulate rounding error mid-fold.
  for (const slot of Object.values(byCall)) {
    if (Number.isFinite(slot.durMs)) slot.durMs = Math.round(slot.durMs);
  }
  crossReference(byCall);
  return byCall;
}

// A parameter whose value is byte identical to something already
// shown elsewhere on the SAME row is replaced by a pointer to it.
// Without this, the Arguments tab for a generation call becomes a
// second full copy of the assembled prompt already on the Request
// tab, which is the largest payload on the page.
function crossReference(byCall) {
  for (const row of Object.values(byCall)) {
    const args = row.args && row.args.data;
    if (!args || !Array.isArray(args.params)) continue;
    for (const param of args.params) {
      if (typeof param.value === "string" && param.value.length > 200) {
        const where = findElsewhere(row, param.value);
        if (where) { param.value = null; param.sameAs = where; }
        continue;
      }
      if (param.value && typeof param.value === "object") {
        for (const key of Object.keys(param.value)) {
          const inner = param.value[key];
          if (typeof inner !== "string" || inner.length <= 200) continue;
          const where = findElsewhere(row, inner);
          if (where) param.value[key] = `[identical to the ${where} tab, not repeated]`;
        }
      }
    }
  }
}

function findElsewhere(row, text) {
  for (const [slot, label] of [["request", "Request"], ["response", "Response"], ["assembled", "Assembled From"]]) {
    const data = row[slot] && row[slot].data;
    if (data && typeof data === "object" && Object.values(data).some((v) => v === text)) return label;
  }
  return null;
}

// The vault rows this run's prompts actually came from. Genre applies
// only to content_generator; every other key is genre invariant, which
// is exactly how the pipeline reads them.
// Which call sequence row each vault key belongs to. Every key the
// slot plan lists appears here exactly once, so a prompt is always
// attributable to the call that read it and no prompt is orphaned.
//
// researchBlock carries three: the brief template plus the two
// framing prompts, because frameUntrustedContent wraps the research
// context immediately before that render.
const PROMPT_TO_CALL = Object.freeze({
  research_assistant:            "webSearch",
  corroboration_analyst:         "corroborate",
  untrusted_content_prefix:      "researchBlock",
  untrusted_content_suffix:      "researchBlock",
  research_brief_corroborated:   "researchBlock",
  research_brief_uncorroborated: "researchBlock",
  content_generator:             "generateContent",
  quality_reviewer:              "qualityCheck"
});

// Hang each slot's identity on the row that read it. Only identity:
// key, genres and the fallback flag. The template itself stays in the
// Prompt Slots panel, so the inspector says WHICH prompt without
// duplicating the panel that shows it.
function attachPromptsToCalls(byCall, slots) {
  for (const slot of slots || []) {
    const callId = PROMPT_TO_CALL[slot.key];
    if (!callId) continue;
    const row = byCall[callId] || (byCall[callId] = { status: "done", durMs: null });
    (row.prompts || (row.prompts = [])).push({
      key: slot.key,
      present: slot.present,
      requestedGenre: slot.requestedGenre,
      resolvedGenre: slot.resolvedGenre || null,
      fallback: !!slot.fallback
    });
  }
  return byCall;
}

// The vault keys a run reads, in pipeline order.
//
// HARDCODED, and therefore the one thing here that can go stale. A
// prompt added to the pipeline is invisible in this panel until this
// list is updated. When adding a prompt, check all THREE files that
// read the vault during a run:
//   src/services/research.js          research_assistant,
//                                     corroboration_analyst
//   src/services/prompt-framing.js    untrusted_content_prefix,
//                                     untrusted_content_suffix
//   src/services/content-generator.js research_brief_*,
//                                     content_generator, quality_reviewer
//
// Only content_generator is genre-aware; every other key is read at
// the default genre because that is what the pipeline requests.
// EVERY prompt the pipeline can read, in pipeline order. No
// conditions: this is a catalogue of what exists, not a record of
// what ran. Both brief variants appear even though only one can serve
// a given run, because both exist in the vault and the panel lists
// the vault.
//
// Which of these a RUN actually read is answered separately, by
// usedInRun below, from the trace. Keeping the two apart is what lets
// the page show the full set on load and mark the used ones after.
function slotPlan(genre) {
  return [
    ["research_assistant", "default"],
    ["corroboration_analyst", "default"],
    ["untrusted_content_prefix", "default"],
    ["untrusted_content_suffix", "default"],
    ["research_brief_corroborated", "default"],
    ["research_brief_uncorroborated", "default"],
    ["content_generator", genre],
    ["quality_reviewer", "default"]
  ];
}

// The subset a run read. Corroboration decides both the analyst and
// which brief serves, so it decides this whole answer.
function usedInRun(corroborated) {
  return corroborated
    ? ["research_assistant", "corroboration_analyst", "untrusted_content_prefix",
       "untrusted_content_suffix", "research_brief_corroborated",
       "content_generator", "quality_reviewer"]
    : ["research_assistant", "untrusted_content_prefix", "untrusted_content_suffix",
       "research_brief_uncorroborated", "content_generator", "quality_reviewer"];
}

/**
 * The vault rows this run's prompts actually came from.
 *
 * Whether corroboration ran is taken from the TRACE, not inferred
 * from the result object. The trace records what the pipeline did;
 * an inference can be wrong, and was: reading
 * researchSummary.corroborationSkipped fails on a blocked run, where
 * researchSummary is absent and the panel would silently claim the
 * corroborated path had run.
 */
// Reads the WHOLE catalogue. Which of these a run touched is a
// separate question, answered by the caller with usedInRun and
// carried on each slot as `used`, so one shape serves both the page
// load and the post-run marking.
//
// usedKeys null means "not a run": every slot reports used: false.
async function collectPromptSlots(genre, usedKeys) {
  const used = usedKeys ? new Set(usedKeys) : null;

  const slots = [];
  for (const [key, g] of slotPlan(genre)) {
    let provenance = null;
    let liveMetricBearing = null;
    try {
      provenance = await getPromptProvenance(key, g);
      if (provenance) {
        // The STORED metric_bearing column is written at save time and
        // drifts: storePrompt, which the seed script uses, never sets
        // it. templateUsesMetricBlock inspects the template the
        // pipeline reads NOW, through the same genre resolution, and
        // is the answer the Lab must show.
        liveMetricBearing = await templateUsesMetricBlock(key, g);
      }
    } catch (err) {
      platformLog("warn", "lab_prompt_slot_failed", { key, genre: g, error: err.message });
    }
    if (!provenance) {
      slots.push({ key, requestedGenre: g, present: false, used: used ? used.has(key) : false });
      continue;
    }
    slots.push({
      key,
      requestedGenre: g,
      used: used ? used.has(key) : false,
      present: true,
      resolvedGenre: provenance.resolvedGenre,
      fallback: provenance.fallback,
      description: provenance.description,
      updatedAt: provenance.updatedAt,
      metricBearing: liveMetricBearing === null ? provenance.metricBearing : liveMetricBearing,
      metricBearingStored: provenance.metricBearing,
      metricBearingDrift: liveMetricBearing !== null && liveMetricBearing !== provenance.metricBearing,
      fingerprint: provenance.fingerprint,
      placeholders: [...new Set(provenance.template.match(/{{[A-Z_]+}}/g) || [])],
      template: provenance.template
    });
  }
  return slots;
}

// ── In-flight run cap (4.25111.21, Item #1 Phase 1) ──────────
// A run is a paid, minutes-long unit holding a pool client. Beyond
// the cap the route REFUSES with 429 rather than queueing: a queue
// would silently hold clients and stack spend, and the operator
// deserves the truth. The slot releases in a finally, so a crashed
// run can never leak one. Env LAB_MAX_CONCURRENT_RUNS, default 2.
let inFlightRuns = 0;
function labRunCap() {
  const n = parseInt(process.env.LAB_MAX_CONCURRENT_RUNS, 10);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

// Run inside a tenant transaction and ALWAYS roll it back.
//
// withTenant commits when its callback returns and rolls back when
// it throws. A Lab run must never leave rows behind, so the result
// is carried out on a sentinel error: the rollback is the normal
// path here, not the failure path. Reads inside the transaction are
// unaffected, and platformLog writes on its own connection so the
// operator audit trail survives.
//
// 4.25111.21: the expected writes no longer happen at all
// (activity_log is suppressed at source under the frame; the
// corroboration override rides the frame instead of agent_state),
// so this rollback is now DEFENSE IN DEPTH, destroying only writes
// nobody gated, and the transaction it guards holds no locks. Item
// #1 Phase 2 replaces this envelope with leased, read-only units.
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

  // 4.25111.20: every request here runs under the generation_lab
  // activation, so the ledger rows a run writes share one activation
  // row carrying the signed-in admin as created_by. Meta requests
  // never spend, and an activation row is minted lazily on first
  // spend, so annotating the whole router costs nothing extra.
  router.use(annotateActivation("generation_lab"));

  // ── GET /lab/meta ─────────────────────────────────────────────
  router.get("/meta", async (req, res) => {
    const requested = String(req.query.tenantId || "");
    // The content_generator slot resolves against the selected genre.
    const requestedGenre = String(req.query.genre || "default");
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
      // page can show them disabled: a hidden Model Provider is an absence
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

      // Returned here so a template can be read and edited BEFORE the
      // first run, which matters once a run costs money.
      //
      // No used keys: nothing has run, so every slot reports
      // used: false and the page lists the catalogue.
      const promptSlots = await collectPromptSlots(
        GENRE_RE.test(requestedGenre) ? requestedGenre : "default",
        null
      );

      res.json({
        // Which tenant this payload actually describes, and which one
        // the caller belongs to. They differ whenever the operator
        // has switched away from their own.
        tenantId,
        promptSlots,
        // Which call sequence row reads each prompt. Sent rather than
        // duplicated in the page, so the two cannot disagree about
        // which call a prompt belongs to.
        promptToCall: PROMPT_TO_CALL,
        homeTenantId,
        topics: scoped.topics,
        genres: genres.length ? genres : ["default"],
        corroboration: scoped.corroboration,
        providers,
        models,
        current: scoped.current,
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
  // honoured here since Phase 3 made the calls live; 4.25111.20
  // validates both at the route so a bad selection is refused before
  // anything is spent.
  router.post("/run", async (req, res) => {
    // Seat check first (4.25111.21): a refusal costs nothing and
    // says exactly why nothing ran. The slot is released in a
    // finally, so no failure path can leak one.
    if (inFlightRuns >= labRunCap()) {
      platformLog("warn", "lab_run_refused_busy", { inFlight: inFlightRuns, cap: labRunCap() });
      return res.status(429).json({
        error: `The Lab is already executing ${inFlightRuns} run(s); the concurrent cap is ${labRunCap()}`,
        code: "LAB_BUSY",
        inFlight: inFlightRuns,
        cap: labRunCap()
      });
    }
    inFlightRuns += 1;
    try {
      await handleRun(req, res);
    } finally {
      inFlightRuns -= 1;
    }
  });

  async function handleRun(req, res) {
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

    // Prompt overrides. Request scoped and NEVER persisted: they ride
    // the ambient frame for the run and are gone when it returns. Only
    // keys the pipeline substitutes are accepted, so an override for
    // an unwired key is refused rather than silently ignored.
    // Provider and model. Both or neither, matching how the panel
    // presents them: a provider with no model cannot be routed to.
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if ((provider && !model) || (model && !provider)) {
      return res.status(400).json({
        error: "Provider and model must be selected together", code: "INCOMPLETE_SELECTION"
      });
    }
    if (!provider) {
      return res.status(400).json({
        error: "A provider and model are required for a live run", code: "SELECTION_REQUIRED"
      });
    }
    try {
      getProvider(provider);
    } catch (err) {
      return res.status(400).json({ error: `Unknown provider '${provider}'`, code: "UNKNOWN_PROVIDER" });
    }
    // 4.25111.20: the model resolves in the registry AT THE ROUTE,
    // before anything is spent. Without this, a bad model id was
    // discovered mid-run: web search refused it with a misleading
    // "no web search tool" message, the run continued RSS-only, and
    // generation failed minutes later after money had left.
    let labProfile = null;
    try {
      labProfile = getModelProfile(provider, model, process.env);
    } catch {
      return res.status(400).json({
        error: `Model '${model}' is not registered for provider '${provider}'`,
        code: "UNKNOWN_MODEL"
      });
    }
    // 4.25111.20: the orchestrated path is the only one that routes
    // a Lab run's generation and quality onto the platform key. The
    // legacy direct path would silently bill the tenant, so a Lab
    // run refuses to start without the orchestrator rather than
    // trusting an env promise.
    if (!isLlmAbstractionEnabled()) {
      return res.status(503).json({
        error: "Lab runs require the LLM orchestrator (LLM_ABSTRACTION=1)",
        code: "LAB_REQUIRES_ORCHESTRATOR"
      });
    }

    // FAIL BEFORE SPENDING. The key is resolved and decrypted here,
    // before the pipeline starts, so a misconfigured platform key
    // cannot be discovered halfway through a run that has already
    // paid for research.
    // getPlatformApiKey resolves null for BOTH unset and
    // undecryptable, logging platform_key_decrypt_failed loudly in the
    // second case. One refusal covers both because the operator's
    // action is the same either way; the platform log is where the two
    // are told apart.
    const platformKey = getPlatformApiKey("language");
    if (!platformKey) {
      return res.status(503).json({
        error: "No usable platform language key is configured",
        code: "PLATFORM_KEY_UNAVAILABLE"
      });
    }
    // No separate research model. web_search is implemented for
    // Anthropic only, and the platform key belongs to one Model Provider, so
    // a run is one key, one provider, one model throughout. A run
    // whose key and model are not Anthropic fails at the web search
    // call and says so on that row, rather than being refused up
    // front for a capability gap the pipeline shares.
    // No webSearchTool on the frame: the pipeline resolves it from the
    // model. A pinned version would let the Lab send a combination the
    // scheduled path cannot, which is the one thing it must not do.
    //
    // keyFingerprint (4.25111.20): the platform key's ledger identity,
    // derived by the SAME function the tenant key path uses, carried
    // on the frame so the spend recorder's lab seam can attribute
    // every row this run writes without ever seeing the key again.
    const labFrame = Object.freeze({
      apiKey: platformKey, provider, model,
      keyFingerprint: keyFingerprintOf(platformKey)
    });

    const promptOverrides = {};
    const raw = body.promptOverrides && typeof body.promptOverrides === "object" ? body.promptOverrides : {};
    for (const key of Object.keys(raw)) {
      if (!OVERRIDABLE_PROMPTS.has(key)) {
        return res.status(400).json({ error: `Prompt '${key}' is not overridable`, code: "PROMPT_NOT_OVERRIDABLE" });
      }
      const text = raw[key];
      if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: `Override for '${key}' must be non-empty text`, code: "EMPTY_OVERRIDE" });
      }
      if (text.length > MAX_OVERRIDE_CHARS) {
        return res.status(400).json({ error: `Override for '${key}' exceeds ${MAX_OVERRIDE_CHARS} characters`, code: "OVERRIDE_TOO_LONG" });
      }
      promptOverrides[key] = text;
    }
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
        // The pipeline sequences itself. The Lab supplies a collector,
        // the credential and routing, any prompt override, and the
        // operator's forced corroboration choice, then reads what was
        // announced. No substitute: every call reaches a real model.
        //
        // 4.25111.21: the forced corroboration choice rides the FRAME
        // now, consulted at generatePost's one read site exactly like
        // a prompt override. Its predecessor wrote agent_state inside
        // this transaction, which took a row lock on the tenant's
        // settings for the WHOLE run: an owner pausing their agent
        // while a Lab run replayed their tenant waited minutes for
        // this route to finish. Nothing is written or locked now.
        const frame = { trace, labRun: labFrame, promptOverrides };
        if (forceCorroboration !== null) frame.corroborationOverride = forceCorroboration;
        const result = await runWithGenerationTrace(frame, async () => {
          const generated = await generatePost(topicId, req.user?.sub || null, null, angle, genre);
          let quality = null;
          if (!generated.blocked) {
            quality = await qualityCheck(generated.content, generated.researchSummary || null, generated.cycleId);
          }
          return { generated, quality };
        });

        // Which vault row served each prompt, for the WHOLE catalogue,
        // with the ones this run read flagged. Read AFTER the run so a
        // genre fallback is reported as it actually resolved.
        //
        // Whether corroboration ran comes from the TRACE, not from the
        // setting: the trace records what the pipeline did, and an
        // inference can be wrong.
        const promptSlots = await collectPromptSlots(
          genre,
          usedInRun(trace.toJSON().stages.some((st) => st.id === "corroboration_request"))
        );
        return { ...result, promptSlots };
      });

      // One toJSON, one fold, per response (4.25111.20). The raw
      // trace itself is GONE from the payload: the page never read
      // it, and shipping it duplicated every clamped prompt and
      // response a second time on the wire and in browser memory.
      // The folded stages ARE the trace, shaped for the inspector.
      const traceJson = trace.toJSON();
      const byCall = attachPromptsToCalls(indexStages(trace), out.promptSlots);
      const runCost = buildRunCost(byCall, labProfile, provider, model);
      platformLog("info", "lab_run_complete", {
        tenantId, topicId, genre,
        blocked: !!out.generated.blocked,
        stages: traceJson.stages.length,
        costEstimateUsd: runCost.totals.costEstimateUsd
      });
      res.json({
        result: out.generated,
        quality: out.quality,
        promptSlots: out.promptSlots,
        stages: byCall,
        cost: runCost,
        // The run's true wall time, measured by the collector itself.
        // The page's elapsed readout uses this; summing per-row
        // durations can never reconstruct it, because unmeasured and
        // in-between time belongs to no row.
        totalMs: traceJson.totalMs
      });
    } catch (err) {
      const status = err && err.labStatus ? err.labStatus : 500;
      platformLog("error", "lab_run_failed", { tenantId, topicId, error: err.message });
      // The error response carries the SAME folded shape as success
      // (4.25111.20): a run that died at generation still paid for
      // web search, so the stages that did execute and their cost
      // travel with the error instead of being replaced by it.
      const traceJson = trace.toJSON();
      const byCall = indexStages(trace);
      res.status(status).json({
        error: status === 404 ? err.message : `Lab run failed: ${err.message}`,
        stages: byCall,
        cost: buildRunCost(byCall, labProfile, provider, model),
        totalMs: traceJson.totalMs
      });
    }
  }

  return router;
}
