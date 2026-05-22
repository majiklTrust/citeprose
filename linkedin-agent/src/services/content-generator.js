// ═══════════════════════════════════════════════════════════════
// Content Generation Service — Anthropic Claude integration
// ═══════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { getLastPostedTopic, getRecentPosts, getAgentState, logActivity } from "./database.js";
import { platformLog } from "./platform-log.js";
import { frameUntrustedContent } from "./prompt-framing.js";
import { getAnthropicApiKey } from "../tenant/credential-store.js";
import { getAnthropicModel, callAnthropic } from "../config/ai.js";
import { getCooldownMs } from "../config/research.js";
import { getTopicsForGeneration, getTopicBySlug } from "../tenant/topic-store.js";

// Anthropic client is constructed per-call using the tenant's
// BYOK key fetched from the credential store. Module-level
// caching would leak keys across tenants.
async function newAnthropicClient() {
  const apiKey = await getAnthropicApiKey();
  return new Anthropic({ apiKey });
}

// ── Topic Selection ──────────────────────────────────────────

// userSub: null = global topics only (scheduler/automated),
//          string = global + that user's personal topics (manual preview).
export async function selectNextTopic(userSub = null) {
  const lastTopicId = await getLastPostedTopic();
  const recentPosts = await getRecentPosts(14);
  const allTopics = await getTopicsForGeneration(userSub);

  if (allTopics.length === 0) {
    throw new Error("No enabled topics available for content generation");
  }

  const recentCounts = {};
  for (const post of recentPosts) {
    recentCounts[post.topic_id] = (recentCounts[post.topic_id] || 0) + 1;
  }

  // Total weight for normalization
  const totalWeight = allTopics.reduce((sum, t) => sum + (t.weight || 1), 0);

  const candidates = allTopics
    .filter(t => t.slug !== lastTopicId)
    .map(topic => {
      const baseWeight = (topic.weight || 1) / totalWeight;
      const recentCount = recentCounts[topic.slug] || 0;
      const totalRecent = recentPosts.length || 1;
      const expectedShare = baseWeight;
      const actualShare = recentCount / totalRecent;
      const balanceFactor = expectedShare / Math.max(actualShare, 0.05);
      return { topic, weight: baseWeight * Math.min(balanceFactor, 3.0) };
    });

  if (candidates.length === 0) {
    // All topics were filtered (only one topic and it was last posted)
    const fallback = allTopics.map(t => ({
      topic: t,
      weight: (t.weight || 1) / totalWeight
    }));
    return fallback[Math.floor(Math.random() * fallback.length)].topic;
  }

  const candidateTotal = candidates.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * candidateTotal;

  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate.topic;
  }

  return candidates[candidates.length - 1].topic;
}

// ── Content Angle Selection ──────────────────────────────────

function selectContentAngle(topic, recentPosts) {
  const angles = topic.content_angles || [];
  if (angles.length === 0) return "General discussion";

  const recentSameTopic = recentPosts
    .filter(p => p.topic_id === topic.slug)
    .slice(0, 5);

  const usedAngles = new Set();
  for (const post of recentSameTopic) {
    for (let i = 0; i < angles.length; i++) {
      const angleWords = angles[i].toLowerCase().split(/\s+/);
      const postWords = post.content.toLowerCase();
      const matchCount = angleWords.filter(w => w.length > 4 && postWords.includes(w)).length;
      if (matchCount >= 3) usedAngles.add(i);
    }
  }

  const availableIndices = angles
    .map((_, i) => i)
    .filter(i => !usedAngles.has(i));

  const pool = availableIndices.length > 0
    ? availableIndices
    : angles.map((_, i) => i);

  const idx = pool[Math.floor(Math.random() * pool.length)];
  return angles[idx];
}

// ── Post Generation ──────────────────────────────────────────

export async function getTopicByIdFromDb(topicId) {
  return getTopicBySlug(topicId);
}

export async function getAvailableTopics(userSub = null) {
  const topics = await getTopicsForGeneration(userSub);
  return topics.map(t => ({ id: t.slug, name: t.name }));
}

