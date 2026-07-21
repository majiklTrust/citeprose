// ═══════════════════════════════════════════════════════════════
// src/routes/topics-api.js — Topic management API
// ═══════════════════════════════════════════════════════════════
// CRUD for topics (global + personal) and AI-powered topic
// generation. Mounted at /api/topics by the app.
//
// Router-level middleware: requireAuth → resolveTenant →
//   requirePermission("manage_own_topics")
// This blocks viewers entirely. Owner vs editor authorization
// is enforced per-handler based on topic ownership.
// ═══════════════════════════════════════════════════════════════

import { suspendedWriteGuard } from "../services/entitlements.js";
import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { hasPermission } from "../tenant/platform-db.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { getFeedsManagerVersion } from "../config/research.js";
import { getAnthropicApiKey } from "../tenant/credential-store.js";
import { getAnthropicModel, callAnthropic, getTopicSearchTemplateMaxTokens, getTopicSuggestionMaxTokens } from "../config/ai.js";
import { validateSearchTemplates, parseSuggestedTemplates } from "../services/search-queries.js";
import { frameUntrustedContent } from "../services/prompt-framing.js";
import {
  listTopicsForUser,
  getTopicById,
  createTopic,
  updateTopic,
  toggleTopic,
  deleteTopic
} from "../tenant/topic-store.js";

const router = Router();

const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

// ── Blanket middleware — blocks viewers ───────────────────────
router.use(requireAuth);
router.use(resolveTenant);
// Payments (2.3.4), ruling (3): outside good standing the tenant
// is read-only. Mutating verbs deny here; billing stays exempt.
router.use(suspendedWriteGuard());

router.use(requirePermission("manage_own_topics"));

// ── Helper: check if user can manage all topics ──────────────
async function canManageAll(role) {
  try { return await hasPermission(role, "manage_topics"); }
  catch { return false; }
}

// ── Helper: ownership check for a specific topic ─────────────
// Returns true if the user is allowed to modify/delete the topic.
// Owner with manage_topics can touch any topic.
// Editor can only touch their own personal topics.
async function canModifyTopic(topic, userSub, role) {
  if (await canManageAll(role)) return true;
  // Personal topic owned by this user
  if (topic.user_sub && topic.user_sub === userSub) return true;
  return false;
}

// ══════════════════════════════════════════════════════════════
// List topics
// ══════════════════════════════════════════════════════════════

router.get("/", async (req, res) => {
  try {
    const isOwner = await canManageAll(req.tenant.role);
    const { topics, fmVersion } = await withTenant(req.tenant.id, async () => {
      return {
        topics: await listTopicsForUser(req.user.sub, isOwner),
        fmVersion: await getFeedsManagerVersion()
      };
    });
    res.json({ topics, feedsManagerVersion: fmVersion });
  } catch (err) {
    platformLog("error", "topics_list_failed", { error: err.message });
    res.status(500).json({ error: "Failed to list topics" });
  }
});

// ══════════════════════════════════════════════════════════════
// Create topic
// ══════════════════════════════════════════════════════════════

router.post("/", async (req, res) => {
  try {
    const { name, description, content_angles, hashtags, weight, scope, domains } = req.body || {};

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "Topic name is required" });
    }

    // Validate domains: must be array of unique lowercase strings.
    // Security guard: domains are silently stripped in v1 mode
    // to prevent pre-population via scripted bypass.
    const fmVersion = await withTenant(req.tenant.id, () => getFeedsManagerVersion());
    const cleanDomains = (fmVersion === 2 && Array.isArray(domains))
      ? [...new Set(domains.map(d => String(d).toLowerCase().trim().substring(0, 50)).filter(Boolean))].slice(0, 20)
      : [];

    const resolvedScope = scope || "personal";

    // Global topics require manage_topics (owner only)
    if (resolvedScope === "global") {
      const allowed = await canManageAll(req.tenant.role);
      if (!allowed) {
        return res.status(403).json({ error: "Permission denied" });
      }
    }

    const topic = await withTenant(req.tenant.id, async () => {
      return createTopic({
        name: name.trim(),
        description: description || "",
        contentAngles: content_angles || [],
        hashtags: hashtags || [],
        systemContext: req.body.system_context || "",
        weight: weight || 1,
        scope: resolvedScope,
        callerSub: req.user.sub,
        domains: cleanDomains
      });
    });

    res.status(201).json(topic);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "A topic with this name already exists" });
    }
    platformLog("error", "topic_create_failed", { error: err.message });
    res.status(500).json({ error: "Failed to create topic" });
  }
});

