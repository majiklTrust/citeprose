// ═══════════════════════════════════════════════════════════════
// src/routes/platform-admin-api.js — Platform admin operations
// ═══════════════════════════════════════════════════════════════
// Cross-tenant administrative queries for platform super admins.
// Access requires isPlatformAdmin(req.user.sub) — same gate as
// tenant registration.
//
// Queries are defined SERVER-SIDE only. The client sends a query
// key (e.g., "clear-all-tenant-data"), the server looks it up
// and executes the predefined SQL. The client never sees or
// sends SQL — Zero Trust against injection.
//
// To add a new query: add one entry to QUERY_REGISTRY below.
//
// Endpoints:
//   GET  /api/platform-admin/queries  — list available queries
//   POST /api/platform-admin/execute  — run a named query
//
// RLS bypass:
//   All queries execute inside a transaction with SET LOCAL ROLE
//   to the platform admin database role (env: PLATFORM_ADMIN_DB_ROLE,
//   default: ***REMOVED***). This role bypasses RLS so the super
//   user sees all tenant data without per-tenant context switching.
//   SET LOCAL is transaction-scoped — the pooled connection reverts
//   to the app role on COMMIT/ROLLBACK. No leaked privileges.
//
// Zero Trust:
//   • isPlatformAdmin gate — .env PLATFORM_ADMIN_SUBS
//   • Query keys validated against registry — unknown keys rejected
//   • SQL never leaves the server
//   • Parameterized queries — no string interpolation
//   • Destructive queries require explicit confirmation flag
//   • All executions logged via platformLog
//   • Elevated DB role is transaction-scoped, never persists
// ═══════════════════════════════════════════════════════════════

import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { isPlatformAdmin } from "../tenant/platform-db.js";
import { pool } from "../db/pool.js";
import { platformLog } from "../services/platform-log.js";

const router = Router();

// Database role for platform admin queries. Must have privileges
// to read/write tenant tables and bypass RLS. The app role needs:
//   GRANT ***REMOVED*** TO linkedin_agent_app;
// so SET LOCAL ROLE succeeds.
const ADMIN_DB_ROLE = (() => {
  const role = process.env.PLATFORM_ADMIN_DB_ROLE;
  // Validate: must be a simple identifier (defense in depth —
  // the value comes from .env, not from the client, but SET
  // LOCAL ROLE interpolates it into SQL).
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role)) {
    throw new Error(`Invalid PLATFORM_ADMIN_DB_ROLE: must be a valid PostgreSQL identifier`);
  }
  return role;
})();

// ── Query Registry ───────────────────────────────────────────
// Each entry: key → { label, description, sql, params, destructive, readOnly }
//
// params: array of { name, label, type, required }
//   type: 'uuid' | 'text' | 'number'
//
// To add a query, add one object. The frontend picks it up
// automatically from GET /queries.

