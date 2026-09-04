// ═══════════════════════════════════════════════════════════════
// Research Service — RSS + web search + optional corroboration
// ═══════════════════════════════════════════════════════════════
//
// When corroboration is ENABLED (default):
//   RSS → web search (API #1) → cooldown → corroboration (API #2) → verified brief
//   ~4.5 min per cycle, 3 API calls
//
// When corroboration is DISABLED (toggle):
//   RSS → web search (API #1) → direct source brief
//   ~2.5 min per cycle, 2 API calls
// ═══════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import { getArticlesForTopic } from "./news-monitor.js";
import { logActivity, logActivityBestEffort } from "./database.js";
import { platformLog } from "./platform-log.js";
import { getTopicBySlug } from "../tenant/topic-store.js";
import { TRUST_TIERS, SOURCE_RULES } from "../config/feeds.js";
import { getAnthropicApiKey } from "../tenant/credential-store.js";
import { getAnthropicModel, callAnthropic, MODELS } from "../config/ai.js";
import { getCooldownMs } from "../config/research.js";
import { getPrompt, getAuthorizedPrompt, renderPrompt } from "./prompt-vault.js";
import { buildQueriesForTopicDetailed } from "./search-queries.js";
import { traceEnabled, buildLlmRequestInfo, buildLlmPayloadDebug } from "./llm-trace.js";
import { generationTrace, generationVendor, traceArguments, labRun, spanStart } from "./generation-trace.js";
import { yieldDb } from "../db/tenant-workflow.js";
import { estimateCostUsd, getModelProfile } from "../llm/registry.js";
import { keyFingerprintOf } from "../spend/key-resolver.js";
import { classifyProviderError, providerFailureLogDetails } from "../llm/provider-error.js";

// Anthropic client is constructed per-call using the tenant's
// BYOK key fetched from the credential store.
//
// EXCEPT on an observed Lab run, which uses the PLATFORM key by
// ruling. The research stage is Anthropic-fixed regardless of the
// provider selected for generation, because web_search is an
// Anthropic server side tool, so this is the only key it needs.
//
// 4.25111.20: also returns key provenance for the ledger. This path
// bypasses the resolver chain, so the fingerprint must be derived
// HERE or every research row records 'unresolved'. On a Lab run
// provenance is null on purpose: the recorder's own lab seam is the
// authority for platform attribution, never the call site.
async function newAnthropicClient() {
  const lab = labRun();
  if (lab && lab.apiKey) {
    return { client: new Anthropic({ apiKey: lab.apiKey }), provenance: null };
  }
  const apiKey = await getAnthropicApiKey();
  return {
    client: new Anthropic({ apiKey }),
    provenance: { keySource: "tenant", keyFingerprint: keyFingerprintOf(apiKey) }
  };
}

