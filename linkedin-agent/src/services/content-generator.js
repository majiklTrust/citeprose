// ═══════════════════════════════════════════════════════════════
// Content Generation Service — Anthropic Claude integration
// ═══════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import { TOPICS, ROTATION_CONFIG } from "../config/topics.js";
import { getLastPostedTopic, getRecentPosts, logActivity } from "./database.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Topic Selection ──────────────────────────────────────────

export function selectNextTopic() {
  const lastTopicId = getLastPostedTopic();
  const recentPosts = getRecentPosts(14);  // 2-week lookback

  // Count recent posts per topic
  const recentCounts = {};
  for (const post of recentPosts) {
    recentCounts[post.topic_id] = (recentCounts[post.topic_id] || 0) + 1;
  }

  // Build weighted candidates, excluding consecutive same-topic
  const candidates = TOPICS.filter(t => t.id !== lastTopicId).map(topic => {
    const baseWeight = ROTATION_CONFIG.weights[topic.id] || 0.25;
    const recentCount = recentCounts[topic.id] || 0;

    // Boost topics that have been underrepresented recently
    const totalRecent = recentPosts.length || 1;
    const expectedShare = baseWeight;
    const actualShare = recentCount / totalRecent;
    const balanceFactor = expectedShare / Math.max(actualShare, 0.05);

    return {
      topic,
      weight: baseWeight * Math.min(balanceFactor, 3.0)
    };
  });

  // If all topics were excluded (edge case), allow any
  if (candidates.length === 0) {
    candidates.push(...TOPICS.map(t => ({ topic: t, weight: 0.25 })));
  }

  // Weighted random selection
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
  // Avoid repeating recent angles by checking content similarity
  const recentSameTopic = recentPosts
    .filter(p => p.topic_id === topic.id)
    .slice(0, 5);

  const usedAngles = new Set();
  for (const post of recentSameTopic) {
    // Simple heuristic: mark angles whose keywords appear in recent posts
    for (let i = 0; i < topic.contentAngles.length; i++) {
      const angleWords = topic.contentAngles[i].toLowerCase().split(/\s+/);
      const postWords = post.content.toLowerCase();
      const matchCount = angleWords.filter(w => w.length > 4 && postWords.includes(w)).length;
      if (matchCount >= 3) usedAngles.add(i);
    }
  }

  // Pick a random unused angle
  const availableIndices = topic.contentAngles
    .map((_, i) => i)
    .filter(i => !usedAngles.has(i));

  const pool = availableIndices.length > 0
    ? availableIndices
    : topic.contentAngles.map((_, i) => i);  // fallback: all angles

  const idx = pool[Math.floor(Math.random() * pool.length)];
  return topic.contentAngles[idx];
}

// ── Post Generation ──────────────────────────────────────────

export async function generatePost(topic = null) {
  if (!topic) topic = selectNextTopic();

  const recentPosts = getRecentPosts(14);
  const angle = selectContentAngle(topic, recentPosts);

  // Build context about what was recently posted to avoid repetition
  const recentSummaries = recentPosts.slice(0, 6).map(p =>
    `- [${p.topic_id}] "${p.title}"`
  ).join("\n");

  const userPrompt = `Write a LinkedIn post about the following topic area and angle.

TOPIC AREA: ${topic.name}
SPECIFIC ANGLE: ${angle}

RECENT POSTS (avoid repeating these themes):
${recentSummaries || "(no recent posts)"}

REQUIREMENTS:
1. Length: 150–280 words. LinkedIn truncates at ~210 characters with a "see more" — 
   make the first 1–2 sentences count as a compelling hook.
2. Write in first person. Sound like a thoughtful practitioner, not a thought-leadership bot.
3. Include ONE concrete example, analogy, or mini-case-study.
4. End with a question or call-to-reflection (not a hard CTA).
5. Do NOT use emoji. Do NOT use bullet points in excess — 
   at most 3–4 short bullets if listing is genuinely the clearest format.
6. Avoid clichés: "game-changer", "in today's rapidly evolving landscape", 
   "it's not a matter of if but when", "the future is here".
7. Do NOT include hashtags in the body — they will be appended separately.

Respond in this exact JSON format:
{
  "title": "A short internal title for this post (not published, just for tracking)",
  "hook": "The opening 1-2 sentences designed to appear before the fold",
  "body": "The full post content including the hook",
  "hashtags": ["#Tag1", "#Tag2", "#Tag3"]
}

Return ONLY valid JSON. No markdown fencing, no preamble.`;

  logActivity("info", "content_generation_started", { topicId: topic.id, angle });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system: topic.systemContext,
      messages: [{ role: "user", content: userPrompt }]
    });

    const raw = response.content[0].text.trim();
    // Strip potential markdown fencing
    const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);

    // Merge topic hashtags with generated ones, deduplicate
    const allHashtags = [...new Set([
      ...parsed.hashtags,
      ...topic.hashtags
    ])].slice(0, 6);

    logActivity("info", "content_generation_success", {
      topicId: topic.id,
      title: parsed.title,
      wordCount: parsed.body.split(/\s+/).length
    });

    return {
      topicId: topic.id,
      title: parsed.title,
      content: parsed.body,
      hashtags: allHashtags,
      angle
    };
  } catch (err) {
    logActivity("error", "content_generation_failed", {
      topicId: topic.id,
      error: err.message
    });
    throw err;
  }
}

// ── Content Quality Check ────────────────────────────────────

export async function qualityCheck(content) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 600,
    messages: [{
      role: "user",
      content: `You are a LinkedIn content quality reviewer. Evaluate this post and respond with ONLY valid JSON.

POST:
"""
${content}
"""

Evaluate on these criteria (1-10 each):
- hook_strength: Will the first 2 lines make someone click "see more"?
- authenticity: Does it sound like a real practitioner, not a bot?
- actionability: Does the reader walk away with something useful?
- engagement_potential: Will people comment or share?
- professionalism: Appropriate for a cybersecurity/AI professional audience?

{
  "scores": {
    "hook_strength": 0,
    "authenticity": 0,
    "actionability": 0,
    "engagement_potential": 0,
    "professionalism": 0
  },
  "overall": 0,
  "pass": true,
  "feedback": "Brief constructive note if score < 7"
}

Return ONLY valid JSON.`
    }]
  });

  const raw = response.content[0].text.trim();
  const cleaned = raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}
