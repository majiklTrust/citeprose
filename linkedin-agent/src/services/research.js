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
import { getAnthropicModel, callAnthropic } from "../config/ai.js";

// Anthropic client is constructed per-call using the tenant's
// BYOK key fetched from the credential store.
async function newAnthropicClient() {
  const apiKey = await getAnthropicApiKey();
  return new Anthropic({ apiKey });
}

const COOLDOWN_MS = 65000;

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

  return scored
    .filter(a => a.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════
// Step 2: Gather material from web search (API call #1)
// ═══════════════════════════════════════════════════════════════

async function gatherWebSearchMaterial(topic, angle, cycleId) {
  const topicId = topic.slug;
  const topicName = topic.name || topicId;
  const searchQueries = buildSearchQueries(topicId, angle);

  await logActivity("info", "web_search_started", { cycleId, topicId, queries: searchQueries });

  try {
    const client = await newAnthropicClient();
    const model = await getAnthropicModel();
    const response = await callAnthropic(client, {
      model,
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `You are a research assistant. Find current, factual information about this topic.

TOPIC AREA: ${topicName}
SPECIFIC ANGLE: ${angle}

Search for recent, reliable information using these queries:
${searchQueries.map((q, i) => `${i + 1}. "${q}"`).join("\n")}

For each piece of information you find, return it in this exact JSON format.
Return ONLY a JSON array, no other text:

[
  {
    "claim": "A specific factual claim or finding",
    "source_name": "Name of the publication or organization",
    "source_url": "URL of the source",
    "source_date": "Publication date if available, or 'unknown'",
    "confidence": "high|medium|low"
  }
]

Rules:
- Only include claims that are directly stated in the sources, not inferences.
- Each claim should be a single, specific, verifiable statement.
- Include 5-15 claims from across different sources.
- Prefer recent sources (last 30 days).
- Return ONLY valid JSON. No markdown fencing.`
      }]
    });

    const textBlocks = response.content.filter(b => b.type === "text");
    const rawText = textBlocks.map(b => b.text).join("\n").trim();
    const cleaned = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      await logActivity("warn", "web_search_no_json", { cycleId, rawLength: rawText.length });
      return [];
    }

    const claims = JSON.parse(jsonMatch[0]);

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

/*
The function feeds into `gatherWebSearchMaterial()`. Here's the chain:

1. `conductResearch()` calls `gatherWebSearchMaterial(topic, angle, cycleId)`
2. `gatherWebSearchMaterial()` calls `buildSearchQueries(topicId, angle)` to get 3 query strings
3. Those queries are sent to Anthropic with the `web_search` tool enabled
4. Anthropic searches the web using those queries and returns claims
5. The claims are scored, corroborated, and fed to the content generator as research material

For an original topic like `cybersecurity-incidents`, the queries are crafted to find
 relevant content — "recent cybersecurity breach ransomware", "ransomware incident report".
 These produce targeted results that the corroboration engine can work with.
 Better queries → better sources → higher verified claim count → post passes the quality gate.

For a new topic, it's not skipped — it still runs. But the two generic queries produce unfocused results.
 The web search returns broad, shallow content instead of domain-specific material.
 Fewer claims corroborate across sources, so the `hasEnoughMaterial` check is more likely to fail,
 and the post gets blocked with "insufficient sources."

The chain:

1 content-generator.js::selectNextTopic(userSub) — picks a topic from DB via topic-store.js::getTopicsForGeneration(userSub)
2 content-generator.js::selectContentAngle(topic, recentPosts) — reads topic.content_angles (the JSONB array from the database), picks one angle string
3 That angle string is passed to conductResearch(topic.slug, angle, cycleId, ...)
4 research.js::buildSearchQueries(topicId, angle) — extracts keywords from that angle via extractKeywords(angle)

**/
function _buildSearchQueries(topicId, angle) {
  const kw = extractKeywords(angle);
  const queries = {
    "cybersecurity-incidents": [
      `${angle} 2025 2026`, `recent cybersecurity breach ${kw}`, `${kw} incident report`
    ],
    "cybersecurity-advances": [
      `${angle} new technology 2025 2026`, `${kw} cybersecurity advancement`, `${kw} security tool release`
    ],
    "ai-practical-benefit": [
      `${angle} real world results`, `${kw} AI implementation case study`, `${kw} enterprise AI 2025 2026`
    ],
    "ai-guardrails": [
      `${angle} AI safety framework`, `${kw} AI governance policy`, `${kw} responsible AI implementation`
    ]
  };
  return queries[topicId] || [`${angle}`, `${kw} latest news`];
}
function buildSearchQueries(topicId, angle) {
  const kw = extractKeywords(angle);
  const year = new Date().getFullYear();
  const yearRange = `${year - 1} ${year}`;
  const queries = {
    "cybersecurity-incidents": [
      `${angle} ${yearRange}`, `recent cybersecurity breach ${kw}`, `${kw} incident report`
    ],
    "cybersecurity-advances": [
      `${angle} new technology ${yearRange}`, `${kw} cybersecurity advancement`, `${kw} security tool release`
    ],
    "ai-practical-benefit": [
      `${angle} real world results`, `${kw} AI implementation case study`, `${kw} enterprise AI ${yearRange}`
    ],
    "ai-guardrails": [
      `${angle} AI safety framework`, `${kw} AI governance policy`, `${kw} responsible AI implementation`
    ]
  };
  if (queries[topicId]) return queries[topicId];

  // Generic catchall for any topic not in the map above
  const topicName = topicId.replace(/-/g, ' ');
  return [
    `${topicName} ${kw} ${yearRange}`,
    `${kw} ${topicName} case study analysis`,
    `${topicName} ${kw} expert report`
  ];
}

