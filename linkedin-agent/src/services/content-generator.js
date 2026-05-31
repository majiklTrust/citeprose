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
import { getPrompt, getAuthorizedPrompt, renderPrompt } from "./prompt-vault.js";
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

export async function generatePost(topic = null, userSub = null, actionToken = null) {
  if (typeof topic === "string") {
    topic = await getTopicBySlug(topic);
  }
  if (!topic) topic = await selectNextTopic(userSub);

  const cycleId = crypto.randomBytes(4).toString("hex");

  // Read corroboration toggle from agent state
  const skipCorroboration = (await getAgentState("corroboration")) === "disabled";

  // Vault access: use signed token when triggered by a user request,
  // fall back to internal access for automated/scheduled operations.
  const vaultGet = actionToken
    ? (key) => getAuthorizedPrompt(key, actionToken)
    : (key) => getPrompt(key);

  const recentPosts = await getRecentPosts(14);
  const angle = selectContentAngle(topic, recentPosts);

  // ── Research phase ─────────────────────────────────────────
  let researchBrief = null;
  try {
    const { conductResearch } = await import("./research.js");
    researchBrief = await conductResearch(topic.slug, angle, cycleId, skipCorroboration, actionToken);

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

  // ── Research context: rules differ based on corroboration toggle ──
  let researchBlock;
  const framedContext = await frameUntrustedContent(researchBrief.context, actionToken);

  if (!skipCorroboration) {
    let rbTemplate = await vaultGet("research_brief_corroborated");
    if (!rbTemplate) {
      platformLog("error", "prompt_vault_miss", { key: "research_brief_corroborated" });
      throw new Error("Research brief prompt (corroborated) not configured");
    }
    researchBlock = renderPrompt(rbTemplate, {
      RESEARCH_CONTEXT: framedContext
    });
    rbTemplate = null;
  } else {
    let rbTemplate = await vaultGet("research_brief_uncorroborated");
    if (!rbTemplate) {
      platformLog("error", "prompt_vault_miss", { key: "research_brief_uncorroborated" });
      throw new Error("Research brief prompt (uncorroborated) not configured");
    }
    researchBlock = renderPrompt(rbTemplate, {
      RESEARCH_CONTEXT: framedContext,
      SOURCE_COUNT: String(researchBrief.independentSourceCount)
    });
    rbTemplate = null;
  }

  const topicHashtags = topic.hashtags || [];

  let cgTemplate = await vaultGet("content_generator");
  if (!cgTemplate) {
    platformLog("error", "prompt_vault_miss", { key: "content_generator" });
    throw new Error("Content generation prompt not configured");
  }
  let userPrompt = renderPrompt(cgTemplate, {
    TOPIC_NAME: topic.name,
    ANGLE: angle,
    RESEARCH_BLOCK: researchBlock,
    RECENT_SUMMARIES: recentSummaries || "(no recent posts)",
    ATTESTATION_RULE: !skipCorroboration ? "\n10. Include the attestation line after the Sources line." : "",
    ATTESTATION_BODY: !skipCorroboration ? " and attestation line" : ""
  });
  cgTemplate = null;

  await logActivity("info", "content_generation_started", { cycleId, topicId: topic.slug, angle });
  platformLog("info", "content_generation_started", { cycleId, topicId: topic.slug, angle });

  const genStartMs = Date.now();

  try {
    const client = await newAnthropicClient();
    const model = await getAnthropicModel();
    const response = await callAnthropic(client, {
      model,
      max_tokens: 1500,
      system: topic.system_context || undefined,
      messages: [{ role: "user", content: userPrompt }]
    });
    userPrompt = null;

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
      cycleId, topicId: topic.slug, error: err.message,
      code: err.code, status: err.status, type: err.constructor?.name,
      stack: (err.stack || "").split("\n").slice(0, 3).join(" | ")
    });
    throw err;
  }
}

// ── Content Quality Check ────────────────────────────────────

export async function qualityCheck(content, researchSummary = null, cycleId = null, actionToken = null) {
  const sourceContext = researchSummary
    ? `\nSOURCES PROVIDED TO THE WRITER:\n${researchSummary.sourceList?.map(s => `- ${s.name} (${s.tier})`).join("\n") || "(none)"}\nVerified claims (corroborated by 2+ sources): ${researchSummary.verifiedClaims || 0}\nIndependent sources consulted: ${researchSummary.independentSources || 0}\nCorroboration step: ${researchSummary.corroborationSkipped ? 'SKIPPED' : 'COMPLETED'}`
    : "\n(No research brief was provided — post should avoid specific factual claims)";

  const client = await newAnthropicClient();
  const model = await getAnthropicModel();

  const qVaultGet = actionToken
    ? (key) => getAuthorizedPrompt(key, actionToken)
    : (key) => getPrompt(key);

  // Retrieve prompt template from encrypted vault
  let template = await qVaultGet("quality_reviewer");
  if (!template) {
    platformLog("error", "prompt_vault_miss", { key: "quality_reviewer" });
    return null;
  }
  let assembledPrompt = renderPrompt(template, {
    CONTENT: content,
    SOURCE_CONTEXT: sourceContext
  });
  template = null;

  const response = await callAnthropic(client, {
    model,
    max_tokens: 800,
    messages: [{ role: "user", content: assembledPrompt }]
  });
  assembledPrompt = null;

  const raw = response.content[0].text.trim();
  const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}