// ══════════════════════════════════════════════════════════════
// Update topic
// ══════════════════════════════════════════════════════════════

// ── Suggest research instructions (LLM-assisted) ──────────────
// The model PROPOSES templates; the user reviews and adds; Save
// commits — nothing is auto-saved. Zero Trust on both sides of the
// call: tenant-authored topic text is framed before entering the
// prompt, and the model's reply passes parseSuggestedTemplates (the
// same gate as human and API input) before leaving this route.
router.post("/:id/suggest-templates", async (req, res) => {
  try {
    const topic = await withTenant(req.tenant.id, async () => {
      return getTopicById(req.params.id);
    });
    if (!topic) {
      return res.status(404).json({ error: "Topic not found" });
    }
    const allowed = await canModifyTopic(topic, req.user.sub, req.tenant.role);
    if (!allowed) {
      return res.status(403).json({ error: "Permission denied" });
    }

    const apiKey = await withTenant(req.tenant.id, async () => {
      return getAnthropicApiKey();
    });
    if (!apiKey) {
      return res.status(503).json({ error: "Anthropic API key not configured" });
    }
    const client = new Anthropic({ apiKey });
    const model = await withTenant(req.tenant.id, async () => {
      return getAnthropicModel();
    });

    const angles = Array.isArray(topic.content_angles)
      ? topic.content_angles.filter(a => typeof a === "string" && a.trim()).slice(0, 10)
      : [];
    const topicText =
      "TOPIC NAME: " + (topic.name || "") + "\n" +
      "DESCRIPTION: " + (topic.description || "") + "\n" +
      "CONTENT ANGLES:\n" + angles.map(a => "- " + a).join("\n");
    const framed = await withTenant(req.tenant.id, async () => {
      return frameUntrustedContent(topicText);
    });

    const response = await callAnthropic(client, {
      model,
      max_tokens: getTopicSearchTemplateMaxTokens(),
      messages: [{
        role: "user",
        content: `You are a research librarian configuring web searches for an AI news researcher. Based on the topic below, write 3 to 5 search query templates that would surface concrete, citable material (incident reports, regulatory actions, case studies, surveys with numbers) rather than generic explainers.

${framed}

Rules for each template:
- a single line, under 200 characters
- may use ONLY these placeholders: {{ANGLE}} {{KEYWORDS}} {{YEAR_RANGE}} {{TOPIC_NAME}}
- fixed words should name a content TYPE (e.g. "incident report", "enforcement action", "case study results")

Respond with ONLY a JSON array of template strings (no markdown, no preamble).`
      }]
    });

    const text = response.content?.[0]?.text || "";
    const suggestions = parseSuggestedTemplates(text);
    if (suggestions.length === 0) {
      platformLog("warn", "template_suggest_empty", { topicId: topic.id });
      return res.status(502).json({ error: "Could not generate suggestions — please try again" });
    }
    platformLog("info", "template_suggestions_served", {
      topicId: topic.id, slug: topic.slug, count: suggestions.length, suggestions
    });
    res.json({ suggestions });
  } catch (err) {
    platformLog("error", "template_suggest_failed", { error: err.message });
    res.status(500).json({ error: "Failed to generate suggestions" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const topic = await withTenant(req.tenant.id, async () => {
      return getTopicById(req.params.id);
    });
    if (!topic) {
      return res.status(404).json({ error: "Topic not found" });
    }

    const allowed = await canModifyTopic(topic, req.user.sub, req.tenant.role);
    if (!allowed) {
      return res.status(403).json({ error: "Permission denied" });
    }

    // Sanitize domains if present in the update payload.
    // Security guard: domains are silently stripped in v1 mode.
    const body = { ...req.body };
    if (body.domains !== undefined) {
      if (await withTenant(req.tenant.id, () => getFeedsManagerVersion()) !== 2) {
        delete body.domains;
      } else {
        body.domains = Array.isArray(body.domains)
          ? [...new Set(body.domains.map(d => String(d).toLowerCase().trim().substring(0, 50)).filter(Boolean))].slice(0, 20)
          : [];
      }
    }

    // Zero Trust: search_templates is tenant-authored text that is
    // rendered into the research prompt. Validate structure, caps,
    // control characters, and the placeholder whitelist before it
    // is allowed to persist; reject with the exact reason.
    if (body.search_templates !== undefined) {
      const v = validateSearchTemplates(body.search_templates);
      if (!v.ok) {
        return res.status(400).json({ error: v.reason });
      }
      body.search_templates = v.templates;
      platformLog("info", "search_templates_saved", {
        topicId: req.params.id, count: v.templates.length, templates: v.templates
      });
    }

    const updated = await withTenant(req.tenant.id, async () => {
      return updateTopic(req.params.id, body);
    });
    if (!updated) {
      return res.status(400).json({ error: "No valid fields to update" });
    }
    res.json(updated);
  } catch (err) {
    platformLog("error", "topic_update_failed", { error: err.message });
    res.status(500).json({ error: "Failed to update topic" });
  }
});

// ══════════════════════════════════════════════════════════════
// Toggle enabled/disabled
// ══════════════════════════════════════════════════════════════

router.post("/:id/toggle", async (req, res) => {
  try {
    const topic = await withTenant(req.tenant.id, async () => {
      return getTopicById(req.params.id);
    });
    if (!topic) {
      return res.status(404).json({ error: "Topic not found" });
    }

    const allowed = await canModifyTopic(topic, req.user.sub, req.tenant.role);
    if (!allowed) {
      return res.status(403).json({ error: "Permission denied" });
    }

    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    const updated = await withTenant(req.tenant.id, async () => {
      return toggleTopic(req.params.id, enabled);
    });
    res.json(updated);
  } catch (err) {
    platformLog("error", "topic_toggle_failed", { error: err.message });
    res.status(500).json({ error: "Failed to toggle topic" });
  }
});

// ══════════════════════════════════════════════════════════════
// Delete topic
// ══════════════════════════════════════════════════════════════

router.delete("/:id", async (req, res) => {
  try {
    const topic = await withTenant(req.tenant.id, async () => {
      return getTopicById(req.params.id);
    });
    if (!topic) {
      return res.status(404).json({ error: "Topic not found" });
    }

    const allowed = await canModifyTopic(topic, req.user.sub, req.tenant.role);
    if (!allowed) {
      return res.status(403).json({ error: "Permission denied" });
    }

    await withTenant(req.tenant.id, async () => {
      return deleteTopic(req.params.id);
    });
    res.json({ success: true });
  } catch (err) {
    platformLog("error", "topic_delete_failed", { error: err.message });
    res.status(500).json({ error: "Failed to delete topic" });
  }
});

// ══════════════════════════════════════════════════════════════
// AI-powered topic generation
// ══════════════════════════════════════════════════════════════

router.post("/generate", async (req, res) => {
  try {
    const { name, description } = req.body || {};

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "Topic name is required" });
    }
    if (!description || typeof description !== "string" || description.trim().length === 0) {
      return res.status(400).json({ error: "Topic description is required" });
    }

    // Get Anthropic API key from tenant credentials
    const apiKey = await withTenant(req.tenant.id, async () => {
      return getAnthropicApiKey();
    });
    if (!apiKey) {
      return res.status(503).json({ error: "Anthropic API key not configured" });
    }

    const client = new Anthropic({ apiKey });
    const model = await withTenant(req.tenant.id, async () => {
      return getAnthropicModel();
    });

    const response = await callAnthropic(client, {
      model,
      max_tokens: getTopicSuggestionMaxTokens(),
      messages: [{
        role: "user",
        content: `You are a content strategy expert. Given a LinkedIn content topic, generate specific, actionable suggestions.

TOPIC NAME: ${name.trim()}
DESCRIPTION: ${description.trim()}

Respond with ONLY valid JSON (no markdown, no preamble):
{
  "content_angles": [
    "10 specific content angles for LinkedIn posts — each should be a concrete, actionable idea"
  ],
  "hashtags": [
    "4 to 6 relevant LinkedIn hashtags including the # symbol"
  ],
  "system_context": "A system prompt for an AI content writer. Define the persona, tone, focus areas, what to include, and what to avoid. 4-6 sentences."
}`
      }]
    });

    const text = response.content?.[0]?.text || "";
    let parsed;
    try {
      const cleaned = text.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      platformLog("warn", "topic_generate_parse_failed", { raw: text.substring(0, 200) });
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    // Return angles and hashtags to the client.
    // system_context is generated but NOT returned — stored on save.
    res.json({
      content_angles: parsed.content_angles || [],
      hashtags: parsed.hashtags || [],
      _system_context: parsed.system_context || ""
    });
  } catch (err) {
    platformLog("error", "topic_generate_failed", { error: err.message });
    res.status(500).json({ error: "Failed to generate topic suggestions" });
  }
});

export default router;