export async function generatePost(topic = null, userSub = null) {
  if (typeof topic === "string") {
    topic = await getTopicBySlug(topic);
  }
  if (!topic) topic = await selectNextTopic(userSub);

  const cycleId = crypto.randomBytes(4).toString("hex");

  // Read corroboration toggle from agent state
  const skipCorroboration = (await getAgentState("corroboration")) === "disabled";

  const recentPosts = await getRecentPosts(14);
  const angle = selectContentAngle(topic, recentPosts);

  // ── Research phase ─────────────────────────────────────────
  let researchBrief = null;
  try {
    const { conductResearch } = await import("./research.js");
    researchBrief = await conductResearch(topic.slug, angle, cycleId, skipCorroboration);

    await logActivity("info", "research_integrated", {
      cycleId,
      topicId: topic.slug,
      corroborationSkipped: skipCorroboration,
      verifiedClaims: researchBrief.verifiedClaimCount,
      independentSources: researchBrief.independentSourceCount,
      totalItems: researchBrief.summary.totalSourceItems,
      hasEnoughMaterial: researchBrief.hasEnoughMaterial
    });
    platformLog("info", "research_integrated", {
      cycleId, topicId: topic.slug,
      verified: researchBrief.verifiedClaimCount,
      sources: researchBrief.independentSourceCount,
      items: researchBrief.summary.totalSourceItems,
      enough: researchBrief.hasEnoughMaterial
    });
  } catch (err) {
    await logActivity("warn", "research_unavailable", {
      cycleId, topicId: topic.slug, error: err.message
    });
  }

  // ── Block if sources are insufficient ──────────────────────
  if (!researchBrief || !researchBrief.hasEnoughMaterial) {
    const reason = !researchBrief
      ? "Research service unavailable"
      : skipCorroboration
        ? `Only ${researchBrief.independentSourceCount} independent source(s) found; minimum is 2`
        : `Only ${researchBrief.verifiedClaimCount || 0} verified claim(s) found; minimum is 1 from 2+ independent sources`;

    await logActivity("info", "post_blocked_insufficient_sources", {
      cycleId, topicId: topic.slug, angle, reason
    });
    platformLog("warn", "post_blocked_insufficient_sources", {
      cycleId, topicId: topic.slug, reason
    });

    return { blocked: true, reason, topicId: topic.slug, angle, cycleId };
  }

  // ── Rate limit cooldown before generation ──────────────────
  const cooldown = getCooldownMs();
  await logActivity("info", "rate_limit_cooldown", { cycleId, message: `Waiting ${cooldown / 1000}s before content generation` });
  await new Promise(resolve => setTimeout(resolve, cooldown));

  // Build context about what was recently posted to avoid repetition
  const recentSummaries = recentPosts.slice(0, 6).map(p =>
    `- [${p.topic_id}] "${p.title}"`
  ).join("\n");

  // ── Prompt: different rules based on corroboration toggle ──
  let researchBlock;

  if (!skipCorroboration) {
    researchBlock = `
RESEARCH BRIEF (use ONLY these verified facts as the basis for your post):
${frameUntrustedContent(researchBrief.context)}

CRITICAL SOURCE RULES:
- You may ONLY state facts that appear in the "VERIFIED FACTS" section above.
- For claims marked "UNCORROBORATED", DO NOT include them. Omit entirely.
- Do NOT invent, embellish, or extrapolate beyond what the sources state.
- Do NOT use any specific statistic, percentage, or number that is not in the verified facts.
- Reference source names naturally in the post body (e.g., "according to Krebs on Security" or "as reported by CISA").
- At the end of the post body, include a "Sources:" line listing key references by name.
- After the Sources line, include this exact attestation on its own line:
  "Sources verified through multi-source corroboration. Full source list available upon request."
`;
  } else {
    researchBlock = `
SOURCE MATERIAL (${researchBrief.independentSourceCount} independent sources — corroboration step was skipped):
${frameUntrustedContent(researchBrief.context)}

ATTRIBUTION RULES:
- Base ALL factual claims on the source material above. Do not invent or embellish.
- Reference source names naturally in the post body (e.g., "according to Krebs on Security" or "as reported by CISA").
- If a claim comes from a single source, use hedging: "one report suggests" or "according to [source]".
- Claims appearing in multiple sources can be stated more directly, with attribution.
- Do NOT use any specific statistic, percentage, or number unless it appears in the source material.
- At the end of the post body, include a "Sources:" line listing the key references by name.
`;
  }

  const topicHashtags = topic.hashtags || [];

  const userPrompt = `Write a LinkedIn post about the following topic area and angle.

TOPIC AREA: ${topic.name}
SPECIFIC ANGLE: ${angle}
${researchBlock}
RECENT POSTS (avoid repeating these themes):
${recentSummaries || "(no recent posts)"}

REQUIREMENTS:
1. Length: 150–280 words. LinkedIn truncates at ~210 characters with a "see more" — 
   make the first 1–2 sentences count as a compelling hook.
2. Write in first person. Sound like a thoughtful practitioner, not a thought-leadership bot.
3. Include ONE concrete example, analogy, or mini-case-study grounded in the research provided.
4. End with a question or call-to-reflection (not a hard CTA).
5. Do NOT use emoji. Do NOT use bullet points in excess — 
   at most 3–4 short bullets if listing is genuinely the clearest format.
6. Do NOT use en dashes (–) or em dashes (—) anywhere in the post.  The only exception is inside a direct quotation from a cited source — if you quote a passage verbatim that contains an en dash or an em dash, you may preserve it.  In all other non-exception cases, when you would otherwise add en dashes or em dashes yourself (for emphasis, asides, or pacing) the phrase or combination of phrases must be replaced with commas, parentheses, sentence breaks, or otherwise intelligently.  This is a hard rule.
7. Avoid clichés: "game-changer", "in today's rapidly evolving landscape", 
   "it's not a matter of if but when", "the future is here".
8. Do NOT include hashtags in the body — they will be appended separately.
9. Include natural source attribution within the post and a "Sources:" line at the end.${!skipCorroboration ? '\n10. Include the attestation line after the Sources line.' : ''}

Respond in this exact JSON format:
{
  "title": "A short internal title for this post (not published, just for tracking)",
  "hook": "The opening 1-2 sentences designed to appear before the fold",
  "body": "The full post content including the hook and Sources: line${!skipCorroboration ? ' and attestation line' : ''}",
  "hashtags": ["#Tag1", "#Tag2", "#Tag3"],
  "sources_used": ["Source Name 1", "Source Name 2"]
}

Return ONLY valid JSON. No markdown fencing, no preamble.`;

  await logActivity("info", "content_generation_started", { cycleId, topicId: topic.slug, angle });
  platformLog("info", "content_generation_started", { cycleId, topicId: topic.slug, angle });

  const genStartMs = Date.now();

  try {
    const client = await newAnthropicClient();
    const model = await getAnthropicModel();
    const response = await callAnthropic(client, {
      model,
      max_tokens: 1500,
      system: topic.system_context,
      messages: [{ role: "user", content: userPrompt }]
    });

    const raw = response.content[0].text.trim();
    const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);

    const allHashtags = [...new Set([
      ...parsed.hashtags,
      ...topicHashtags
    ])].slice(0, 6);

    const genDurationMs = Date.now() - genStartMs;
    const genSuccessDetails = {
      cycleId,
      topicId: topic.slug,
      model,
      title: parsed.title,
      wordCount: parsed.body.split(/\s+/).length,
      sourcesUsed: (parsed.sources_used || []).length,
      durationMs: genDurationMs
    };

    await logActivity("info", "content_generation_success", genSuccessDetails);
    platformLog("info", "content_generation_success", genSuccessDetails);

    return {
      cycleId,
      topicId: topic.slug,
      title: parsed.title,
      content: parsed.body,
      hashtags: allHashtags,
      angle,
      sourcesUsed: parsed.sources_used || [],
      articleImages: researchBrief.articleImages || [],
      researchSummary: {
        verifiedClaims: researchBrief.verifiedClaimCount,
        independentSources: researchBrief.independentSourceCount,
        totalSourceItems: researchBrief.summary.totalSourceItems,
        corroborationSkipped: skipCorroboration,
        sourceList: researchBrief.sourceList || []
      }
    };
  } catch (err) {
    await logActivity("error", "content_generation_failed", {
      cycleId, topicId: topic.slug, error: err.message
    });
    platformLog("error", "content_generation_failed", {
      cycleId, topicId: topic.slug, error: err.message
    });
    throw err;
  }
}

