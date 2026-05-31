// ═══════════════════════════════════════════════════════════════
// src/routes/feeds-api.js — Feed management API
// ═══════════════════════════════════════════════════════════════
// Feed listing, domain tagging, and AI-powered discovery.
// Mounted at /api/feeds by the app.
//
// Router-level middleware: requireAuth → resolveTenant →
//   requirePermission("manage_own_topics")
// Same permission as topics — if you can manage topics, you
// can view and configure the feeds that serve them.
//
// Endpoints:
//   GET  /             — list feeds with topic mappings + article counts
//   PATCH /:id/domains — update domain tags (v2 only)
//   POST /discover     — AI-powered feed suggestion + RSS validation (v2 only)
//   POST /add          — create feeds from discovery results (v2 only)
//
// Zero Trust:
//   • All queries run inside withTenant — RLS enforced
//   • v2 mutation endpoints gated by FEEDS_MANAGER_VERSION
//   • SSRF guard on discover URL validation (isSafeUrl from security.js)
//   • Domain input sanitized: lowercase, trimmed, capped at 50 chars / 20 tags
//   • Error responses use generic messages
//   • No feed URLs or content leaked outside tenant scope
// ═══════════════════════════════════════════════════════════════

import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import Parser from "rss-parser";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { getMaxAgeDays, getFeedsManagerVersion } from "../config/research.js";
import { getAnthropicApiKey } from "../tenant/credential-store.js";
import { getAnthropicModel, callAnthropic } from "../config/ai.js";
import { isSafeUrl } from "../services/security.js";
import { validateFeed, formatValidationMessage } from "../services/feed-validator.js";
import { getPrompt, getAuthorizedPrompt, renderPrompt } from "../services/prompt-vault.js";
import { createActionToken } from "../services/prompt-actions.js";

const rssParser = new Parser({ timeout: 10000 });

const router = Router();

const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

// ── Blanket middleware — same gate as topics ──────────────────
router.use(requireAuth);
router.use(resolveTenant);
router.use(requirePermission("manage_own_topics"));

// ══════════════════════════════════════════════════════════════
// List all feeds with topic mappings and article counts
// ══════════════════════════════════════════════════════════════
// Optional query param: ?topic=slug — filters topic-specific
// feeds to those mapped to the given topic. Catchall feeds are
// always included regardless of the filter.

router.get("/", async (req, res) => {
  try {
    const topicFilter = req.query.topic || null;

    const result = await withTenant(req.tenant.id, async (client) => {
      const ageDays = getMaxAgeDays();

      // Single query: all feeds with topic mappings and recent article counts.
      const r = await client.query(
        `SELECT f.id, f.name, f.url, f.tier::text AS tier,
                f.is_catchall, f.enabled, f.refresh_minutes,
                f.last_polled_at, f.feed_description,
                f.feed_categories,
                f.domains,
                count(DISTINCT fa.article_id) FILTER (
                  WHERE a.published_at >= now() - ($1 || ' days')::interval
                ) AS recent_articles,
                COALESCE(
                  json_agg(DISTINCT jsonb_build_object(
                    'id', t.id, 'slug', t.slug, 'name', t.name
                  )) FILTER (WHERE t.id IS NOT NULL),
                  '[]'::json
                ) AS topics
         FROM feeds_v2 f
         LEFT JOIN feed_articles fa ON fa.feed_id = f.id
         LEFT JOIN articles_v2 a ON a.id = fa.article_id
         LEFT JOIN feed_topics ft ON ft.feed_id = f.id
         LEFT JOIN topics t ON t.id = ft.topic_id
         GROUP BY f.id
         ORDER BY f.is_catchall DESC, f.name`,
        [String(ageDays)]
      );

      let feeds = r.rows.map(row => ({
        ...row,
        recent_articles: parseInt(row.recent_articles) || 0,
        topics: row.topics || []
      }));

      // Apply topic filter to non-catchall feeds
      if (topicFilter) {
        feeds = feeds.filter(f =>
          f.is_catchall ||
          f.topics.some(t => t.slug === topicFilter)
        );
      }

      return { feeds, fmVersion: await getFeedsManagerVersion() };
    });

    res.json({ feeds: result.feeds, maxAgeDays: getMaxAgeDays(), feedsManagerVersion: result.fmVersion });
  } catch (err) {
    platformLog("error", "feeds_list_failed", { error: err.message });
    res.status(500).json({ error: "Failed to list feeds" });
  }
});

// ══════════════════════════════════════════════════════════════
// Feed summary counts — lightweight endpoint for topic cards
// ══════════════════════════════════════════════════════════════
// Returns per-topic feed counts + catchall count in one call.

