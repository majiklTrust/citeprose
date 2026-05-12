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
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";

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
      // Single query: all feeds with topic mappings and recent article counts.
      // RLS on feeds_v2, feed_topics, feed_articles scopes to current tenant.
      // articles_v2 has no RLS — accessed via tenant-scoped JOINs.
      const r = await client.query(
        `SELECT f.id, f.name, f.url, f.tier::text AS tier,
                f.is_catchall, f.enabled, f.refresh_minutes,
                f.last_polled_at, f.feed_description,
                f.feed_categories,
                count(DISTINCT fa.article_id) FILTER (
                  WHERE a.published_at >= now() - interval '20 days'
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
         ORDER BY f.is_catchall DESC, f.name`
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

    res.json({ feeds: result });
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

export default router;
