// =================================================================
// src/routes/analytics-api.js, Phase 1 dashboard API (FR-P1-*)
// =================================================================
// Router-level middleware: requireAuth -> resolveTenant. Per-route
// permission gates per the signed-off D5 matrix:
//   view_analytics  (owner, editor, viewer)  all GET endpoints
//   sync_analytics  (owner, editor)          POST /sync, /narrative
//
// Read discipline (FR-CC-07 / FR-P1-07): retrieved values come back
// exactly as stored with their retrieved_at; a post with no metrics
// row returns metrics:null and retrieved_at:null, which the client
// renders as "not yet retrieved", never as zeros. Every derived
// number is under a computed:true label.
//
// Failure mapping (FR-CC-01/02): LinkedIn failure codes surface in
// the response body so the client can show WHICH category failed;
// token expiry maps to 502 with code LINKEDIN_TOKEN_EXPIRED so it
// can never be confused with the session 401.
// =================================================================

import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant, currentClient } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { syncTenantAnalytics } from "../services/analytics-sync.js";
import { generateAnalyticsNarrative, clampWindowDays } from "../services/analytics-narrative.js";
import { createActionToken } from "../services/prompt-actions.js";
import { LI_ERROR_CODES } from "../services/linkedin-errors.js";

const router = Router();
const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

router.use(requireAuth);
router.use(resolveTenant);

function db() {
  const c = currentClient();
  if (!c) throw new Error("analytics route outside tenant context");
  return c;
}

// Map a systemic sync outcome to HTTP + body code (FR-CC-01/02).
export function httpForSyncOutcome(summary) {
  if (summary.status !== "aborted") return null;
  if (summary.aborted === LI_ERROR_CODES.RATE_LIMITED) {
    return { status: 429, code: summary.aborted };
  }
  if (summary.aborted === LI_ERROR_CODES.SCOPE_DENIED) {
    return { status: 502, code: summary.aborted };
  }
  return { status: 502, code: summary.aborted || LI_ERROR_CODES.ENDPOINT_ERROR };
}

// ── GET /api/analytics/posts ──────────────────────────────────
router.get("/posts", requirePermission("view_analytics"), async (req, res) => {
  try {
    const days = clampWindowDays(req.query.days);
    const result = await withTenant(req.tenant.id, async () => db().query(
      `SELECT p.id, p.title, p.status, p.posted_at, p.genre,
              t.slug AS topic_slug, t.name AS topic_name,
              pm.impressions, pm.clicks, pm.likes, pm.comments, pm.shares,
              pm.retrieved_at
         FROM posts p
         LEFT JOIN topics t ON t.tenant_id = p.tenant_id AND t.id = p.topic_id
         LEFT JOIN post_metrics pm ON pm.tenant_id = p.tenant_id AND pm.post_id = p.id
        WHERE p.linkedin_id IS NOT NULL AND p.status = 'posted'
          AND p.posted_at >= now() - ($1 || ' days')::interval
        ORDER BY p.posted_at DESC`,
      [String(days)]
    ));
    const posts = result.rows.map((r) => ({
      id: r.id, title: r.title, topic: r.topic_name, topicSlug: r.topic_slug,
      genre: r.genre, postedAt: r.posted_at,
      retrievedAt: r.retrieved_at, // null => not yet retrieved (FR-P1-07)
      metrics: r.retrieved_at === null ? null : {
        impressions: r.impressions, clicks: r.clicks,
        likes: r.likes, comments: r.comments, shares: r.shares
      }
    }));
    res.json({ days, posts });
  } catch (err) {
    platformLog("error", "analytics_posts_failed", { error: err.message });
    res.status(500).json({ error: "Failed to load post analytics" });
  }
});

// ── GET /api/analytics/topics ─────────────────────────────────
router.get("/topics", requirePermission("view_analytics"), async (req, res) => {
  try {
    const days = clampWindowDays(req.query.days);
    const result = await withTenant(req.tenant.id, async () => db().query(
      `SELECT COALESCE(t.name, '(no topic)') AS topic, t.slug AS topic_slug,
              COUNT(pm.id)::bigint AS measured_posts,
              SUM(pm.impressions)::bigint AS impressions,
              SUM(pm.clicks)::bigint AS clicks,
              SUM(pm.likes + pm.comments + pm.shares)::bigint AS interactions,
              MAX(pm.retrieved_at) AS latest_retrieved_at
         FROM post_metrics pm
         JOIN posts p ON p.tenant_id = pm.tenant_id AND p.id = pm.post_id
         LEFT JOIN topics t ON t.tenant_id = p.tenant_id AND t.id = p.topic_id
        WHERE p.posted_at >= now() - ($1 || ' days')::interval
        GROUP BY t.name, t.slug
        ORDER BY SUM(pm.impressions) DESC NULLS LAST`,
      [String(days)]
    ));
    res.json({ days, computed: true, topics: result.rows });
  } catch (err) {
    platformLog("error", "analytics_topics_failed", { error: err.message });
    res.status(500).json({ error: "Failed to load topic analytics" });
  }
});