router.get("/summary", async (req, res) => {
  try {
    const result = await withTenant(req.tenant.id, async (client) => {
      // Catchall count
      const catchallResult = await client.query(
        `SELECT count(*) AS count FROM feeds_v2 WHERE is_catchall = true`
      );
      const catchallCount = parseInt(catchallResult.rows[0]?.count) || 0;

      // Per-topic feed counts
      const topicResult = await client.query(
        `SELECT t.slug, t.name, count(ft.feed_id) AS feed_count
         FROM topics t
         LEFT JOIN feed_topics ft ON ft.topic_id = t.id
         GROUP BY t.id, t.slug, t.name
         ORDER BY t.name`
      );

      return {
        catchall: catchallCount,
        topics: topicResult.rows.map(r => ({
          slug: r.slug,
          name: r.name,
          feedCount: parseInt(r.feed_count) || 0
        }))
      };
    });

    res.json(result);
  } catch (err) {
    platformLog("error", "feeds_summary_failed", { error: err.message });
    res.status(500).json({ error: "Failed to get feed summary" });
  }
});

// ══════════════════════════════════════════════════════════════
// Update feed domains — Feeds Manager v2.0
// ══════════════════════════════════════════════════════════════
// PATCH /api/feeds/:id/domains
// Body: { domains: ["security", "regulatory"] }
//
// Zero Trust:
//   • Feed lookup is RLS-scoped via withTenant
//   • Domains validated: array of lowercase strings, max 20 tags
//   • Tag length capped at 50 chars to prevent abuse

router.patch("/:id/domains", async (req, res) => {
  try {
    const fmVersion = await withTenant(req.tenant.id, () => getFeedsManagerVersion());
    if (fmVersion !== 2) {
      return res.status(403).json({ error: "Domain tagging requires FEEDS_MANAGER_VERSION=2" });
    }

    const feedId = parseInt(req.params.id);
    if (!feedId || isNaN(feedId)) {
      return res.status(400).json({ error: "Valid feed ID required" });
    }

    const { domains } = req.body || {};
    if (!Array.isArray(domains)) {
      return res.status(400).json({ error: "domains must be an array" });
    }

    const cleanDomains = [...new Set(
      domains.map(d => String(d).toLowerCase().trim().substring(0, 50)).filter(Boolean)
    )].slice(0, 20);

    const result = await withTenant(req.tenant.id, async (client) => {
      const r = await client.query(
        `UPDATE feeds_v2 SET domains = $1::jsonb
         WHERE id = $2 AND tenant_id = current_tenant_id()
         RETURNING id, name, domains`,
        [JSON.stringify(cleanDomains), feedId]
      );
      return r.rows[0] || null;
    });

    if (!result) {
      return res.status(404).json({ error: "Feed not found" });
    }

    res.json(result);
  } catch (err) {
    platformLog("error", "feed_domains_update_failed", { error: err.message });
    res.status(500).json({ error: "Failed to update feed domains" });
  }
});

// ══════════════════════════════════════════════════════════════
// Discover feeds — AI-powered feed suggestion + RSS validation
// ══════════════════════════════════════════════════════════════
// POST /api/feeds/discover
// Body: { topicId: number }
//
// Feeds Manager v2 only. Reads topic context, asks Anthropic for
// RSS feed suggestions, validates each URL, returns validated
// suggestions with live metadata.
//
// Zero Trust:
//   • v2 gate — rejects in v1 mode
//   • Topic read is RLS-scoped via withTenant
//   • AI prompt contains only the tenant's own topic data
//   • RSS validation uses server-side fetch with timeout
//   • Generic errors — no AI response details leaked

