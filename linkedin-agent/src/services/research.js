// ═══════════════════════════════════════════════════════════════
// Research Service — RSS + web search, direct source brief
// ═══════════════════════════════════════════════════════════════
//
// Pipeline: RSS articles + live web search → source brief
//
// No separate corroboration API call. The generator receives
// raw source material and is responsible for attribution.
// Posts are blocked if fewer than 2 independent sources exist.
// ═══════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import { getArticlesForTopic } from "./news-monitor.js";
import { logActivity } from "./database.js";
import { TOPICS } from "../config/topics.js";
import { TRUST_TIERS, SOURCE_RULES } from "../config/feeds.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ═══════════════════════════════════════════════════════════════
// Step 1: Gather material from RSS (no API call)
// ═══════════════════════════════════════════════════════════════

function gatherRSSMaterial(topicId, angle) {
  const maxAge = SOURCE_RULES.maxAgeDays[topicId] || 14;
  const articles = getArticlesForTopic(topicId, maxAge, 30);

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
// Step 2: Gather material from web search (1 API call)
// ═══════════════════════════════════════════════════════════════

async function gatherWebSearchMaterial(topicId, angle) {
  const topic = TOPICS.find(t => t.id === topicId);
  const topicName = topic?.name || topicId;
  const searchQueries = buildSearchQueries(topicId, angle);

  logActivity("info", "web_search_started", { topicId, queries: searchQueries });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
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
      logActivity("warn", "web_search_no_json", { rawLength: rawText.length });
      return [];
    }

    const claims = JSON.parse(jsonMatch[0]);

    logActivity("info", "web_search_complete", {
      claimsFound: claims.length,
      sources: [...new Set(claims.map(c => c.source_name))].length
    });

    return claims;
  } catch (err) {
    logActivity("error", "web_search_failed", { error: err.message });
    return [];
  }
}

function buildSearchQueries(topicId, angle) {
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

// ═══════════════════════════════════════════════════════════════
// Step 3: Build source brief (no API call — just formatting)
// ═══════════════════════════════════════════════════════════════

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

function buildSourceBrief(rssArticles, webClaims) {
  const allSources = [];

  // Add web search claims
  for (const claim of webClaims) {
    allSources.push({
      type: "web_search",
      name: claim.source_name,
      url: claim.source_url,
      date: claim.source_date,
      text: claim.claim,
      confidence: claim.confidence,
      tier: classifySourceTier(claim.source_name)
    });
  }

  // Add RSS articles
  for (const article of rssArticles) {
    allSources.push({
      type: "rss",
      name: article.feed_name,
      url: article.link,
      date: article.published_at,
      text: `${article.title}: ${(article.summary || "").slice(0, 300)}`,
      confidence: "high",
      tier: article.feed_tier
    });
  }

  // Count independent sources (distinct names)
  const uniqueSourceNames = new Set(allSources.map(s => s.name.toLowerCase().trim()));
  const independentCount = uniqueSourceNames.size;
  const hasEnoughMaterial = independentCount >= SOURCE_RULES.minIndependentSources;

  // Build the source list for citations
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

  // Build context block for the content generator
  let context = `SOURCE MATERIAL (from ${independentCount} independent sources):\n\n`;

  for (const [i, s] of allSources.entries()) {
    const srcRef = sourceMap.get(s.url || s.name)?.citationIndex || "?";
    context += `[${srcRef}] (${s.tier}, ${s.type}) ${s.name} (${s.date || "undated"}):\n`;
    context += `   ${s.text}\n\n`;
  }

  context += "SOURCE LIST:\n";
  for (const src of sourceList) {
    context += `[${src.citationIndex}] ${src.name}${src.url ? ` — ${src.url}` : ""} (${src.date || "undated"}, tier: ${src.tier})\n`;
  }

  return {
    context,
    sourceList,
    sourceCount: sourceList.length,
    independentSourceCount: independentCount,
    hasEnoughMaterial,
    summary: {
      rssArticles: rssArticles.length,
      webClaims: webClaims.length,
      independentSources: independentCount,
      totalSourceItems: allSources.length
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════

export async function conductResearch(topicId, angle) {
  logActivity("info", "research_started", { topicId, angle });

  // Step 1: RSS (instant, no API call)
  const rssArticles = gatherRSSMaterial(topicId, angle);

  // Step 2: Web search (1 API call)
  const webClaims = await gatherWebSearchMaterial(topicId, angle);

  logActivity("info", "research_material_gathered", {
    rssArticles: rssArticles.length,
    webClaims: webClaims.length
  });

  // Step 3: Build brief (no API call — just formatting)
  const brief = buildSourceBrief(rssArticles, webClaims);

  logActivity("info", "research_complete", {
    topicId,
    independentSources: brief.independentSourceCount,
    hasEnoughMaterial: brief.hasEnoughMaterial,
    totalItems: brief.summary.totalSourceItems
  });

  return brief;
}
