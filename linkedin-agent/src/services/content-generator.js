// ═══════════════════════════════════════════════════════════════
// Content Generation Service — Anthropic Claude integration
// ═══════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { TOPICS, ROTATION_CONFIG } from "../config/topics.js";
import { getLastPostedTopic, getRecentPosts, getAgentState, logActivity } from "./database.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Topic Selection ──────────────────────────────────────────

export function selectNextTopic() {
  const lastTopicId = getLastPostedTopic();
  const recentPosts = getRecentPosts(14);

  const recentCounts = {};
  for (const post of recentPosts) {
    recentCounts[post.topic_id] = (recentCounts[post.topic_id] || 0) + 1;
  }

  const candidates = TOPICS.filter(t => t.id !== lastTopicId).map(topic => {
    const baseWeight = ROTATION_CONFIG.weights[topic.id] || 0.25;
    const recentCount = recentCounts[topic.id] || 0;
    const totalRecent = recentPosts.length || 1;
    const expectedShare = baseWeight;
    const actualShare = recentCount / totalRecent;
    const balanceFactor = expectedShare / Math.max(actualShare, 0.05);
    return { topic, weight: baseWeight * Math.min(balanceFactor, 3.0) };
  });

  if (candidates.length === 0) {
    candidates.push(...TOPICS.map(t => ({ topic: t, weight: 0.25 })));
  }

  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate.topic;
  }

  return candidates[candidates.length - 1].topic;
}

// ── Content Angle Selection ──────────────────────────────────

function selectContentAngle(topic, recentPosts) {
  const recentSameTopic = recentPosts
    .filter(p => p.topic_id === topic.id)
    .slice(0, 5);

  const usedAngles = new Set();
  for (const post of recentSameTopic) {
    for (let i = 0; i < topic.contentAngles.length; i++) {
      const angleWords = topic.contentAngles[i].toLowerCase().split(/\s+/);
      const postWords = post.content.toLowerCase();
      const matchCount = angleWords.filter(w => w.length > 4 && postWords.includes(w)).length;
      if (matchCount >= 3) usedAngles.add(i);
    }
  }

  const availableIndices = topic.contentAngles
    .map((_, i) => i)
    .filter(i => !usedAngles.has(i));

  const pool = availableIndices.length > 0
    ? availableIndices
    : topic.contentAngles.map((_, i) => i);

  const idx = pool[Math.floor(Math.random() * pool.length)];
  return topic.contentAngles[idx];
}

// ── Post Generation ──────────────────────────────────────────

export function getTopicById(topicId) {
  return TOPICS.find(t => t.id === topicId) || null;
}

export function getAllTopicIds() {
  return TOPICS.map(t => ({ id: t.id, name: t.name }));
}