router.post("/discover", async (req, res) => {
  try {
    const fmVersion = await withTenant(req.tenant.id, () => getFeedsManagerVersion());
    if (fmVersion !== 2) {
      return res.status(403).json({ error: "Feed discovery requires FEEDS_MANAGER_VERSION=2" });
    }

    const { topicId } = req.body || {};
    if (!topicId || typeof topicId !== "number") {
      return res.status(400).json({ error: "topicId (number) required" });
    }

    const result = await withTenant(req.tenant.id, async (client) => {
      const topicResult = await client.query(
        `SELECT id, name, slug, description, content_angles
         FROM topics WHERE id = $1`,
        [topicId]
      );
      const topic = topicResult.rows[0];
      if (!topic) {
        return { error: "Topic not found", status: 404 };
      }

      const angles = topic.content_angles || [];

      const actionToken = createActionToken("discover-feeds", req.user.sub);

      let template = await getAuthorizedPrompt("feed_discovery", actionToken);
      if (!template) {
        platformLog("error", "prompt_vault_miss", { key: "feed_discovery" });
        return { error: "Feed discovery prompt not configured", status: 500 };
      }
      let prompt = renderPrompt(template, {
        TOPIC_NAME: topic.name,
        TOPIC_DESCRIPTION: topic.description || "Not specified",
        CONTENT_ANGLES: JSON.stringify(angles)
      });
      template = null;

      const apiKey = await getAnthropicApiKey();
      const anthropic = new Anthropic({ apiKey });
      const model = await getAnthropicModel();

      const aiResponse = await callAnthropic(anthropic, {
        model,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }]
      });
      prompt = null;

      const rawText = aiResponse.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("")
        .replace(/```json|```/g, "")
        .trim();

      let suggestions;
      try {
        suggestions = JSON.parse(rawText);
      } catch {
        platformLog("warn", "feed_discover_parse_failed", { rawText: rawText.substring(0, 200) });
        return { error: "AI response was not valid JSON", status: 502 };
      }

      if (!Array.isArray(suggestions)) {
        return { error: "AI response was not an array", status: 502 };
      }

      const existingResult = await client.query(
        `SELECT url FROM feeds_v2`
      );
      const existingUrls = new Set(existingResult.rows.map(r => r.url));

      // ── Phase 1: Validate initial suggestions ─────────────
      const MIN_VALID_TARGET = 5;
      const candidates = suggestions
        .slice(0, 12)
        .filter(s => s.url && typeof s.url === "string" && !existingUrls.has(s.url));

      const validated = [];
      const failed = [];

      for (const s of candidates) {
        const v = await validateFeed(s.url);
        platformLog("info", "feed_discover_validate", {
          url: s.url, grade: v.grade, valid: v.valid,
          items: v.itemCount, responseMs: v.responseMs,
          error: v.error
        });

        if (v.valid) {
          // Merge AI-suggested domains with auto-extracted categories
          const aiDomains = Array.isArray(s.domains) ? s.domains : [];
          const combinedDomains = [...new Set([
            ...aiDomains.map(d => String(d).toLowerCase().trim()),
            ...v.suggestedDomains
          ])].slice(0, 10);

          validated.push({
            name: v.feedTitle || s.name || "Unknown",
            url: s.url,
            suggestedTier: ["authoritative", "primary", "secondary"].includes(s.tier) ? s.tier : "secondary",
            relevance: s.relevance || "",
            grade: v.grade,
            domains: combinedDomains,
            description: "",
            itemCount: v.itemCount,
            latestItemDate: v.latestItemDate,
            responseMs: v.responseMs,
            avgSummaryLength: v.avgSummaryLength,
            qualityIssues: v.qualityIssues
          });
          existingUrls.add(s.url); // prevent duplicates in retry
        } else {
          failed.push({ name: s.name, url: s.url, error: v.error });
        }
      }

      // ── Phase 2: Smart retry — ask AI for replacements ────
      // If we have fewer than MIN_VALID_TARGET valid feeds, ask
      // the AI to suggest alternatives for the ones that failed.
      if (validated.length < MIN_VALID_TARGET && failed.length > 0) {
        const needed = MIN_VALID_TARGET - validated.length + 2; // over-request
        const retryPrompt = [
          `These RSS feed URLs failed validation for the topic "${topic.name}":`,
          ...failed.map(f => `- ${f.name}: ${f.url} (${f.error})`),
          ``,
          `Suggest ${needed} alternative RSS/Atom feed URLs for this topic.`,
          ``,
          `REQUIREMENTS:`,
          `- Must be completely free — no login, subscription, or paywall`,
          `- Must be a direct RSS/Atom feed URL returning XML`,
          `- Must include article summaries (not just titles)`,
          `- Do NOT suggest paywalled sources (WSJ, FT, Bloomberg, The Information)`,
          ``,
          `Avoid these URLs:`,
          ...failed.map(f => `- ${f.url}`),
          ...validated.map(v => `- ${v.url}`),
          ``,
          `For each feed provide: name, url, tier, relevance, domains (2-4 keyword tags).`,
          `Return ONLY a JSON array.`
        ].join("\n");

        try {
          const retryResponse = await callAnthropic(anthropic, {
            model, max_tokens: 1500,
            messages: [{ role: "user", content: retryPrompt }]
          });

          const retryText = retryResponse.content
            .filter(b => b.type === "text")
            .map(b => b.text)
            .join("")
            .replace(/```json|```/g, "")
            .trim();

          let retrySuggestions = [];
          try { retrySuggestions = JSON.parse(retryText); } catch { /* skip */ }

          if (Array.isArray(retrySuggestions)) {
            for (const s of retrySuggestions.slice(0, needed)) {
              if (!s.url || existingUrls.has(s.url)) continue;
              const v = await validateFeed(s.url);
              platformLog("info", "feed_discover_retry_validate", {
                url: s.url, grade: v.grade, valid: v.valid, items: v.itemCount
              });
              if (v.valid) {
                const aiDomains = Array.isArray(s.domains) ? s.domains : [];
                const combinedDomains = [...new Set([
                  ...aiDomains.map(d => String(d).toLowerCase().trim()),
                  ...v.suggestedDomains
                ])].slice(0, 10);

                validated.push({
                  name: v.feedTitle || s.name || "Unknown",
                  url: s.url,
                  suggestedTier: ["authoritative", "primary", "secondary"].includes(s.tier) ? s.tier : "secondary",
                  relevance: s.relevance || "",
                  grade: v.grade,
                  domains: combinedDomains,
                  description: "",
                  itemCount: v.itemCount,
                  latestItemDate: v.latestItemDate,
                  responseMs: v.responseMs,
                  avgSummaryLength: v.avgSummaryLength,
                  qualityIssues: v.qualityIssues
                });
                existingUrls.add(s.url);
              }
            }
          }

          platformLog("info", "feed_discover_retry_complete", {
            needed, retried: retrySuggestions.length,
            totalValid: validated.length
          });
        } catch (retryErr) {
          platformLog("warn", "feed_discover_retry_failed", {
            error: retryErr.message.substring(0, 200)
          });
        }
      }

      platformLog("info", "feed_discover_complete", {
        topicId: topic.id, topicSlug: topic.slug,
        aiSuggested: suggestions.length, validated: validated.length,
        failed: failed.length,
        retried: validated.length < MIN_VALID_TARGET
      });

      return { suggestions: validated };
    });

    if (result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    platformLog("error", "feed_discover_failed", { error: err.message });
    res.status(500).json({ error: "Feed discovery failed" });
  }
});