const QUERY_REGISTRY = {

  "list-tenants": {
    label: "List All Tenants",
    description: "Shows all tenants with status, slug, and creation date.",
    sql: `SELECT id, slug, name, status::text, created_at
          FROM tenants ORDER BY created_at DESC`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "list-memberships": {
    label: "List All Memberships",
    description: "Shows all tenant memberships with auth provider and role.",
    sql: `SELECT t.slug, m.auth_provider::text, m.auth_sub,
                 m.role::text, m.created_at
          FROM memberships m
          JOIN tenants t ON t.id = m.tenant_id
          ORDER BY t.slug, m.created_at`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "tenant-feed-summary": {
    label: "Tenant Feed Summary",
    description: "Feed counts, catchall vs topic-specific, and validation grades for a tenant.",
    sql: `SELECT f.name, f.url, f.tier::text, f.is_catchall,
                 f.last_validation_grade, f.consecutive_failures,
                 f.last_validated_at,
                 (SELECT count(*) FROM feed_articles fa WHERE fa.feed_id = f.id) AS article_count
          FROM feeds_v2 f
          WHERE f.tenant_id = $1
          ORDER BY f.name`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: true
  },

  "tenant-agent-state": {
    label: "Tenant Agent State",
    description: "Shows all agent_state configuration values for a tenant.",
    sql: `SELECT a.key, a.value, s.value_type, s.allowed_values, s.description
          FROM agent_state a
          LEFT JOIN agent_state_schema s ON s.key = a.key
          WHERE a.tenant_id = $1
          ORDER BY a.key`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: true
  },

  "set-feeds-manager-version": {
    label: "Set Feeds Manager Version",
    description: "Sets feeds_manager_version for a tenant (1 or 2).",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1, 'feeds_manager_version', $2)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    params: [
      { name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true },
      { name: "version", label: "Version (1 or 2)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "clear-tenant-feeds": {
    label: "Clear All Tenant Feeds",
    description: "Removes all feeds, feed-topic mappings, and feed-article links for a tenant. Articles are preserved.",
    sql: `WITH deleted_mappings AS (
            DELETE FROM feed_topics WHERE tenant_id = $1
          ), deleted_articles AS (
            DELETE FROM feed_articles WHERE feed_id IN (
              SELECT id FROM feeds_v2 WHERE tenant_id = $1
            )
          )
          DELETE FROM feeds_v2 WHERE tenant_id = $1`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-posts": {
    label: "Clear All Tenant Posts",
    description: "Removes all posts for a tenant.",
    sql: `DELETE FROM posts WHERE tenant_id = $1`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-topics": {
    label: "Clear All Tenant Topics",
    description: "Removes all topics and their feed mappings for a tenant.",
    sql: `WITH deleted_mappings AS (
            DELETE FROM feed_topics WHERE tenant_id = $1
          )
          DELETE FROM topics WHERE tenant_id = $1`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: true,
    readOnly: false
  },

  "clear-all-tenant-data": {
    label: "Clear ALL Tenant Data",
    description: "Nuclear option — removes feeds, topics, posts, activity log, and agent_state for a tenant. The tenant shell remains.",
    sql: `WITH d1 AS (DELETE FROM feed_topics WHERE tenant_id = $1),
              d2 AS (DELETE FROM feed_articles WHERE feed_id IN (SELECT id FROM feeds_v2 WHERE tenant_id = $1)),
              d3 AS (DELETE FROM feeds_v2 WHERE tenant_id = $1),
              d4 AS (DELETE FROM posts WHERE tenant_id = $1),
              d5 AS (DELETE FROM topics WHERE tenant_id = $1),
              d6 AS (DELETE FROM activity_log WHERE tenant_id = $1),
              d7 AS (DELETE FROM agent_state WHERE tenant_id = $1)
          SELECT 'done' AS result`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: true,
    readOnly: false
  },

  "reseed-catchall-feeds": {
    label: "Reseed Catchall Feeds",
    description: "Re-inserts default catchall feeds for a tenant. Idempotent — skips existing URLs.",
    sql: `INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes, is_catchall) VALUES
            ($1, 'https://www.technologyreview.com/feed/', 'MIT Technology Review', 'primary', 240, true),
            ($1, 'https://www.wired.com/feed/rss', 'Wired', 'secondary', 120, true),
            ($1, 'https://feeds.arstechnica.com/arstechnica/index', 'Ars Technica', 'primary', 120, true),
            ($1, 'https://www.theverge.com/rss/index.xml', 'The Verge', 'secondary', 120, true),
            ($1, 'https://www.zdnet.com/news/rss.xml', 'ZDNet', 'secondary', 120, true),
            ($1, 'https://www.fastcompany.com/latest/rss', 'Fast Company', 'secondary', 180, true),
            ($1, 'https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Technology', 'primary', 180, true),
            ($1, 'https://feeds.npr.org/1019/rss.xml', 'NPR Technology', 'primary', 240, true),
            ($1, 'https://www.nature.com/nature.rss', 'Nature News', 'primary', 360, true),
            ($1, 'https://www.statnews.com/feed/', 'STAT News', 'primary', 240, true)
          ON CONFLICT (tenant_id, url) DO NOTHING`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: false
  },

  "reset-feed-failures": {
    label: "Reset Feed Failure Counters",
    description: "Resets consecutive_failures and last_validation_grade for all feeds in a tenant.",
    sql: `UPDATE feeds_v2
          SET consecutive_failures = 0,
              last_validation_grade = NULL,
              last_validated_at = NULL,
              last_error = NULL
          WHERE tenant_id = $1`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: false
  },

  "schema-validation": {
    label: "Schema Migration Check",
    description: "Verifies which DDL migrations have been applied.",
    sql: `SELECT
            'feeds_v2.domains' AS check_item,
            EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='feeds_v2' AND column_name='domains') AS applied
          UNION ALL SELECT 'topics.domains',
            EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='topics' AND column_name='domains')
          UNION ALL SELECT 'articles_v2.image_url',
            EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='articles_v2' AND column_name='image_url')
          UNION ALL SELECT 'feeds_v2.consecutive_failures',
            EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='feeds_v2' AND column_name='consecutive_failures')
          UNION ALL SELECT 'agent_state_schema table',
            EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='agent_state_schema')
          UNION ALL SELECT 'agent_state trigger',
            EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_validate_agent_state')
          UNION ALL SELECT 'validation_grade CHECK',
            EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_validation_grade')
          ORDER BY check_item`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "all-tenant-states": {
    label: "All Tenant Config States",
    description: "Shows agent_state configuration across all tenants with schema metadata.",
    sql: `SELECT t.slug AS tenant, a.key, a.value,
                 s.value_type, s.allowed_values
          FROM agent_state a
          JOIN tenants t ON t.id = a.tenant_id
          LEFT JOIN agent_state_schema s ON s.key = a.key
          ORDER BY t.slug, a.key`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "tenant-credentials-status": {
    label: "Tenant Credentials Status",
    description: "Shows which credentials exist for a tenant (names only — values are encrypted and never exposed).",
    sql: `SELECT key, length(value) > 0 AS has_value, created_at, updated_at
          FROM credentials
          WHERE tenant_id = $1
          ORDER BY key`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: true
  }
};

// ── Middleware ────────────────────────────────────────────────

export default function createPlatformAdminRoutes() {
  const { requireAuth } = createAuthMiddleware();

  // Platform admin gate — applied to all routes
  function requirePlatformAdmin(req, res, next) {
    if (!req.user || !isPlatformAdmin(req.user.sub)) {
      return res.status(403).json({ error: "Platform admin access required" });
    }
    next();
  }

  router.use(requireAuth);
  router.use(requirePlatformAdmin);

  // ── GET /queries — list available queries ────────────────
  // Returns query metadata only — SQL is never exposed.

  router.get("/queries", (req, res) => {
    const queries = Object.entries(QUERY_REGISTRY).map(([key, q]) => ({
      key,
      label: q.label,
      description: q.description,
      params: q.params,
      destructive: q.destructive,
      readOnly: q.readOnly
    }));
    res.json({ queries });
  });

  // ── POST /execute — run a named query ────────────────────
  // Body: { key: string, params: { name: value, ... }, confirmed?: boolean }
  //
  // Every query runs inside a transaction with SET LOCAL ROLE
  // to the platform admin DB role. This bypasses RLS so the
  // super user sees all tenant data. The role elevation is
  // transaction-scoped — it reverts on COMMIT/ROLLBACK.

  router.post("/execute", async (req, res) => {
    const { key, params: clientParams, confirmed } = req.body || {};

    if (!key || typeof key !== "string") {
      return res.status(400).json({ error: "Query key required" });
    }

    const queryDef = QUERY_REGISTRY[key];
    if (!queryDef) {
      return res.status(400).json({ error: "Unknown query key" });
    }

    // Destructive queries require explicit confirmation
    if (queryDef.destructive && !confirmed) {
      return res.status(400).json({
        error: "Destructive query requires confirmation",
        requiresConfirmation: true
      });
    }

    // Build parameter array in order
    const paramValues = [];
    for (const p of queryDef.params) {
      const val = clientParams?.[p.name];
      if (p.required && (!val || String(val).trim().length === 0)) {
        return res.status(400).json({ error: `Parameter '${p.label}' is required` });
      }
      paramValues.push(val || null);
    }

    platformLog("info", "platform_admin_query", {
      admin: req.user.sub,
      query: key,
      params: clientParams,
      destructive: queryDef.destructive
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${ADMIN_DB_ROLE}`);

      const result = await client.query(queryDef.sql, paramValues);

      await client.query("COMMIT");

      platformLog("info", "platform_admin_query_result", {
        query: key,
        rowCount: result.rowCount,
        command: result.command
      });

      res.json({
        success: true,
        command: result.command,
        rowCount: result.rowCount,
        rows: queryDef.readOnly ? result.rows : undefined,
        fields: queryDef.readOnly ? result.fields?.map(f => f.name) : undefined
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      platformLog("error", "platform_admin_query_failed", {
        query: key, error: err.message
      });
      res.status(500).json({ error: "An internal error occurred" });
    } finally {
      client.release();
    }
  });

  return router;
}