// ── Content Quality Check ────────────────────────────────────

export async function qualityCheck(content, researchSummary = null, cycleId = null) {
  const sourceContext = researchSummary
    ? `\nSOURCES PROVIDED TO THE WRITER:\n${researchSummary.sourceList?.map(s => `- ${s.name} (${s.tier})`).join("\n") || "(none)"}\nVerified claims (corroborated by 2+ sources): ${researchSummary.verifiedClaims || 0}\nIndependent sources consulted: ${researchSummary.independentSources || 0}\nCorroboration step: ${researchSummary.corroborationSkipped ? 'SKIPPED' : 'COMPLETED'}`
    : "\n(No research brief was provided — post should avoid specific factual claims)";

  const client = await newAnthropicClient();
  const model = await getAnthropicModel();
  const response = await callAnthropic(client, {
    model,
    max_tokens: 800,
    messages: [{
      role: "user",
      content: `You are a LinkedIn content quality and accuracy reviewer. Evaluate this post and respond with ONLY valid JSON.

POST:
"""
${content}
"""
${sourceContext}

Evaluate on these criteria (1-10 each):
- hook_strength: Will the first 2 lines make someone click "see more"?
- authenticity: Does it sound like a real practitioner, not a bot?
- actionability: Does the reader walk away with something useful?
- engagement_potential: Will people comment or share?
- professionalism: Appropriate for a cybersecurity/AI professional audience?
- source_grounding: Are claims attributed to named sources? Does the post include a Sources line? (Score 1 if no sources and post makes specific claims)
- factual_caution: Does the post avoid stating unverified claims as fact? (Score 1 if it presents speculation as established fact)

{
  "scores": {
    "hook_strength": 0,
    "authenticity": 0,
    "actionability": 0,
    "engagement_potential": 0,
    "professionalism": 0,
    "source_grounding": 0,
    "factual_caution": 0
  },
  "overall": 0,
  "pass": true,
  "factual_flags": ["List any specific claims that appear unverified or unsupported"],
  "feedback": "Brief constructive note if score < 7"
}

IMPORTANT: Set "pass" to false if source_grounding < 5 OR factual_caution < 5, regardless of other scores.

Return ONLY valid JSON.`
    }]
  });

  const raw = response.content[0].text.trim();
  const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}