// ══════════════════════════════════════════════════════════════
// Add discovered feeds — creates feeds + topic mappings
// ══════════════════════════════════════════════════════════════
// POST /api/feeds/add
// Body: { topicId: number, feeds: [{ url, name, tier }] }
//
// Feeds Manager v2 only. Creates feed rows in feeds_v2 and maps
// them to the topic via feed_topics. Idempotent.

router.post("/add", async (req, res) => {
  try {
    const fmVersion = await withTenant(req.tenant.id, () => getFeedsManagerVersion());
    if (fmVersion !== 2) {
      return res.status(403).json({ error: "Feed add requires FEEDS_MANAGER_VERSION=2" });
    }

    const { topicId, feeds } = req.body || {};
    if (!topicId || !Array.isArray(feeds) || feeds.length === 0) {
      return res.status(400).json({ error: "topicId and feeds array required" });
    }

    const result = await withTenant(req.tenant.id, async (client) => {
      const topicResult = await client.query(
        `SELECT id FROM topics WHERE id = $1`,
        [topicId]
      );
      if (topicResult.rows.length === 0) {
        return { error: "Topic not found", status: 404 };
      }

      let added = 0;
      let mapped = 0;

      for (const f of feeds.slice(0, 15)) {
        if (!f.url || !f.name) continue;
        const tier = ["authoritative", "primary", "secondary"].includes(f.tier) ? f.tier : "secondary";
        const domains = Array.isArray(f.domains)
          ? f.domains.map(d => String(d).toLowerCase().trim().substring(0, 50)).slice(0, 20)
          : [];

        const feedResult = await client.query(
          `INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes, domains)
           VALUES (current_tenant_id(), $1, $2, $3::feed_tier, 240, $4::jsonb)
           ON CONFLICT (tenant_id, url) DO NOTHING
           RETURNING id`,
          [f.url, f.name.substring(0, 200), tier, JSON.stringify(domains)]
        );

        let feedId;
        if (feedResult.rows.length > 0) {
          feedId = feedResult.rows[0].id;
          added++;
        } else {
          const existing = await client.query(
            `SELECT id FROM feeds_v2 WHERE url = $1`,
            [f.url]
          );
          feedId = existing.rows[0]?.id;
        }

        if (feedId) {
          const mapResult = await client.query(
            `INSERT INTO feed_topics (tenant_id, feed_id, topic_id)
             VALUES (current_tenant_id(), $1, $2)
             ON CONFLICT (feed_id, topic_id) DO NOTHING`,
            [feedId, topicId]
          );
          if (mapResult.rowCount > 0) mapped++;
        }
      }

      platformLog("info", "feeds_added", { topicId, added, mapped });
      return { added, mapped };
    });

    if (result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    platformLog("error", "feeds_add_failed", { error: err.message });
    res.status(500).json({ error: "Failed to add feeds" });
  }
});

export default router;