export async function generatePost(topic = null) {
  if (typeof topic === "string") {
    topic = getTopicById(topic);
  }
  if (!topic) topic = selectNextTopic();

  const cycleId = crypto.randomBytes(4).toString("hex");

  // Read corroboration toggle from agent state
  const skipCorroboration = getAgentState("corroboration") === "disabled";

  const recentPosts = getRecentPosts(14);
  const angle = selectContentAngle(topic, recentPosts);

  // ── Research phase ─────────────────────────────────────────
  let researchBrief = null;
  try {
    const { conductResearch } = await import("./research.js");
    researchBrief = await conductResearch(topic.id, angle, cycleId, skipCorroboration);

    logActivity("info", "research_integrated", {
      cycleId,
      topicId: topic.id,
      corroborationSkipped: skipCorroboration,
      verifiedClaims: researchBrief.verifiedClaimCount,
      independentSources: researchBrief.independentSourceCount,
      totalItems: researchBrief.summary.totalSourceItems,
      hasEnoughMaterial: researchBrief.hasEnoughMaterial
    });
  } catch (err) {
    logActivity("warn", "research_unavailable", {
      cycleId, topicId: topic.id, error: err.message
    });
  }

  // ── Block if sources are insufficient ──────────────────────
  if (!researchBrief || !researchBrief.hasEnoughMaterial) {
    const reason = !researchBrief
      ? "Research service unavailable"
      : skipCorroboration
        ? `Only ${researchBrief.independentSourceCount} independent source(s) found; minimum is 2`
        : `Only ${researchBrief.verifiedClaimCount || 0} verified claim(s) found; minimum is 1 from 2+ independent sources`;

    logActivity("info", "post_blocked_insufficient_sources", {
      cycleId, topicId: topic.id, angle, reason
    });

    return { blocked: true, reason, topicId: topic.id, angle, cycleId };
  }

  // ── Rate limit cooldown before generation ──────────────────
  logActivity("info", "rate_limit_cooldown", { cycleId, message: "Waiting 65s before content generation" });
  await new Promise(resolve => setTimeout(resolve, 65000));

  // Build context about what was recently posted to avoid repetition
  const recentSummaries = recentPosts.slice(0, 6).map(p =>
    `- [${p.topic_id}] "${p.title}"`
  ).join("\n");

  // ── Prompt: different rules based on corroboration toggle ──
  let researchBlock;

  if (!skipCorroboration) {
    // Corroboration ON — strict verified-facts-only prompt
    researchBlock = `
RESEARCH BRIEF (use ONLY these verified facts as the basis for your post):
${researchBrief.context}

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
    // Corroboration OFF — attribution-based prompt (less strict)
    researchBlock = `
SOURCE MATERIAL (${researchBrief.independentSourceCount} independent sources — corroboration step was skipped):
${researchBrief.context}

ATTRIBUTION RULES:
- Base ALL factual claims on the source material above. Do not invent or embellish.
- Reference source names naturally in the post body (e.g., "according to Krebs on Security" or "as reported by CISA").
- If a claim comes from a single source, use hedging: "one report suggests" or "according to [source]".
- Claims appearing in multiple sources can be stated more directly, with attribution.
- Do NOT use any specific statistic, percentage, or number unless it appears in the source material.
- At the end of the post body, include a "Sources:" line listing the key references by name.
`;
  }

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
6. Avoid clichés: "game-changer", "in today's rapidly evolving landscape", 
   "it's not a matter of if but when", "the future is here".
7. Do NOT include hashtags in the body — they will be appended separately.
8. Include natural source attribution within the post and a "Sources:" line at the end.${!skipCorroboration ? '\n9. Include the attestation line after the Sources line.' : ''}

Respond in this exact JSON format:
{
  "title": "A short internal title for this post (not published, just for tracking)",
  "hook": "The opening 1-2 sentences designed to appear before the fold",
  "body": "The full post content including the hook and Sources: line${!skipCorroboration ? ' and attestation line' : ''}",
  "hashtags": ["#Tag1", "#Tag2", "#Tag3"],
  "sources_used": ["Source Name 1", "Source Name 2"]
}

Return ONLY valid JSON. No markdown fencing, no preamble.`;

  logActivity("info", "content_generation_started", { cycleId, topicId: topic.id, angle });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: topic.systemContext,
      messages: [{ role: "user", content: userPrompt }]
    });

    const raw = response.content[0].text.trim();
    const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);

    const allHashtags = [...new Set([
      ...parsed.hashtags,
      ...topic.hashtags
    ])].slice(0, 6);

    logActivity("info", "content_generation_success", {
      cycleId, topicId: topic.id,
      title: parsed.title,
      wordCount: parsed.body.split(/\s+/).length
    });

    return {
      cycleId,
      topicId: topic.id,
      title: parsed.title,
      content: parsed.body,
      hashtags: allHashtags,
      angle,
      sourcesUsed: parsed.sources_used || [],
      researchSummary: {
        verifiedClaims: researchBrief.verifiedClaimCount,
        independentSources: researchBrief.independentSourceCount,
        totalSourceItems: researchBrief.summary.totalSourceItems,
        corroborationSkipped: skipCorroboration,
        sourceList: researchBrief.sourceList || []
      }
    };
  } catch (err) {
    logActivity("error", "content_generation_failed", {
      cycleId, topicId: topic.id, error: err.message
    });
    throw err;
  }
}

// ── Content Quality Check ────────────────────────────────────

export async function qualityCheck(content, researchSummary = null, cycleId = null) {
  const sourceContext = researchSummary
    ? `\nSOURCES PROVIDED TO THE WRITER:\n${researchSummary.sourceList?.map(s => `- ${s.name} (${s.tier})`).join("\n") || "(none)"}\nVerified claims (corroborated by 2+ sources): ${researchSummary.verifiedClaims || 0}\nIndependent sources consulted: ${researchSummary.independentSources || 0}\nCorroboration step: ${researchSummary.corroborationSkipped ? 'SKIPPED' : 'COMPLETED'}`
    : "\n(No research brief was provided — post should avoid specific factual claims)";

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
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
