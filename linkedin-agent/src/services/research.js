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
import { logActivity } from "./database.js";
import { platformLog } from "./platform-log.js";
import { getTopicBySlug } from "../tenant/topic-store.js";
import { TRUST_TIERS, SOURCE_RULES } from "../config/feeds.js";
import { getAnthropicApiKey } from "../tenant/credential-store.js";
import { getAnthropicModel, callAnthropic, getWebSearchTools } from "../config/ai.js";
import { getCooldownMs } from "../config/research.js";
import { getPrompt, getAuthorizedPrompt, renderPrompt } from "./prompt-vault.js";
import { buildQueriesForTopicDetailed } from "./search-queries.js";
import { traceEnabled, buildLlmRequestInfo, buildLlmPayloadDebug } from "./llm-trace.js";
import { generationTrace, generationVendor } from "./generation-trace.js";

// Anthropic client is constructed per-call using the tenant's
// BYOK key fetched from the credential store.
async function newAnthropicClient() {
  const apiKey = await getAnthropicApiKey();
  return new Anthropic({ apiKey });
}

// Cooldown between API calls — read from getCooldownMs() at call time

// ═══════════════════════════════════════════════════════════════
// Step 1: Gather material from RSS (no API call)
// ═══════════════════════════════════════════════════════════════

async function gatherRSSMaterial(topic, angle) {
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
  });

  return kept;
}

// ═══════════════════════════════════════════════════════════════
// Step 2: Gather material from web search (API call #1)
// ═══════════════════════════════════════════════════════════════

async function gatherWebSearchMaterial(topic, angle, cycleId, actionToken) {
  const topicId = topic.slug;
  const topicName = topic.name || topicId;
  const queryPlan = buildQueriesForTopicDetailed(topic, angle);
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
  });

  try {
    const client = await newAnthropicClient();
    const model = await getAnthropicModel();

    var vaultGet = actionToken
      ? (key) => getAuthorizedPrompt(key, actionToken)
      : (key) => getPrompt(key);

    let template = await vaultGet("research_assistant");
    if (!template) {
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
      tools: getWebSearchTools(),
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
    // The vendor substitute receives the SAME fully assembled request
    // the network would have received. Everything below this line
    // runs identically either way.
    const vendor = generationVendor();
    const response = vendor
      ? vendor.anthropic("web_search", requestParams)
      : await callAnthropic(client, requestParams);
    assembledPrompt = null;

    const textBlocks = response.content.filter(b => b.type === "text");
    const rawText = textBlocks.map(b => b.text).join("\n").trim();
    const cleaned = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      generationTrace()?.stage("web_search_response", {
        rawText, parseFailed: true,
        note: "No JSON array found in the response. The stage returns no claims and the run continues."
      });
      await logActivity("warn", "web_search_no_json", { cycleId, rawLength: rawText.length });
      return [];
    }

    const claims = JSON.parse(jsonMatch[0]);
    // Raw text travels with the parsed result. A parse that succeeds
    // on the wrong bytes is invisible without it.
    generationTrace()?.stage("web_search_response", {
      rawText, claimCount: claims.length, claims
    });

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
    await logActivity("error", "web_search_failed", { cycleId, error: err.message });
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

async function corroborateClaims(allSources, cycleId, actionToken) {
  if (allSources.length === 0) {
    await logActivity("warn", "corroboration_no_sources", { cycleId });
    return { verified: [], belowThreshold: [], uncorroborated: [] };
  }

  await logActivity("info", "corroboration_started", { cycleId, sourceCount: allSources.length });

  // Everything corroboration will weigh, before a prompt exists:
  // the merged web and database material with its tier mix.
  generationTrace()?.stage("corroboration_sources", {
    totalSourceItems: allSources.length,
    fromWebSearch: allSources.filter(s => s.type === "web_search").length,
    fromDatabase: allSources.filter(s => s.type === "rss").length,
    byTier: allSources.reduce((acc, s) => { acc[s.tier] = (acc[s.tier] || 0) + 1; return acc; }, {}),
    minTrustWeightToVerify: SOURCE_RULES.minTrustWeight,
    sources: allSources.map((s, i) => ({
      index: i + 1, name: s.name, tier: s.tier, type: s.type, date: s.date, url: s.url
    }))
  });

  try {
    const client = await newAnthropicClient();
    const model = await getAnthropicModel();

    var vaultGet = actionToken
      ? (key) => getAuthorizedPrompt(key, actionToken)
      : (key) => getPrompt(key);

    let template = await vaultGet("corroboration_analyst");
    if (!template) {
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
    const vendor = generationVendor();
    const response = vendor
      ? vendor.anthropic("corroboration", requestParams)
      : await callAnthropic(client, requestParams);
    assembledPrompt = null;

    const rawText = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const cleaned = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      generationTrace()?.stage("corroboration_response", {
        rawText, parseFailed: true,
        note: "No JSON object found in the response. No claims are verified and the run continues."
      });
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
    generationTrace()?.stage("corroboration_response", {
      rawText,
      verified: verified.length,
      belowThreshold: belowThreshold.length,
      uncorroborated: (result.uncorroborated_claims || []).length,
      scored: scoredCorroborated.map(c => ({
        claim: c.claim, trustWeight: c.trustWeight, meetsThreshold: c.meetsThreshold,
        confidence: c.confidence, sources: c.sources
      }))
    });

    await logActivity("info", "corroboration_complete", {
      cycleId,
      totalSources: allSources.length,
      verifiedClaims: verified.length,
      belowThreshold: belowThreshold.length,
      uncorroborated: result.uncorroborated_claims?.length || 0
    });

    return { verified, belowThreshold, uncorroborated: result.uncorroborated_claims || [] };
  } catch (err) {
    await logActivity("error", "corroboration_failed", { cycleId, error: err.message });
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

  // Step 2: Web search (API call #1)
  const webClaims = await gatherWebSearchMaterial(topic, angle, cycleId, actionToken);

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

  const allSources = assembleAllSources(webClaims, rssArticles);

  let brief;

  if (skipCorroboration) {
    // Path B: Skip corroboration — build brief directly from raw sources
    await logActivity("info", "corroboration_skipped", { cycleId, message: "Corroboration disabled via dashboard toggle" });
    brief = buildDirectBrief(allSources);
  } else {
    // Path A: Full corroboration pipeline
    // The cooldown exists to pace REAL vendor traffic. A substituted
    // vendor makes no network call, so waiting would only make the
    // observation slower without making it truer.
    const cooldownMs = generationVendor() ? 0 : getCooldownMs();
    await logActivity("info", "rate_limit_cooldown", { cycleId, message: `Waiting ${cooldownMs / 1000}s before corroboration call` });
    if (cooldownMs > 0) await new Promise(resolve => setTimeout(resolve, cooldownMs));

    const corrobStart = Date.now();
    const corroboration = await corroborateClaims(allSources, cycleId, actionToken);
    brief = buildVerifiedBrief(corroboration, allSources);
    brief._corrobDurationMs = Date.now() - corrobStart;
  }

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