// ── Research spend recording (4.25111.20) ────────────────────
// Ruling: real spend is always recorded. Web search and
// corroboration call the SDK directly and never passed through the
// orchestrator's metering, so every run's ledger undercounted by
// its two most expensive calls. This helper is the bookkeeping for
// those two crossings: usage arrives in the SDK's snake_case shape
// and is normalized to the recorder's contract; cost is estimated
// from the same registry pricing the orchestrator uses; the
// web_search_requests count (a billable axis with no token
// equivalent and no ledger column) rides in source_ref. A row is
// written only when a real crossing happened: substituted calls and
// refusals before the wire are not spend. status 'unknown_usage' is
// reserved for calls that may have executed without reporting usage
// (timeouts), matching the audit view's meaning; a priced-out model
// keeps status 'ok' with a null estimate, because the tokens are
// still the ground truth. Never throws: metering must not break
// research any more than it may break generation.
async function recordResearchSpend({ call, model, usage, provenance, cycleId, status, webSearchRequests, errorClass }) {
  try {
    const { recordSpend } = await import("../spend/spend-recorder.js");
    let normalized = null;
    let costEstimateUsd = null;
    if (usage) {
      normalized = {
        inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
        outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
        cacheReadTokens: Number.isFinite(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : null,
        cacheWriteTokens: Number.isFinite(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : null
      };
      try {
        costEstimateUsd = estimateCostUsd(getModelProfile("anthropic", model, process.env), {
          promptTokens: normalized.inputTokens,
          completionTokens: normalized.outputTokens
        });
      } catch { costEstimateUsd = null; }
    }
    const sourceRef = { call, cycleId: cycleId || null };
    if (Number.isFinite(webSearchRequests)) sourceRef.webSearchRequests = webSearchRequests;
    // 4.25111.38: a failed row names WHY it failed, so the ledger
    // can answer "how much did we spend against a dead key" without
    // joining back to logs.
    if (errorClass) sourceRef.errorClass = errorClass;
    await recordSpend({
      requestType: "text_generation",
      provider: "anthropic",
      model,
      usage: normalized,
      costEstimateUsd,
      status: status || "ok",
      provenance: provenance || undefined,
      sourceRef
    });
  } catch (recErr) {
    // The recorder logs its own failures; this fires only if it
    // cannot load or crashed pre-log. Never silent (2.5.81).
    platformLog("error", "spend_recorder_unreachable", { requestType: "research", error: recErr && recErr.message });
  }
}

// What the Model Provider actually returned, beyond the model's own words.
//
// A web_search response is not one text block. The Model Provider interleaves
// server_tool_use blocks, each carrying the query the MODEL chose to
// issue, and web_search_tool_result blocks carrying the pages that
// came back. The pipeline needs only the text, so it filters the rest
// away; an observer needs all of it, because the discarded blocks are
// the only evidence of what the search actually did. Without them a
// fabricated claim and a well sourced one look identical.
//
// Reads blocks that already arrive. Nothing extra is requested and
// no pipeline behaviour changes.
function describeModelProviderResponse(response) {
  const blocks = (response && response.content) || [];
  const counts = {};
  blocks.forEach((b) => { counts[b.type] = (counts[b.type] || 0) + 1; });

  const searchesIssued = blocks
    .filter((b) => b.type === "server_tool_use")
    .map((b) => (b.input && b.input.query) || "(no query)");

  const searchResults = blocks
    .filter((b) => b.type === "web_search_tool_result")
    .flatMap((b) => Array.isArray(b.content) ? b.content : [])
    .map((r) => ({ title: r.title || null, url: r.url || null, pageAge: r.page_age || null }));

  return {
    blockTypes: counts,
    searchesIssued,
    searchResults,
    // server_tool_use.web_search_requests is the BILLABLE search
    // count, which token totals alone do not reveal.
    usage: (response && response.usage) || null,
    stopReason: (response && response.stop_reason) || null
  };
}

// Cooldown between API calls — read from getCooldownMs() at call time

// ═══════════════════════════════════════════════════════════════
// Step 1: Gather material from RSS (no API call)
// ═══════════════════════════════════════════════════════════════

async function gatherRSSMaterial(topic, angle) {
  traceArguments("gatherRSSMaterial", "async function gatherRSSMaterial(topic, angle)",
    [["topic", topic], ["angle", angle]]);
  const rssTook = spanStart();
  const maxAge = topic.max_age_days || 20;
  const articles = await getArticlesForTopic(topic.slug, maxAge, 30);

  const angleWords = angle.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  const scored = articles.map(article => {
    const text = `${article.title} ${article.summary}`.toLowerCase();
    const matchCount = angleWords.filter(w => text.includes(w)).length;
    return { ...article, relevanceScore: matchCount };
  });

  const kept = scored
    .filter(a => a.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 10);

  // Announce the database assembly with full drop accounting: an
  // observer must be able to see WHY an article did not make it,
  // not merely that it is absent.
  // Measured: the article fetch plus relevance filtering above.
  generationTrace()?.stage("db_articles", {
    topic: topic.slug,
    windowDays: maxAge,
    fetchedFromDb: articles.length,
    keptForResearch: kept.length,
    droppedNoAngleOverlap: scored.filter(a => a.relevanceScore === 0).length,
    droppedByTopTenCap: Math.max(0, scored.filter(a => a.relevanceScore > 0).length - 10),
    kept: kept.map(a => ({
      id: a.id, feed: a.feed_name, tier: a.feed_tier, published: a.published_at,
      relevanceScore: a.relevanceScore, title: a.title, link: a.link
    }))
  }, rssTook && rssTook());

  // Item #1 Part II property 1 (hold proportional to DB work,
  // 4.25111.40; first shipped as the abandoned lineage's .34): the
  // article fetch is the last database read of the run's opening
  // burst, but the lease it rode stayed open through query building
  // and prompt assembly all the way to the web-search crossing,
  // measured at 3.0 to 3.4 seconds on devenv, an order of magnitude
  // over the 250ms hold target. Surrender it here, at the end of the
  // read; the next database touch opens its own lease. No-op under
  // classic withTenant.
  await yieldDb();

  return kept;
}

// ═══════════════════════════════════════════════════════════════
// Step 2: Gather material from web search (API call #1)
// ═══════════════════════════════════════════════════════════════

async function gatherWebSearchMaterial(topic, angle, cycleId, actionToken, providerFailures = null) {
  traceArguments("webSearch", "async function gatherWebSearchMaterial(topic, angle, cycleId, actionToken)",
    [["topic", topic], ["angle", angle], ["cycleId", cycleId], ["actionToken", actionToken]]);
  const topicId = topic.slug;
  const topicName = topic.name || topicId;
  traceArguments("buildQueries", "export function buildQueriesForTopicDetailed(topic, angle)",
    [["topic", topic], ["angle", angle]]);
  // Measured tightly around the query build alone, captured before
  // the logging below so console and activity writes are not billed
  // to this row's time.
  const queriesTook = spanStart();
  const queryPlan = buildQueriesForTopicDetailed(topic, angle);
  const queriesTookMs = queriesTook && queriesTook();
  const searchQueries = queryPlan.queries;

  // Console: the actual queries this cycle will run, which path
  // produced them, and the values that filled the placeholders —
  // these queries determine which facts the writer can cite.
  platformLog("info", "search_queries_resolved", {
    cycleId, topicId, queries: searchQueries,
    source: queryPlan.source === "templates" ? "author-tuned templates" : "derived (name/description)",
    angle: queryPlan.context.ANGLE || "(none)",
    keywords: queryPlan.context.KEYWORDS
  });

  await logActivity("info", "web_search_started", { cycleId, topicId, queries: searchQueries });

  // The Research Instruction effect made visible: stored templates
  // beside the values that filled them and the queries that resulted.
  generationTrace()?.stage("search_queries", {
    source: queryPlan.source,
    placeholderContext: queryPlan.context,
    searchTemplates: topic.search_templates || [],
    renderedQueries: searchQueries
  }, queriesTookMs);

  // Resolved OUTSIDE the try so the catch can name it. A const inside
  // the try is not in scope in the catch, and the failure record reads
  // it: the first refusal below would have thrown a ReferenceError
  // that replaced the real error with a broken one.
  //
  // A Lab run uses the model the operator selected, the SAME one
  // generation uses, so the Lab reports on the selection in front of
  // the operator. Falling through to the tenant's agent_state value
  // would pair the PLATFORM key with a TENANT's model, two different
  // accounts, and the platform account has no obligation to serve a
  // model a tenant configured.
  const lab = labRun();
  const model = lab ? lab.model : await getAnthropicModel();
  const webSearchEntry = MODELS.find((m) => m.id === model);
  // Declared outside the try for the same scope reason as model
  // above: the catch reads it to report time to failure when the
  // Model Provider call itself is what threw. Null until the
  // crossing is reached, so a refusal that never called the Model
  // Provider stays blank. keyProvenance travels the same way so the
  // catch can attribute a failed crossing's ledger row (4.25111.20).
  let providerTook = null;
  let keyProvenance = null;
  // The failed-crossing ledger row was gated on providerTook, but
  // spanStart() returns null OUTSIDE a trace frame, so in production
  // that gate could never open and a denied crossing recorded
  // nothing (4.25111.38 root cause RC-2, reproduced against a
  // billing-denied key). crossingReached is the explicit fact the
  // gate always needed; providerTook stays as duration only.
  let crossingReached = false;

  try {
    // No row means this deployment has not configured web search for
    // the selected model. Refuse HERE, and refuse FIRST.
    //
    // The danger is NOT that the Model Provider would reject the request. With
    // no tools key the Model Provider accepts it and returns an ordinary
    // completion, and the stage reports a successful search that found
    // nothing. A silent empty result is worse than a loud refusal,
    // because the run continues and the post is built from RSS alone
    // with nothing on the page saying why.
    //
    // The gate runs BEFORE client construction (4.25111.15, refactor
    // item 14) because it is a pure map lookup that needs no
    // credential. In the reverse order a credential failure threw
    // first and the configuration refusal was never heard; each
    // problem now reports as itself.
    if (!webSearchEntry || !webSearchEntry.tool) {
      throw new Error("no web search tool configured for this model");
    }

    const { client, provenance } = await newAnthropicClient();
    keyProvenance = provenance;

    var vaultGet = actionToken
      ? (key) => getAuthorizedPrompt(key, actionToken)
      : (key) => getPrompt(key);

    let template = await vaultGet("research_assistant");
    if (!template) {
      // Announce the refusal. Returning silently left the call
      // sequence row marked done with nothing on it, which reads as
      // "this call produced nothing" rather than "this call never
      // ran".
      generationTrace()?.stage("web_search_response", {
        failed: true, reason: "prompt_vault_miss",
        note: "No research_assistant prompt in the vault. No search was performed."
      });
      platformLog("error", "prompt_vault_miss", { key: "research_assistant" });
      return [];
    }
    let assembledPrompt = renderPrompt(template, {
      TOPIC_NAME: topicName,
      ANGLE: angle,
      SEARCH_QUERIES: searchQueries.map((q, i) => `${i + 1}. "${q}"`).join("\n")
    });
    template = null;

    // Phase 1 LLM observability: requestParams is BOTH dumped and
    // sent, so the trace provably shows the exact bytes the backend
    // receives (fully rendered — placeholders already resolved).
    const requestParams = {
      model,
      max_tokens: 2000,
      // The MODEL decides the tool. Resolved above, so a model with no
      // web search row refuses before the request is assembled.
      tools: [webSearchEntry.tool],
      messages: [{ role: "user", content: assembledPrompt }]
    };
    platformLog("info", "llm_request_web_search",
      buildLlmRequestInfo("web_search", "1 of 4", requestParams, { cycleId, topicId, angle }));
    if (traceEnabled(process.env.LLM_TRACE)) {
      platformLog("debug", "llm_payload_web_search",
        buildLlmPayloadDebug("web_search", requestParams, cycleId));
    }
    generationTrace()?.stage("web_search_request", {
      model, maxTokens: requestParams.max_tokens, tools: requestParams.tools,
      assembledPrompt
    });
    // The Model Provider substitute receives the SAME fully
    // assembled request the network would have received. Everything
    // below this line runs identically either way.
    const substitute = generationVendor();
    // Surrender the DB lease before the crossing (Item #1 Phase 2):
    // Model Provider latency dwarfs any database burst, and a
    // workflow holds no connection while it waits. No-op under
    // classic withTenant, so production behavior is unchanged.
    await yieldDb();
    // Model Provider latency, bracketed immediately around the
    // crossing so the parsing below is not billed to its time.
    providerTook = spanStart();
    if (!substitute) crossingReached = true;
    const response = substitute
      ? substitute.anthropic("web_search", requestParams)
      : await callAnthropic(client, requestParams);
    const providerTookMs = providerTook && providerTook();
    assembledPrompt = null;

    // Money left the account the moment the crossing returned, so
    // the row is written HERE, before any parse gate can bail out.
    // A substituted call made no crossing and records nothing.
    if (!substitute) {
      await recordResearchSpend({
        call: "web_search", model,
        usage: response.usage || null,
        provenance: keyProvenance, cycleId, status: "ok",
        webSearchRequests: response.usage && response.usage.server_tool_use
          ? response.usage.server_tool_use.web_search_requests
          : undefined
      });
    }

    const textBlocks = response.content.filter(b => b.type === "text");
    const rawText = textBlocks.map(b => b.text).join("\n").trim();
    const cleaned = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      generationTrace()?.stage("web_search_response", Object.assign({
        rawText, parseFailed: true,
        note: "No JSON array found in the response. The stage returns no claims and the run continues."
      }, describeModelProviderResponse(response)), providerTookMs);
      await logActivity("warn", "web_search_no_json", { cycleId, rawLength: rawText.length });
      return [];
    }

    const claims = JSON.parse(jsonMatch[0]);
    // Raw text travels with the parsed result. A parse that succeeds
    // on the wrong bytes is invisible without it.
    generationTrace()?.stage("web_search_response", Object.assign({
      rawText, claimCount: claims.length, claims
    }, describeModelProviderResponse(response)), providerTookMs);

    // Console mirror: the direct effect of the queries above —
    // how much citable material this cycle's retrieval produced.
    platformLog("info", "web_search_complete", {
      cycleId, topicId,
      claimsFound: claims.length,
      distinctSources: [...new Set(claims.map(c => c.source_name))].length
    });
    await logActivity("info", "web_search_complete", {
      cycleId,
      claimsFound: claims.length,
      sources: [...new Set(claims.map(c => c.source_name))].length
    });

    return claims;
  } catch (err) {
    // Name the MODEL and the TOOL. This call is the only one in the
    // pipeline that sends a tool block, so when it alone fails the
    // tool is the first thing to compare against a working run.
    //
    // model and webSearchEntry are in scope because both are resolved
    // above the try. A model with no row reports a null tool, which is
    // the accurate answer rather than a guess.
    const attempted = {
      model: model || null,
      webSearchTool: (webSearchEntry && webSearchEntry.tool && webSearchEntry.tool.type) || null
    };
    // The trace is the ONLY surviving record on a Lab run: logActivity
    // writes inside the tenant transaction, which the Lab rolls back,
    // so an error recorded only there is destroyed. platformLog writes
    // on its own connection and survives.
    // Time to failure when the crossing was reached, blank when the
    // failure came before it (refusal, vault miss, credentials).
    generationTrace()?.stage("web_search_response", Object.assign({
      failed: true, reason: err && err.name ? err.name : "Error",
      error: err && err.message ? err.message : String(err)
    }, attempted), providerTook ? providerTook() : undefined);
    // 4.25111.38: name the failure BEFORE recording it anywhere. A
    // billing denial spent a day disguised as "insufficient sources"
    // because every record below carried only the raw message.
    // The research SDK path is always Anthropic; name it even
    // though SDK errors carry no providerId (4.25111.42).
    const pf = classifyProviderError(err, { providerId: "anthropic" });
    if (pf) Object.assign(attempted, { errorClass: pf.class, operatorMessage: pf.operatorMessage });
    if (providerFailures && pf) providerFailures.push({ call: "web_search", ...pf });
    platformLog("error", "web_search_failed",
      Object.assign({ cycleId, error: err && err.message }, attempted));
    // 4.25111.20 intent, 4.25111.38 gate: a crossing that was
    // REACHED may have spent money even though it threw. A timeout
    // after the model started is spend with unreported usage
    // (unknown_usage); a rejection is failed. A refusal before the
    // crossing spent nothing and records nothing.
    if (crossingReached) {
      await recordResearchSpend({
        call: "web_search", model, usage: null,
        provenance: keyProvenance, cycleId,
        status: /timeout|abort/i.test((err && err.name) || "") ? "unknown_usage" : "failed",
        errorClass: pf ? pf.class : "unclassified"
      });
    }
    // Best effort: when the error being recorded ABORTED the tenant
    // transaction, a plain logActivity here would throw 25P02 and
    // replace this catch's return-empty degrade with a propagation.
    // 4.25111.42: the COMPLETE error, not a summary, in the
    // activity log: raw message, class, status, provider, request
    // id, body snippet, provider words.
    await logActivityBestEffort("error", "web_search_failed",
      Object.assign({ cycleId }, attempted, providerFailureLogDetails(err, pf)));
    return [];
  }
}

// Search queries are built per-topic by services/search-queries.js
// (topic.search_templates first, derived fallback otherwise). The
// legacy buildSearchQueries/_buildSearchQueries/extractKeywords were
// removed in 1.8.9.


function classifySourceTier(sourceName) {
  const name = sourceName.toLowerCase();
  const authoritative = ["cisa", "nist", "fbi", "nsa", "enisa", "ncsc", "sec.gov", "ftc",
    "microsoft security response", "google project zero"];
  const primary = ["krebs", "bleepingcomputer", "dark reading", "the record", "securelist",
    "schneier", "ars technica", "wired", "reuters", "associated press", "bbc", "nyt",
    "washington post", "google blog", "openai", "anthropic", "mit technology review"];
  if (authoritative.some(a => name.includes(a))) return "authoritative";
  if (primary.some(p => name.includes(p))) return "primary";
  return "secondary";
}

// ═══════════════════════════════════════════════════════════════
// Source assembly (shared by both paths)
// ═══════════════════════════════════════════════════════════════

function assembleAllSources(webClaims, rssArticles) {
  const allSources = [];

  for (const claim of webClaims) {
    allSources.push({
      type: "web_search", name: claim.source_name, url: claim.source_url,
      date: claim.source_date, text: claim.claim, confidence: claim.confidence,
      tier: classifySourceTier(claim.source_name)
    });
  }

  for (const article of rssArticles) {
    allSources.push({
      type: "rss", name: article.feed_name, url: article.link,
      date: article.published_at,
      text: `${article.title}: ${(article.summary || "").slice(0, 300)}`,
      confidence: "high", tier: article.feed_tier
    });
  }

  return allSources;
}

// ═══════════════════════════════════════════════════════════════
// Path A: Corroboration (API call #2)
// ═══════════════════════════════════════════════════════════════

async function corroborateClaims(allSources, cycleId, actionToken, providerFailures = null) {
  traceArguments("corroborate", "async function corroborateClaims(allSources, cycleId, actionToken)",
    [["allSources", allSources], ["cycleId", cycleId], ["actionToken", actionToken]]);
  if (allSources.length === 0) {
    await logActivity("warn", "corroboration_no_sources", { cycleId });
    return { verified: [], belowThreshold: [], uncorroborated: [] };
  }

  const sourcesTook = spanStart();
  await logActivity("info", "corroboration_started", { cycleId, sourceCount: allSources.length });

  // Everything corroboration will weigh, before a prompt exists:
  // the merged web and database material with its tier mix.
  // The measured time covers the activity write above plus the tier
  // arithmetic below, the real wall cost of reaching this record.
  generationTrace()?.stage("corroboration_sources", {
    totalSourceItems: allSources.length,
    fromWebSearch: allSources.filter(s => s.type === "web_search").length,
    fromDatabase: allSources.filter(s => s.type === "rss").length,
    byTier: allSources.reduce((acc, s) => { acc[s.tier] = (acc[s.tier] || 0) + 1; return acc; }, {}),
    minTrustWeightToVerify: SOURCE_RULES.minTrustWeight,
    sources: allSources.map((s, i) => ({
      index: i + 1, name: s.name, tier: s.tier, type: s.type, date: s.date, url: s.url
    }))
  }, sourcesTook && sourcesTook());

  // Same scope rule as the web_search crossing: the catch reads
  // these. model is hoisted too (4.25111.20) so the failed-crossing
  // ledger row can name the model that was attempted.
  let corrTook = null;
  let keyProvenance = null;
  let model = null;
  // Same explicit crossing fact as the web_search gatherer
  // (4.25111.38): corrTook comes from spanStart(), which is null
  // outside a trace frame, so it can never gate a production ledger row.
  let crossingReached = false;

  try {
    const { client, provenance } = await newAnthropicClient();
    keyProvenance = provenance;
    // A Lab run uses the model the operator selected, the SAME one
    // generation uses. Falling through to the tenant's agent_state
    // value would pair the platform key with a model from a different
    // account. This stage sends NO tool block, so the web_search
    // notes on the stage above do not apply here.
    const lab = labRun();
    model = lab ? lab.model : await getAnthropicModel();

    var vaultGet = actionToken
      ? (key) => getAuthorizedPrompt(key, actionToken)
      : (key) => getPrompt(key);

    let template = await vaultGet("corroboration_analyst");
    if (!template) {
      generationTrace()?.stage("corroboration_response", {
        failed: true, reason: "prompt_vault_miss",
        note: "No corroboration_analyst prompt in the vault. Nothing was verified."
      });
      platformLog("error", "prompt_vault_miss", { key: "corroboration_analyst" });
      return { verified: [], belowThreshold: [], uncorroborated: [] };
    }
    let assembledPrompt = renderPrompt(template, {
      SOURCE_MATERIALS: allSources.map((s, i) => `[${i + 1}] ${s.name} (${s.tier}, ${s.date}): ${s.text}`).join("\n\n")
    });
    template = null;

    const requestParams = {
      model,
      max_tokens: 2000,
      messages: [{ role: "user", content: assembledPrompt }]
    };
    platformLog("info", "llm_request_corroboration",
      buildLlmRequestInfo("corroboration", "2 of 4", requestParams, { cycleId }));
    if (traceEnabled(process.env.LLM_TRACE)) {
      platformLog("debug", "llm_payload_corroboration",
        buildLlmPayloadDebug("corroboration", requestParams, cycleId));
    }
    generationTrace()?.stage("corroboration_request", {
      model, maxTokens: requestParams.max_tokens, sourceCount: allSources.length,
      assembledPrompt
    });
    const substitute = generationVendor();
    // Lease surrendered before the crossing; no-op under classic
    // withTenant (Item #1 Phase 2).
    await yieldDb();
    corrTook = spanStart();
    if (!substitute) crossingReached = true;
    const response = substitute
      ? substitute.anthropic("corroboration", requestParams)
      : await callAnthropic(client, requestParams);
    const corrTookMs = corrTook && corrTook();
    assembledPrompt = null;

    // Ledger row at the crossing, before any parse gate (4.25111.20):
    // the spend is real whether or not the JSON below survives.
    if (!substitute) {
      await recordResearchSpend({
        call: "corroboration", model,
        usage: response.usage || null,
        provenance: keyProvenance, cycleId, status: "ok"
      });
    }

    const rawText = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const cleaned = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      generationTrace()?.stage("corroboration_response", Object.assign({
        rawText, parseFailed: true,
        note: "No JSON object found in the response. No claims are verified and the run continues."
      }, describeModelProviderResponse(response)), corrTookMs);
      await logActivity("warn", "corroboration_parse_failed", { cycleId });
      return { verified: [], belowThreshold: [], uncorroborated: [] };
    }

    const result = JSON.parse(jsonMatch[0]);

    const scoredCorroborated = (result.corroborated_claims || []).map(claim => {
      const claimSources = (claim.source_indices || []).map(i => allSources[i - 1]).filter(Boolean);
      const trustWeight = claimSources.reduce((sum, s) => sum + (TRUST_TIERS[s.tier]?.weight || 1), 0);
      return {
        ...claim, trustWeight,
        meetsThreshold: trustWeight >= SOURCE_RULES.minTrustWeight,
        sources: claimSources.map(s => ({ name: s.name, url: s.url, date: s.date, tier: s.tier }))
      };
    });

    const verified = scoredCorroborated.filter(c => c.meetsThreshold);
    const belowThreshold = scoredCorroborated.filter(c => !c.meetsThreshold);
    // Raw text, plus the trust weight arithmetic that decided which
    // claims survive. The scoring is where claims are actually won
    // or lost, so it is shown rather than summarised.
    generationTrace()?.stage("corroboration_response", Object.assign(describeModelProviderResponse(response), {
      rawText,
      verified: verified.length,
      belowThreshold: belowThreshold.length,
      uncorroborated: (result.uncorroborated_claims || []).length,
      scored: scoredCorroborated.map(c => ({
        claim: c.claim, trustWeight: c.trustWeight, meetsThreshold: c.meetsThreshold,
        confidence: c.confidence, sources: c.sources
      }))
    }), corrTookMs);

    await logActivity("info", "corroboration_complete", {
      cycleId,
      totalSources: allSources.length,
      verifiedClaims: verified.length,
      belowThreshold: belowThreshold.length,
      uncorroborated: result.uncorroborated_claims?.length || 0
    });

    return { verified, belowThreshold, uncorroborated: result.uncorroborated_claims || [] };
  } catch (err) {
    generationTrace()?.stage("corroboration_response", {
      failed: true, reason: err && err.name ? err.name : "Error",
      error: err && err.message ? err.message : String(err)
    }, corrTook ? corrTook() : undefined);
    const pf = classifyProviderError(err, { providerId: "anthropic" });
    if (providerFailures && pf) providerFailures.push({ call: "corroboration", ...pf });
    platformLog("error", "corroboration_failed",
      { cycleId, error: err && err.message, errorClass: pf ? pf.class : undefined });
    // 4.25111.20 intent, 4.25111.38 gate: same failed-crossing
    // bookkeeping as web search, on the explicit crossing fact.
    if (crossingReached) {
      await recordResearchSpend({
        call: "corroboration", model, usage: null,
        provenance: keyProvenance, cycleId,
        status: /timeout|abort/i.test((err && err.name) || "") ? "unknown_usage" : "failed",
        errorClass: pf ? pf.class : "unclassified"
      });
    }
    // Best effort for the same reason as the web_search catch: the
    // recorded error may itself have aborted the tenant transaction.
    // 4.25111.42: the COMPLETE error in the activity log.
    await logActivityBestEffort("error", "corroboration_failed",
      Object.assign({ cycleId }, providerFailureLogDetails(err, pf)));
    return { verified: [], belowThreshold: [], uncorroborated: [] };
  }
}