// ── GET /api/analytics/heatmap ────────────────────────────────
// Day-of-week x hour buckets over posted_at, averaged impressions.
// Entirely platform-computed (FR-P1-05, FR-CC-07).
router.get("/heatmap", requirePermission("view_analytics"), async (req, res) => {
  try {
    const days = clampWindowDays(req.query.days);
    const result = await withTenant(req.tenant.id, async () => db().query(
      `SELECT EXTRACT(ISODOW FROM p.posted_at)::int AS dow,
              EXTRACT(HOUR   FROM p.posted_at)::int AS hour,
              COUNT(*)::bigint AS posts,
              AVG(pm.impressions)::numeric(12,1) AS avg_impressions
         FROM post_metrics pm
         JOIN posts p ON p.tenant_id = pm.tenant_id AND p.id = pm.post_id
        WHERE p.posted_at >= now() - ($1 || ' days')::interval
          AND pm.impressions IS NOT NULL
        GROUP BY 1, 2`,
      [String(days)]
    ));
    res.json({ days, computed: true, cells: result.rows });
  } catch (err) {
    platformLog("error", "analytics_heatmap_failed", { error: err.message });
    res.status(500).json({ error: "Failed to load heatmap" });
  }
});

// ── GET /api/analytics/demographics ───────────────────────────
router.get("/demographics", requirePermission("view_analytics"), async (req, res) => {
  try {
    const result = await withTenant(req.tenant.id, async () => db().query(
      `SELECT facet, entity, label, follower_count, retrieved_at
         FROM follower_demographics
        ORDER BY facet, follower_count DESC`
    ));
    res.json({ facets: result.rows });
  } catch (err) {
    platformLog("error", "analytics_demographics_failed", { error: err.message });
    res.status(500).json({ error: "Failed to load demographics" });
  }
});

// ── POST /api/analytics/sync ──────────────────────────────────
router.post("/sync", requirePermission("sync_analytics"), async (req, res) => {
  try {
    const summary = await withTenant(req.tenant.id, () =>
      syncTenantAnalytics({ respectEnabledFlag: false })
    );
    const failure = httpForSyncOutcome(summary);
    if (failure) {
      return res.status(failure.status).json({
        success: false, code: failure.code, summary
      });
    }
    if (summary.status === "not_connected") {
      return res.status(409).json({
        success: false, code: LI_ERROR_CODES.NOT_CONNECTED,
        error: "LinkedIn is not connected for this workspace"
      });
    }
    if (summary.status === "org_not_configured") {
      // Distinct from NOT_CONNECTED on purpose: the token is fine,
      // the organization page is what is missing (FR-CC-01 spirit).
      return res.status(409).json({
        success: false, code: "LINKEDIN_ORG_NOT_CONFIGURED",
        error: "LinkedIn is connected, but no organization page is configured for this workspace"
      });
    }
    // Sync now refreshes EVERYTHING the page shows, advocacy reach
    // included (Step 4). Best-effort and isolated: a reach failure
    // never fails the sync it rode along with.
    let reach = null;
    try {
      reach = await withTenant(req.tenant.id, async () => {
        const { refreshTenantReach } = await import("../services/advocacy-reach.js");
        return refreshTenantReach();
      });
    } catch (reachErr) {
      platformLog("warn", "analytics_sync_reach_refresh_failed", { error: reachErr.message });
    }
    res.json({ success: true, summary, reach });
  } catch (err) {
    platformLog("error", "analytics_sync_route_failed", { error: err.message });
    res.status(500).json({ error: "Analytics sync failed" });
  }
});

// ── POST /api/analytics/narrative ─────────────────────────────
router.post("/narrative", requirePermission("sync_analytics"), async (req, res) => {
  try {
    const token = createActionToken("analytics-narrative", req.user.sub);
    const result = await withTenant(req.tenant.id, () =>
      generateAnalyticsNarrative(token, req.body?.days)
    );
    if (result.notConfigured) {
      return res.status(503).json({
        error: "Narrative synthesis is not configured",
        code: "NARRATIVE_NOT_CONFIGURED"
      });
    }
    if (result.blocked) {
      return res.status(422).json({ blocked: true, reason: result.reason });
    }
    res.json({
      narrative: result.narrative,
      dataPoints: result.dataPoints,
      windowDays: result.windowDays,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    platformLog("error", "analytics_narrative_failed", { error: err.message });
    res.status(500).json({ error: "Narrative generation failed" });
  }
});

export default router;
