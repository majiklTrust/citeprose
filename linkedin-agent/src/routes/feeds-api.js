// ═══════════════════════════════════════════════════════════════
// src/routes/feeds-api.js — Feed management API
// ═══════════════════════════════════════════════════════════════
// Read-only listing of feeds with topic mappings and article
// counts. Mounted at /api/feeds by the app.
//
// Router-level middleware: requireAuth → resolveTenant →
//   requirePermission("manage_own_topics")
// Same permission as topics — if you can manage topics, you
// can view the feeds that serve them.
//
// Zero Trust:
//   • All queries run inside withTenant — RLS enforced
//   • No mutation endpoints in this version (read-only)
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

const rssParser = new Parser({ timeout: 10000 });

// ── SSRF protection ──────────────────────────────────────────
// Validates that a URL is safe to fetch from the server.
// Blocks: non-HTTPS, localhost, private IP ranges, link-local,
// internal hostnames. Prevents AI-suggested URLs from probing
// internal infrastructure.

function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    if (host.startsWith("10.")) return false;
    if (host.startsWith("192.168.")) return false;
    if (host.startsWith("172.")) {
      const octet = parseInt(host.split(".")[1], 10);
      if (octet >= 16 && octet <= 31) return false;
    }
    if (host === "169.254.169.254") return false;
    if (host.endsWith(".internal") || host.endsWith(".local")) return false;
    return true;
  } catch { return false; }
}

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

      return feeds;
    });

    res.json({ feeds: result, maxAgeDays: getMaxAgeDays(), feedsManagerVersion: getFeedsManagerVersion() });
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
    // Security guard: domain tagging is a v2 feature.
    // Reject requests when FEEDS_MANAGER_VERSION=1 to prevent
    // manual trigger or scripted bypass of the version gate.
    if (getFeedsManagerVersion() !== 2) {
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
    if (getFeedsManagerVersion() !== 2) {
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
      const prompt = [
        `Given this LinkedIn content topic:`,
        `Name: ${topic.name}`,
        `Description: ${topic.description || "Not specified"}`,
        `Content angles: ${JSON.stringify(angles)}`,
        ``,
        `Suggest 8-10 RSS or Atom feeds that would provide high-quality`,
        `research material for generating professional LinkedIn posts`,
        `about this topic.`,
        ``,
        `For each feed, provide:`,
        `- name: The publication or organization name`,
        `- url: The exact RSS or Atom feed URL`,
        `- tier: authoritative | primary | secondary`,
        `- relevance: Why this feed is valuable for this topic (1 sentence)`,
        ``,
        `Prioritize:`,
        `- Government agencies and standards bodies (authoritative tier)`,
        `- Established industry publications with editorial oversight (primary)`,
        `- Respected blogs and analysis sites (primary or secondary)`,
        `- Mix of technical depth and business/leadership perspective`,
        `- Sources that publish regularly (at least weekly)`,
        ``,
        `Return ONLY a JSON array, no other text or markdown.`
      ].join("\n");

      const apiKey = await getAnthropicApiKey();
      const anthropic = new Anthropic({ apiKey });
      const model = await getAnthropicModel();

      const aiResponse = await callAnthropic(anthropic, {
        model,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }]
      });

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

      const validated = [];
      for (const s of suggestions.slice(0, 12)) {
        if (!s.url || typeof s.url !== "string") continue;
        if (existingUrls.has(s.url)) continue;

        // SSRF guard: reject non-HTTPS and private network URLs
        if (!isSafeUrl(s.url)) {
          platformLog("warn", "feed_discover_url_blocked", {
            url: s.url, reason: "SSRF protection"
          });
          continue;
        }

        let httpStatus = null;
        try {
          // Fetch manually to capture HTTP status — same pattern
          // as news-monitor.js::fetchFeed for consistency.
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);

          let response;
          try {
            response = await fetch(s.url, {
              headers: {
                "User-Agent": "LinkedInAIAgent/1.5 (RSS Reader)",
                "Accept": "application/rss+xml, application/xml, text/xml"
              },
              signal: controller.signal
            });
          } finally {
            clearTimeout(timeout);
          }

          httpStatus = response.status;

          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }

          const xml = await response.text();
          const feed = await rssParser.parseString(xml);
          const items = feed.items || [];

          validated.push({
            name: feed.title || s.name || "Unknown",
            url: s.url,
            suggestedTier: ["authoritative", "primary", "secondary"].includes(s.tier) ? s.tier : "secondary",
            relevance: s.relevance || "",
            description: (feed.description || "").substring(0, 500),
            recentHeadlines: items.slice(0, 4).map(i => i.title || "Untitled"),
            itemCount: items.length
          });

          platformLog("info", "feed_discover_validated", {
            url: s.url, status: httpStatus, items: items.length
          });
        } catch (err) {
          platformLog("warn", "feed_discover_validation_failed", {
            url: s.url, status: httpStatus,
            error: err.message.substring(0, 200)
          });
        }
      }

      platformLog("info", "feed_discover_complete", {
        topicId: topic.id, topicSlug: topic.slug,
        aiSuggested: suggestions.length, validated: validated.length,
        skippedExisting: suggestions.filter(s => existingUrls.has(s.url)).length
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
    if (getFeedsManagerVersion() !== 2) {
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

        const feedResult = await client.query(
          `INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes)
           VALUES (current_tenant_id(), $1, $2, $3::feed_tier, 240)
           ON CONFLICT (tenant_id, url) DO NOTHING
           RETURNING id`,
          [f.url, f.name.substring(0, 200), tier]
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