function buildVerifiedBrief(corroboration, allSources) {
  const verified = corroboration.verified;
  const sourceMap = new Map();

  for (const claim of verified) {
    for (const src of claim.sources) {
      const key = src.url || src.name;
      if (!sourceMap.has(key)) {
        sourceMap.set(key, {
          name: src.name, url: src.url, date: src.date, tier: src.tier,
          citationIndex: sourceMap.size + 1
        });
      }
    }
  }

  const sourceList = [...sourceMap.values()];
  let context = "";

  if (verified.length > 0) {
    context += "VERIFIED FACTS (corroborated by 2+ independent sources):\n";
    for (const claim of verified) {
      const srcRefs = claim.sources
        .map(s => sourceMap.get(s.url || s.name)?.citationIndex)
        .filter(Boolean);
      context += `• ${claim.claim} [Sources: ${srcRefs.join(", ")}] (confidence: ${claim.confidence})\n`;
    }
  }

  if (corroboration.belowThreshold?.length > 0) {
    context += "\nUNCORROBORATED (DO NOT state as fact):\n";
    for (const claim of corroboration.belowThreshold) {
      context += `• ${claim.claim} (below corroboration threshold — OMIT or hedge heavily)\n`;
    }
  }

  context += "\nSOURCE LIST:\n";
  for (const src of sourceList) {
    context += `[${src.citationIndex}] ${src.name}${src.url ? ` — ${src.url}` : ""} (${src.date || "undated"}, tier: ${src.tier})\n`;
  }

  const uniqueSourceNames = new Set(allSources.map(s => s.name.toLowerCase().trim()));
  const independentCount = uniqueSourceNames.size;

  return {
    context, sourceList, sourceCount: sourceList.length,
    independentSourceCount: independentCount,
    verifiedClaimCount: verified.length,
    corroborationSkipped: false,
    hasEnoughMaterial: verified.length >= 1,
    summary: {
      rssArticles: allSources.filter(s => s.type === "rss").length,
      webClaims: allSources.filter(s => s.type === "web_search").length,
      independentSources: independentCount,
      totalSourceItems: allSources.length,
      verifiedClaims: verified.length,
      belowThreshold: corroboration.belowThreshold?.length || 0,
      uncorroborated: corroboration.uncorroborated?.length || 0
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// Path B: Direct brief (no corroboration call)
// ═══════════════════════════════════════════════════════════════

function buildDirectBrief(allSources) {
  const sourceMap = new Map();
  for (const s of allSources) {
    const key = s.url || s.name;
    if (!sourceMap.has(key)) {
      sourceMap.set(key, {
        name: s.name, url: s.url, date: s.date, tier: s.tier,
        citationIndex: sourceMap.size + 1
      });
    }
  }
  const sourceList = [...sourceMap.values()];

  const uniqueSourceNames = new Set(allSources.map(s => s.name.toLowerCase().trim()));
  const independentCount = uniqueSourceNames.size;
  const hasEnoughMaterial = independentCount >= SOURCE_RULES.minIndependentSources;

  let context = `SOURCE MATERIAL (from ${independentCount} independent sources — corroboration skipped):\n\n`;

  for (const s of allSources) {
    const srcRef = sourceMap.get(s.url || s.name)?.citationIndex || "?";
    context += `[${srcRef}] (${s.tier}, ${s.type}) ${s.name} (${s.date || "undated"}):\n`;
    context += `   ${s.text}\n\n`;
  }

  context += "SOURCE LIST:\n";
  for (const src of sourceList) {
    context += `[${src.citationIndex}] ${src.name}${src.url ? ` — ${src.url}` : ""} (${src.date || "undated"}, tier: ${src.tier})\n`;
  }

  return {
    context, sourceList, sourceCount: sourceList.length,
    independentSourceCount: independentCount,
    verifiedClaimCount: 0,
    corroborationSkipped: true,
    hasEnoughMaterial,
    summary: {
      rssArticles: allSources.filter(s => s.type === "rss").length,
      webClaims: allSources.filter(s => s.type === "web_search").length,
      independentSources: independentCount,
      totalSourceItems: allSources.length,
      verifiedClaims: 0,
      belowThreshold: 0,
      uncorroborated: 0
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════

export async function conductResearch(topicId, angle, cycleId = null, skipCorroboration = false, actionToken = null) {
  traceArguments("conductResearch",
    "export async function conductResearch(topicId, angle, cycleId = null, skipCorroboration = false, actionToken = null)",
    [["topicId", topicId], ["angle", angle], ["cycleId", cycleId],
     ["skipCorroboration", skipCorroboration], ["actionToken", actionToken]]);
  await logActivity("info", "research_started", { cycleId, topicId, angle, corroboration: !skipCorroboration });

  // Resolve topic from DB once — both gather functions use it
  const topic = await getTopicBySlug(topicId);
  if (!topic) {
    await logActivity("warn", "research_topic_not_found", { cycleId, topicId });
    return {
      context: "", sourceList: [], sourceCount: 0,
      independentSourceCount: 0, verifiedClaimCount: 0,
      corroborationSkipped: skipCorroboration,
      hasEnoughMaterial: false,
      summary: { rssArticles: 0, webClaims: 0, independentSources: 0, totalSourceItems: 0, verifiedClaims: 0, belowThreshold: 0, uncorroborated: 0 }
    };
  }

  // Step 1: RSS (instant)
  const rssArticles = await gatherRSSMaterial(topic, angle);

  // Provider failures observed by this run's crossings, in operator
  // language (4.25111.38). They ride the brief so the BLOCKED REASON
  // can tell the truth: a run starved by a billing-denied key must
  // never present itself as ordinary thin research.
  const providerFailures = [];

  // Step 2: Web search (API call #1)
  const webClaims = await gatherWebSearchMaterial(topic, angle, cycleId, actionToken, providerFailures);

  // ── Stage 1 logging: research material breakdown ────────────
  // Shows which feeds contributed, topic-specific vs catchall split,
  // and article freshness range. Helps the user understand what
  // material the AI will work with.
  const feedBreakdown = {};
  for (const a of rssArticles) {
    const key = a.feed_name || "unknown";
    if (!feedBreakdown[key]) {
      feedBreakdown[key] = { feed: key, tier: a.feed_tier || "secondary", count: 0 };
    }
    feedBreakdown[key].count++;
  }

  const dates = rssArticles
    .map(a => a.published_at)
    .filter(Boolean)
    .sort();

  const researchGatheredDetails = {
    cycleId,
    topicId,
    rssArticles: rssArticles.length,
    webClaims: webClaims.length,
    feedBreakdown: Object.values(feedBreakdown),
    oldestArticle: dates[0] || null,
    newestArticle: dates[dates.length - 1] || null
  };

  await logActivity("info", "research_material_gathered", researchGatheredDetails);
  platformLog("info", "research_material_gathered", researchGatheredDetails);

  // Collect article images for the post image picker.
  // Only articles with validated image URLs are included.
  const articleImages = rssArticles
    .filter(a => a.image_url)
    .map(a => ({
      imageUrl: a.image_url,
      title: a.title,
      feedName: a.feed_name,
      link: a.link
    }));

  traceArguments("assembleSources", "function assembleAllSources(webClaims, rssArticles)",
    [["webClaims", webClaims], ["rssArticles", rssArticles]]);
  const allSources = assembleAllSources(webClaims, rssArticles);

  let brief;

  if (skipCorroboration) {
    // Path B: Skip corroboration — build brief directly from raw sources
    await logActivity("info", "corroboration_skipped", { cycleId, message: "Corroboration disabled via dashboard toggle" });
    traceArguments("buildBrief", "function buildDirectBrief(allSources)",
      [["allSources", allSources]]);
    brief = buildDirectBrief(allSources);
  } else {
    // Path A: Full corroboration pipeline
    // The cooldown exists to pace REAL Model Provider traffic on a
    // tenant's key. A substituted Model Provider makes no network
    // call, and a Lab run (4.25111.21, delegated ruling) is an
    // interactive one-off on the separate platform key, so neither
    // waits: for the Lab the pause only lengthened the held
    // transaction by the full cooldown.
    const cooldownMs = (labRun() || generationVendor()) ? 0 : getCooldownMs();
    // 4.25111.38 (RC-5): pace the Model Provider only when there is
    // a call to pace. With zero sources the corroborator refuses
    // before the wire, and the reproduced billing-denied run sat
    // through a full cooldown protecting a call that never happens.
    if (allSources.length > 0) {
      await logActivity("info", "rate_limit_cooldown", { cycleId, message: `Waiting ${cooldownMs / 1000}s before corroboration call` });
      // Production pause (Item #1 Phase 3, 4.25111.40): the lease is
      // surrendered BEFORE the wait, after the log write above, so
      // pacing real Model Provider traffic holds no transaction and
      // no connection. No-op under classic withTenant.
      if (cooldownMs > 0) { await yieldDb(); await new Promise(resolve => setTimeout(resolve, cooldownMs)); }
    }

    const corrobStart = Date.now();
    const corroboration = await corroborateClaims(allSources, cycleId, actionToken, providerFailures);
    traceArguments("buildBrief", "function buildVerifiedBrief(corroboration, allSources)",
      [["corroboration", corroboration], ["allSources", allSources]]);
    brief = buildVerifiedBrief(corroboration, allSources);
    brief._corrobDurationMs = Date.now() - corrobStart;
  }

  // Attach the observed provider failures to the brief itself, so
  // every consumer (blocked reason, response, activity) names them.
  brief.providerFailures = providerFailures;

  const researchCompleteDetails = {
    cycleId, topicId,
    corroborationSkipped: skipCorroboration,
    verifiedClaims: brief.verifiedClaimCount,
    independentSources: brief.independentSourceCount,
    hasEnoughMaterial: brief.hasEnoughMaterial,
    totalItems: brief.summary.totalSourceItems,
    corrobDurationMs: brief._corrobDurationMs || null
  };

  await logActivity("info", "research_complete", researchCompleteDetails);
  platformLog("info", "research_complete", researchCompleteDetails);

  // Attach article images to the brief for the content generator
  brief.articleImages = articleImages;

  // The finished brief, which is the only thing generation sees of
  // all the work above.
  generationTrace()?.stage("research_brief", {
    corroborationSkipped: skipCorroboration,
    hasEnoughMaterial: brief.hasEnoughMaterial,
    summary: brief.summary,
    sourceList: brief.sourceList,
    briefContext: brief.context
  });

  return brief;
}