function extractKeywords(text) {
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "are", "was",
    "has", "have", "been", "being", "will", "would", "could", "should",
    "their", "about", "into", "through", "during", "before", "after"
  ]);
  return text.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .slice(0, 5).join(" ");
}

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

async function corroborateClaims(allSources, cycleId) {
  if (allSources.length === 0) {
    await logActivity("warn", "corroboration_no_sources", { cycleId });
    return { verified: [], belowThreshold: [], uncorroborated: [] };
  }

  await logActivity("info", "corroboration_started", { cycleId, sourceCount: allSources.length });

  try {
    const client = await newAnthropicClient();
    const model = await getAnthropicModel();
    const response = await callAnthropic(client, {
      model,
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: `You are a fact-checking analyst. Analyze these source materials and identify claims that are corroborated by multiple independent sources.

SOURCE MATERIALS:
${allSources.map((s, i) => `[${i + 1}] ${s.name} (${s.tier}, ${s.date}): ${s.text}`).join("\n\n")}

TASK:
1. Group related claims that describe the same event, finding, or fact.
2. For each group, determine if the claim is corroborated (appears in 2+ INDEPENDENT sources — same parent organization doesn't count).
3. Assess factual confidence.
4. REJECT any claim that contains a specific statistic or percentage unless that exact number appears in at least 2 independent sources.

Return ONLY valid JSON:
{
  "corroborated_claims": [
    {
      "claim": "The specific corroborated fact",
      "source_indices": [1, 4, 7],
      "source_count": 3,
      "confidence": "high|medium",
      "category": "event|statistic|announcement|analysis"
    }
  ],
  "uncorroborated_claims": [
    {
      "claim": "A claim from only one source",
      "source_index": 2,
      "reason": "single source only"
    }
  ]
}`
      }]
    });

    const rawText = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const cleaned = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
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

export async function conductResearch(topicId, angle, cycleId = null, skipCorroboration = false) {
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
  const webClaims = await gatherWebSearchMaterial(topic, angle, cycleId);

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
    await logActivity("info", "rate_limit_cooldown", { cycleId, message: "Waiting 65s before corroboration call" });
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));

    const corrobStart = Date.now();
    const corroboration = await corroborateClaims(allSources, cycleId);
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

  return brief;
}
