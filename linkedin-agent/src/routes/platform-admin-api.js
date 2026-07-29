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
import { TIERS } from "../config/entitlements.js";
import { decryptPlatformSecret } from "../services/platform-secret.js";
import { storePromptGenre } from "../services/prompt-vault.js";
import { getProvider, resolveBaseUrl } from "../llm/registry.js";
import { getModelListingPageLimit } from "../config/ai.js";
import { getCatchallFeedList } from "../tenant/seed-defaults.js";

const router = Router();

// Database role for platform admin queries. Must have privileges
// to read/write tenant tables and bypass RLS. The app role needs:
//   GRANT ***REMOVED*** TO linkedin_agent_app;
// so SET LOCAL ROLE succeeds.
// Resolved lazily on first call to createPlatformAdminRoutes()
// so that dotenv.config() has already run.
let ADMIN_DB_ROLE = null;

function resolveAdminRole() {
  if (ADMIN_DB_ROLE) return ADMIN_DB_ROLE;
  const cipher = process.env.PLATFORM_ADMIN_DB_ROLE;
  if (!cipher || typeof cipher !== "string" || cipher.trim().length === 0) {
    throw new Error("PLATFORM_ADMIN_DB_ROLE is not set — platform admin queries are disabled");
  }
  let role;
  try {
    role = decryptPlatformSecret(cipher.trim());
  } catch {
    throw new Error("PLATFORM_ADMIN_DB_ROLE could not be decrypted — platform admin queries are disabled");
  }
  const trimmed = role.trim();
  // Validate AFTER decrypt — the role is interpolated into SET LOCAL ROLE,
  // so it must be a safe PostgreSQL identifier regardless of source.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new Error("Invalid PLATFORM_ADMIN_DB_ROLE: must be a valid PostgreSQL identifier");
  }
  ADMIN_DB_ROLE = trimmed;
  return ADMIN_DB_ROLE;
}

// ── Model catalog grouping & cache ───────────────────────────
// The only static element is the family order and the substring
// used to classify a model ID into a family. Model IDs themselves
// come from the live Anthropic Models API.

const MODEL_FAMILIES = [
  { group: "Sonnet", match: "sonnet" },
  { group: "Haiku", match: "haiku" },
  { group: "Opus", match: "opus" }
];

function groupModelsByFamily(models) {
  return MODEL_FAMILIES.map((fam) => ({
    group: fam.group,
    options: models
      .map((m) => m && m.id)
      .filter((id) => typeof id === "string" && id.toLowerCase().includes(fam.match))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  })).filter((g) => g.options.length > 0);
}

let modelCache = null;
let modelCacheAt = 0;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedModels() {
  if (modelCache && Date.now() - modelCacheAt < MODEL_CACHE_TTL_MS) return modelCache;
  return null;
}

function setCachedModels(optgroups) {
  modelCache = optgroups;
  modelCacheAt = Date.now();
}

// ── Query Registry ───────────────────────────────────────────
// Each entry: key → { label, description, sql, params, destructive, readOnly }
//
// params: array of { name, label, type, required }
//   type: 'uuid' | 'text' | 'number'
//
// To add a query, add one object. The frontend picks it up
// automatically from GET /queries.

// The reseed card's row set is generated from the tenant seeding
// module so the catchall feed list has exactly one source of
// truth. Values are trusted module constants, not user input; the
// only bind parameter remains the tenant UUID.
function buildReseedCatchallSql() {
  const rows = getCatchallFeedList()
    .map((f) => `($1, '${f.url}', '${f.name.replace(/'/g, "''")}', '${f.tier}', ${f.refresh}, true)`)
    .join(",\n            ");
  return `INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes, is_catchall) VALUES\n            ${rows}\n          ON CONFLICT (tenant_id, url) DO NOTHING`;
}

const QUERY_REGISTRY = {

  // ── Operational self-awareness (2.4.1) ──────────────────────
  "platform-events-recent": {
    label: "Platform Events (Recent)",
    description: "Latest persisted platform events, newest first.",
    capability: "Watch the platform think: every persisted event with level, detail, and tenant.",
    sql: `SELECT created_at, level, event, tenant_id, detail
          FROM platform_log ORDER BY created_at DESC LIMIT 200`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "platform-events-by-tenant": {
    label: "Platform Events (By Tenant)",
    description: "Persisted events attributed to one tenant, newest first.",
    capability: "Audit one workspace's trail end to end.",
    sql: `SELECT created_at, level, event, detail
          FROM platform_log WHERE tenant_id = $1::uuid
          ORDER BY created_at DESC LIMIT 200`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "platform-event-metrics": {
    label: "Usage Metrics (Event Counts)",
    description: "Event volume by type and level over the last N days.",
    capability: "Usage metrics from the event stream: what runs, how often, and how loudly.",
    sql: `SELECT event, level, count(*)::bigint AS occurrences,
                 min(created_at) AS first_seen, max(created_at) AS last_seen
          FROM platform_log
          WHERE created_at > now() - ($1 || ' days')::interval
          GROUP BY event, level ORDER BY occurrences DESC LIMIT 100`,
    params: [
      { name: "days", label: "Window (days)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "prompt-vault-audit": {
    label: "Prompt Vault Access Audit",
    description: "Every persisted prompt_* security event, newest first.",
    capability: "The prompt-security audit trail the vault phases were designed to feed.",
    sql: `SELECT created_at, level, event, tenant_id, detail
          FROM platform_log WHERE event LIKE 'prompt\_%'
          ORDER BY created_at DESC LIMIT 200`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "payments-audit": {
    label: "Payments Audit Trail",
    description: "Lifecycle transitions and refusals from payment_events.",
    capability: "Every subscription transition and refused provider event, in order.",
    sql: `SELECT p.recorded_at, t.slug, p.provider, p.event_type,
                 p.prev_state, p.next_state, p.tier, p.detail
          FROM payment_events p JOIN tenants t ON t.id = p.tenant_id
          ORDER BY p.recorded_at DESC LIMIT 200`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "list-tenants": {
    label: "List All Tenants",
    description: "Shows all tenants with status, slug, and creation date.",
    capability: "See every tenant on the platform at a glance — status, slug, and creation date.",
    sql: `SELECT id, slug, name, status::text, created_at
          FROM tenants ORDER BY created_at DESC`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "list-memberships": {
    label: "List All Memberships",
    description: "Shows all tenant memberships with auth provider and role.",
    capability: "See who has access to which tenant, by auth provider and role.",
    sql: `SELECT t.slug, m.auth_sub,
                 m.role::text, m.auth_provider::text, m.created_at
          FROM memberships m
          JOIN tenants t ON t.id = m.tenant_id
          ORDER BY t.slug, m.created_at`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "show-tenant-members": {
    label: "Tenant Members",
    description: "Show the Members.",
    capability: "Show the Members.",
    sql: `select t.name,t.slug,m.role,m.auth_provider,m.created_at,m.auth_sub, m.tenant_id from memberships m
            join tenants t on t.id = m.tenant_id
            where t.id = $1::uuid
            order by m.created_at desc`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "update-membership-workspace": {
    label: "Update Workspace",
    description: "Authorizes a Tenant Member's workspace.",
    capability: "Authorizes a Tenant Member's workspace.",
    sql: `update memberships set auth_sub=$3
            where tenant_id=$1::uuid
            and id = $2`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true },
      { name: "id", label: "Member UUID", type: "uuid", required: true },
      { name: "value", label: "IDP Authorization", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "tenant-feed-summary": {
    label: "Tenant Feed Summary",
    description: "Feed counts, catchall vs topic-specific, and validation grades for a tenant.",
    capability: "Inspect one tenant's feeds — validation grades, failures, and article counts.",
    sql: `SELECT f.name, f.url, f.tier::text, f.is_catchall,
                 f.last_validation_grade, f.consecutive_failures,
                 f.last_validated_at,
                 (SELECT count(*) FROM feed_articles fa WHERE fa.feed_id = f.id) AS article_count
          FROM feeds_v2 f
          WHERE f.tenant_id = $1::uuid
          ORDER BY f.name`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "tenant-agent-state": {
    label: "Tenant Agent State",
    description: "Shows all agent_state configuration values for a tenant.",
    capability: "Review a tenant's full agent configuration in one place, with schema metadata.",
    sql: `SELECT a.key, a.value, s.value_type, s.allowed_values, s.description
          FROM agent_state a
          LEFT JOIN agent_state_schema s ON s.key = a.key
          WHERE a.tenant_id = $1::uuid
          ORDER BY a.key`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "set-feeds-manager-version": {
    label: "Set Feeds Manager Version",
    description: "Sets feeds_manager_version for a tenant (1 or 2).",
    capability: "Switch a tenant between the v1 and v2 Feeds Manager UI.",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1::uuid, 'feeds_manager_version', $2)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true },
      { name: "version", label: "Version (1 or 2)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "clear-tenant-feeds": {
    label: "Clear All Tenant Feeds",
    description: "Removes all feeds, feed-topic mappings, and feed-article links for a tenant. Articles are preserved.",
    capability: "Wipe a tenant's feeds and feed links while preserving the underlying articles.",
    sql: `WITH deleted_mappings AS (
            DELETE FROM feed_topics WHERE tenant_id = $1::uuid
          ), deleted_articles AS (
            DELETE FROM feed_articles WHERE feed_id IN (
              SELECT id FROM feeds_v2 WHERE tenant_id = $1::uuid
            )
          )
          DELETE FROM feeds_v2 WHERE tenant_id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-posts": {
    label: "Clear Tenant Posts",
    description: "Removes all posts for a tenant.",
    capability: "Remove all of a tenant's posts — useful for resetting a demo or test tenant.",
    sql: `DELETE FROM posts WHERE tenant_id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-topics": {
    label: "Clear Tenant Topics",
    description: "Removes all topics and their feed mappings for a tenant.",
    capability: "Remove a tenant's topics and their feed mappings.",
    sql: `WITH deleted_mappings AS (
            DELETE FROM feed_topics WHERE tenant_id = $1::uuid
          )
          DELETE FROM topics WHERE tenant_id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-invites": {
    label: "Clear Tenant Member Invites (all users)",
    description: "Removes all member invites (pending and claimed) for a tenant.",
    capability: "Clear a tenant's invite records before re-inviting users.",
    sql: `DELETE FROM invites WHERE tenant_id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-memberships": {
    label: "Clear Tenant Membership",
    description: "Removes all memberships for a tenant, revoking every user's access.",
    capability: "Revoke all user access to a tenant in one step.",
    sql: `DELETE FROM memberships WHERE tenant_id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-main": {
    label: "Clear Tenant",
    description: "Deletes the tenant row itself. Run the other clear-tenant queries first to remove dependent data.",
    capability: "Final teardown step — remove the tenant shell after its data is cleared.",
    sql: `DELETE FROM tenants WHERE id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "reseed-catchall-feeds": {
    label: "Reseed Catchall Feeds",
    description: "Re-inserts default catchall feeds for a tenant. Idempotent — skips existing URLs.",
    capability: "Restore the default catchall feed set for a tenant without touching existing feeds.",
    sql: buildReseedCatchallSql(),
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: false
  },

  "reset-feed-failures": {
    label: "Reset Feed Failure Counters",
    description: "Resets consecutive_failures and last_validation_grade for all feeds in a tenant.",
    capability: "Clear failure counters and grades so feeds get a fresh polling chance.",
    sql: `UPDATE feeds_v2
          SET consecutive_failures = 0,
              last_validation_grade = NULL,
              last_validated_at = NULL,
              last_error = NULL
          WHERE tenant_id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "all-tenant-states": {
    label: "All Tenant Config States",
    description: "Shows agent_state configuration across all tenants with schema metadata.",
    capability: "Compare agent configuration across every tenant in one result.",
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

  "database-enum-fields": {
    label: "Database Wide enum Type Fields",
    description: "Shows all scoped fields.",
    capability: "Discover every enum type, where it's used, and its valid values — handy before setting status fields.",
    sql: `SELECT t.typname AS enum_type,
                c.relname AS table_name,
                a.attname AS column_name,
                ARRAY(SELECT e.enumlabel::text 
                      FROM pg_enum e 
                      WHERE e.enumtypid = t.oid 
                      ORDER BY e.enumsortorder) AS possible_values
          FROM pg_type t
          JOIN pg_enum e2 ON e2.enumtypid = t.oid
          JOIN pg_attribute a ON a.atttypid = t.oid
          JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relkind = 'r'
            AND NOT a.attisdropped
          GROUP BY t.typname, t.oid, c.relname, a.attname
          ORDER BY t.typname, c.relname`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "tenant-credentials-status": {
    label: "Tenant Credentials Status",
    description: "Shows which credentials exist for a tenant (names only — values are encrypted and never exposed).",
    capability: "Confirm which credentials a tenant has set without exposing the encrypted values.",
    sql: `SELECT key, length(value_enc) > 0 AS has_value, updated_at
          FROM credentials
          WHERE tenant_id = $1::uuid
          ORDER BY key`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  // ── Prompt Security (Phase 1 vault metadata) ─────────────────

  "prompt-vault-inventory": {
    label: "Prompt Vault Inventory",
    description: "Lists every vaulted prompt: key, genre, description, encryption version, and last update. Encrypted content is never exposed.",
    capability: "See exactly which prompts and genre variants the vault protects and when each was last rotated.",
    sql: `SELECT key, genre, description, encryption_version, updated_at
          FROM prompt_vault
          ORDER BY key, genre`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "content-generator-genres": {
    label: "Content Generator Genres",
    description: "Lists the genre variants configured for the content_generator prompt. Encrypted content is never exposed.",
    capability: "Confirm which content genres exist before inserting a new one.",
    sql: `SELECT genre, description, updated_at
          FROM prompt_vault
          WHERE key = 'content_generator'
          ORDER BY genre`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "prompt-vault-summary": {
    label: "Prompt Vault Summary",
    description: "Aggregate snapshot: total prompts, distinct encryption versions in use, and oldest/newest update timestamps.",
    capability: "One-glance vault health — confirms all expected prompts are present and on the current encryption version.",
    sql: `SELECT count(*) AS total_prompts,
                 count(DISTINCT encryption_version) AS encryption_versions,
                 min(updated_at) AS oldest_update,
                 max(updated_at) AS newest_update
          FROM prompt_vault`,
    params: [],
    destructive: false,
    readOnly: true
  },

  // ── Content & association (articles ↔ topics ↔ feeds) ────────

  "topic-content-blueprint": {
    label: "Topic Content Blueprint",
    description: "For one topic (by slug): expands content_angles, search_templates, hashtags, and domains, plus system_context and config.",
    capability: "See everything that drives a single topic's research and generation in one view.",
    sql: `SELECT slug, name, system_context,
                 content_angles, search_templates, hashtags, domains,
                 weight, max_age_days, enabled
          FROM topics
          WHERE slug = $1`,
    params: [{ name: "slug", label: "Topic slug", type: "text", required: true }],
    destructive: false,
    readOnly: true
  },

  "topic-feed-article-rollup": {
    label: "Topic / Feed / Article Rollup",
    description: "Per topic: number of mapped feeds and number of articles reachable through those feeds.",
    capability: "See the topic → feed → article funnel size for every topic at a glance.",
    sql: `SELECT t.slug, t.name,
                 count(DISTINCT ft.feed_id) AS mapped_feeds,
                 count(DISTINCT fa.article_id) AS available_articles
          FROM topics t
          LEFT JOIN feed_topics ft ON ft.topic_id = t.id
          LEFT JOIN feed_articles fa ON fa.feed_id = ft.feed_id
          GROUP BY t.slug, t.name
          ORDER BY t.slug`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "feed-domain-catalog": {
    label: "Feed Domain Catalog",
    description: "Per feed: name, tier, catchall flag, feed_categories, and domains.",
    capability: "See how each feed is classified and which domains it claims.",
    sql: `SELECT name, tier::text, is_catchall, feed_categories, domains
          FROM feeds_v2
          ORDER BY is_catchall DESC, name`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "topic-feed-domain-overlap": {
    label: "Topic / Feed Domain Overlap",
    description: "Pairs topics and feeds (within the same tenant) whose domain arrays intersect.",
    capability: "Understand why a feed matches a topic — the domain overlap that drives article scoring.",
    sql: `SELECT t.slug AS topic, f.name AS feed,
                 t.domains AS topic_domains, f.domains AS feed_domains
          FROM topics t
          JOIN feeds_v2 f ON f.tenant_id = t.tenant_id
          WHERE t.domains IS NOT NULL AND f.domains IS NOT NULL
            AND jsonb_typeof(t.domains) = 'array'
            AND jsonb_typeof(f.domains) = 'array'
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(t.domains) td
              JOIN jsonb_array_elements_text(f.domains) fd ON td = fd
            )
          ORDER BY t.slug, f.name`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "article-lineage": {
    label: "Article Lineage (recent)",
    description: "50 most recent articles with their source feed, tier, and the topics that feed maps to.",
    capability: "Trace any article backward through its feed to the topics it can feed.",
    sql: `SELECT a.title, a.published_at, f.name AS feed, f.tier::text AS tier,
                 string_agg(DISTINCT t.slug, ', ') AS mapped_topics
          FROM articles_v2 a
          JOIN feed_articles fa ON fa.article_id = a.id
          JOIN feeds_v2 f ON f.id = fa.feed_id
          LEFT JOIN feed_topics ft ON ft.feed_id = f.id
          LEFT JOIN topics t ON t.id = ft.topic_id
          GROUP BY a.id, a.title, a.published_at, f.name, f.tier
          ORDER BY a.published_at DESC NULLS LAST
          LIMIT 50`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "feed-discovery-health": {
    label: "Feed Discovery Health",
    description: "Feeds with validation grade, consecutive failures, and last validated time, ordered by tier then failures.",
    capability: "See the health of discovered feeds and which ones need attention.",
    sql: `SELECT name, tier::text, last_validation_grade, consecutive_failures,
                 last_validated_at, is_catchall
          FROM feeds_v2
          ORDER BY tier, consecutive_failures DESC, name`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "catchall-vs-topic-coverage": {
    label: "Catchall vs Topic Coverage",
    description: "Counts catchall feeds, topic-specific feeds, and topics with zero mapped feeds.",
    capability: "Spot coverage gaps — topics that have no dedicated feeds.",
    sql: `SELECT
            (SELECT count(*) FROM feeds_v2 WHERE is_catchall = true) AS catchall_feeds,
            (SELECT count(*) FROM feeds_v2 WHERE is_catchall = false) AS topic_specific_feeds,
            (SELECT count(*) FROM topics t WHERE NOT EXISTS (
               SELECT 1 FROM feed_topics ft WHERE ft.topic_id = t.id)) AS topics_with_no_feeds`,
    params: [],
    destructive: false,
    readOnly: true
  },

  // ── Agent state setters ──────────────────────────────────────

  "set-agent-paused": {
    label: "Set Agent Paused",
    description: "Pauses or resumes the agent for a tenant. Value must be 'true' or 'false'.",
    capability: "Stop or restart a tenant's scheduled posting without touching any other config.",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1::uuid, 'paused', $2)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true },
      { name: "value", label: "Paused (true or false)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "set-agent-corroboration": {
    label: "Set Corroboration",
    description: "Toggles multi-source corroboration for a tenant. Value must be 'enabled' or 'disabled'.",
    capability: "Turn cross-source fact-checking on or off for a tenant's content pipeline.",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1::uuid, 'corroboration', $2)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true },
      { name: "value", label: "Corroboration (enabled or disabled)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

"set-agent-model": {
    label: "Set Language Model",
    description: "Sets the per-tenant Language Model override from the live model catalog. Falls back to the deployment default when unset.",
    capability: "Pin or change which LLM a tenant's generation pipeline uses.",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1::uuid, 'anthropic_model', $2)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true },
      { name: "value", label: "Model", type: "select", source: "models", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "set-agent-state-generic": {
    label: "Set Agent State (any key)",
    description: "Sets any agent_state key/value for a tenant. Use for properties without a dedicated setter.",
    capability: "Maintenance escape hatch — adjust any single agent_state property by key.",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1::uuid, $2, $3)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true },
      { name: "key", label: "agent_state key", type: "text", required: true },
      { name: "value", label: "Value", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  // ── Tenant status ────────────────────────────────────────────

  "set-tenant-status": {
    label: "Set Tenant Status",
    description: "Sets the tenants.status field. Known values: pending, active, suspended. Suspending a tenant cuts off access.",
    capability: "Activate, suspend, or reset a tenant's lifecycle state. Run 'Database Wide enum Type Fields' to see all valid values.",
    sql: `UPDATE tenants SET status = $2::tenant_status WHERE id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true },
      { name: "status", label: "Status (pending / active / suspended)", type: "text", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  // ── Maintenance diagnostics (read-only) ──────────────────────

  "tenant-post-status-breakdown": {
    label: "Tenant Post Status Breakdown",
    description: "Counts a tenant's posts grouped by status (draft, pending_approval, posted, etc.).",
    capability: "Diagnose stuck or piled-up posts — see how a tenant's posts are distributed across the workflow.",
    sql: `SELECT status::text, count(*) AS posts
          FROM posts
          WHERE tenant_id = $1::uuid
          GROUP BY status
          ORDER BY status`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "recent-errors": {
    label: "Recent Errors",
    description: "50 most recent error-level activity_log entries for a tenant.",
    capability: "Triage failures fast — surface a tenant's recent errors without shell access to logs.",
    sql: `SELECT timestamp, action, details
          FROM activity_log
          WHERE tenant_id = $1::uuid AND level = 'error'::log_level
          ORDER BY timestamp DESC
          LIMIT 50`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  // ── Image observability (2.4.50) ────────────────────────────
  // Reconstructed for this lineage: the schema (DDLs 40-41) exists
  // in production even where the Image Studio feature does not, so
  // these read-only reports are valid today and become the feature
  // observability the moment the studio lineage lands.
  "image-studio-activity": {
    label: "Image Studio Activity",
    description: "Recent image generations across all tenants, newest first: who generated, with which provider and model, from what source. Read-only observability over the image ledger.",
    capability: "IMAGE STUDIO OBSERVABILITY",
    sql: `SELECT i.created_at, t.slug, i.provider, i.model, i.source_kind,
                 i.human_name, i.input_tokens, i.output_tokens
          FROM images i JOIN tenants t ON t.id = i.tenant_id
          ORDER BY i.created_at DESC LIMIT 200`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "image-cost-report": {
    label: "Image Cost Report",
    description: "Estimated image generation spend by tenant and model over the last N days, from recorded token usage and pre-spend estimates. Read-only observability over the cost ledger.",
    capability: "IMAGE STUDIO OBSERVABILITY",
    sql: `SELECT t.slug, i.provider, i.model,
                 count(*)::bigint AS generations,
                 COALESCE(sum(i.input_tokens), 0)::bigint AS input_tokens,
                 COALESCE(sum(i.output_tokens), 0)::bigint AS output_tokens,
                 ROUND(COALESCE(sum(i.pre_spend_estimate_usd), 0), 4) AS est_spend_usd
          FROM images i JOIN tenants t ON t.id = i.tenant_id
          WHERE i.created_at > now() - ($1 || ' days')::interval
          GROUP BY t.slug, i.provider, i.model
          ORDER BY est_spend_usd DESC LIMIT 100`,
    params: [
      { name: "days", label: "Window (days)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  // ── Subscription Controls (2.4.49) ──────────────────────────
  // One contiguous group on the console (group: subscriptions).
  // Mutations are single data-modifying CTEs: the change and its
  // platform_log audit row commit atomically or not at all. Tier
  // validity is enforced by the subscriptions CHECK constraint:
  // an invalid tier surfaces the constraint error, fail-closed.
  "sub-view-by-tenant": {
    label: "Subscription (By Tenant)",
    description: "The full subscription row for one tenant. Read one workspace's commercial state: tier, state, comp, period, pending.",
    capability: "TENANT SUBSCRIPTION MANAGEMENT",
    group: "subscriptions",
    sql: `SELECT tenant_id, tier, state, comp, pending_tier,
                 period_start, period_end, created_at, updated_at
          FROM subscriptions WHERE tenant_id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "sub-list-all": {
    label: "Subscriptions (All Tenants)",
    description: "Every subscription with its tenant, newest change first. The whole commercial ledger at a glance.",
    capability: "TENANT SUBSCRIPTION MANAGEMENT",
    group: "subscriptions",
    sql: `SELECT t.slug, s.tier, s.state, s.comp, s.pending_tier,
                 s.period_end, s.updated_at
          FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
          ORDER BY s.updated_at DESC LIMIT 200`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "sub-audit-by-tenant": {
    label: "Payment Audit (By Tenant)",
    description: "The immutable payment_events trail for one tenant. Every billing transition this workspace ever made, with provider refs.",
    capability: "TENANT SUBSCRIPTION MANAGEMENT",
    group: "subscriptions",
    sql: `SELECT recorded_at, event_type, prev_state, next_state,
                 provider, provider_event_ref
          FROM payment_events WHERE tenant_id = $1::uuid
          ORDER BY recorded_at DESC LIMIT 200`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "sub-set-tier": {
    label: "Set Tier (Immediate)",
    description: "Immediately set a tenant's tier; clears any pending tier. Audited. Operator tier override, atomic with its audit row. The CHECK constraint refuses unknown tiers.",
    capability: "TENANT SUBSCRIPTION MANAGEMENT",
    group: "subscriptions",
    sql: `WITH upd AS (
            UPDATE subscriptions
               SET tier = $2::text, pending_tier = NULL, updated_at = now()
             WHERE tenant_id = $1::uuid
             RETURNING tenant_id, tier, state
          ), aud AS (
            INSERT INTO platform_log (level, event, tenant_id, detail)
            SELECT 'warn', 'admin_subscription_tier_set', tenant_id,
                   jsonb_build_object('tier', tier)
              FROM upd
          )
          SELECT * FROM upd`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true },
      { name: "tier", label: "Tier", type: "select", source: "tiers", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "sub-extend-period": {
    label: "Extend Period",
    description: "Push a tenant's period_end forward by N days. Audited. Grace extension without touching the state machine: renewals stay anchored to the new period_end.",
    capability: "TENANT SUBSCRIPTION MANAGEMENT",
    group: "subscriptions",
    sql: `WITH upd AS (
            UPDATE subscriptions
               SET period_end = COALESCE(period_end, now()) + ($2 || ' days')::interval,
                   updated_at = now()
             WHERE tenant_id = $1::uuid
             RETURNING tenant_id, tier, state, period_end
          ), aud AS (
            INSERT INTO platform_log (level, event, tenant_id, detail)
            SELECT 'warn', 'admin_subscription_period_extended', tenant_id,
                   jsonb_build_object('period_end', period_end, 'days', $2::text)
              FROM upd
          )
          SELECT * FROM upd`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true },
      { name: "days", label: "Days to add", type: "text", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "sub-clear-pending": {
    label: "Clear Pending Tier",
    description: "Remove a queued tier change before it applies. Audited. Cancel a scheduled tier flip while the current cycle stays untouched.",
    capability: "TENANT SUBSCRIPTION MANAGEMENT",
    group: "subscriptions",
    sql: `WITH upd AS (
            UPDATE subscriptions
               SET pending_tier = NULL, updated_at = now()
             WHERE tenant_id = $1::uuid AND pending_tier IS NOT NULL
             RETURNING tenant_id, tier, state
          ), aud AS (
            INSERT INTO platform_log (level, event, tenant_id, detail)
            SELECT 'warn', 'admin_subscription_pending_cleared', tenant_id, '{}'::jsonb
              FROM upd
          )
          SELECT * FROM upd`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "sub-delete": {
    label: "Delete Subscription",
    description: "Remove a tenant's subscription row entirely: the tenant returns to the paywall. The payment audit trail is kept. Audited. The full reset: unsubscribed, halted, repurchasable. payment_events history survives by design.",
    capability: "TENANT SUBSCRIPTION MANAGEMENT",
    group: "subscriptions",
    sql: `WITH del AS (
            DELETE FROM subscriptions
             WHERE tenant_id = $1::uuid
             RETURNING tenant_id, tier, state
          ), aud AS (
            INSERT INTO platform_log (level, event, tenant_id, detail)
            SELECT 'warn', 'admin_subscription_deleted', tenant_id,
                   jsonb_build_object('tier', tier, 'state', state)
              FROM del
          )
          SELECT * FROM del`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
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

  // ── Payments (2.3.1.1): complimentary entitlements ──────────
  // The deliberate, auditable, processor-free grant. Router-level
  // gates above already enforce platform admin.

  router.get("/subscriptions", async (req, res) => {
    try {
      const { listSubscriptions } = await import("../services/entitlements.js");
      // tiers: derived from TIERS (2.4.54) so every console tier
      // surface renders the ruled set with zero hand maintenance.
      res.json({ subscriptions: await listSubscriptions(), tiers: TIERS });
    } catch (err) {
      res.status(500).json({ error: "Failed to list subscriptions" });
    }
  });

  router.post("/comp", async (req, res) => {
    try {
      const { tenantId, tier } = req.body || {};
      const { TIERS } = await import("../config/entitlements.js");
      if (!tenantId || !/^[0-9a-f-]{36}$/.test(String(tenantId))) {
        return res.status(400).json({ error: "A valid tenant id is required" });
      }
      if (!TIERS.includes(tier)) {
        return res.status(400).json({ error: "Choose a valid tier" });
      }
      const { grantComp } = await import("../services/entitlements.js");
      const row = await grantComp(tenantId, tier);
      const { platformLog } = await import("../services/platform-log.js");
      platformLog("info", "comp_entitlement_granted", { tenantId, tier, by: req.user.sub });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: "Comp grant failed" });
    }
  });

  router.delete("/comp/:tenantId", async (req, res) => {
    try {
      const tenantId = String(req.params.tenantId);
      if (!/^[0-9a-f-]{36}$/.test(tenantId)) {
        return res.status(400).json({ error: "A valid tenant id is required" });
      }
      const { revokeComp } = await import("../services/entitlements.js");
      const ok = await revokeComp(tenantId);
      if (!ok) return res.status(404).json({ error: "No complimentary subscription for that tenant" });
      const { platformLog } = await import("../services/platform-log.js");
      platformLog("info", "comp_entitlement_revoked", { tenantId, removed: true, by: req.user.sub });
      res.json({ tenantId, removed: true });
    } catch (err) {
      res.status(500).json({ error: "Comp revoke failed" });
    }
  });

  // ── GET /queries — list available queries ────────────────
  // Returns query metadata only — SQL is never exposed.

  router.get("/queries", (req, res) => {
    const queries = Object.entries(QUERY_REGISTRY).map(([key, q]) => ({
      key,
      label: q.label,
      description: q.description,
      capability: q.capability || null,
      params: q.params,
      destructive: q.destructive,
      readOnly: q.readOnly
    }));
    res.json({ queries });
  });

  // ── GET /models — live Anthropic model catalog ───────────
  // Populates the Set Anthropic Model dropdown dynamically so
  // nothing is hardcoded. Grouped server-side as Sonnet, Haiku,
  // Opus (in that order).
  //
  // Zero Trust:
  //   • Uses a dedicated platform key, never a tenant's BYOK key —
  //     a global lookup must not decrypt tenant secrets.
  //   • Key is stored ENCRYPTED at rest (env PLATFORM_ANTHROPIC_API_KEY,
  //     AES-256-GCM under HKDF(ENCRYPTION_SECRET)); decrypted at call
  //     time, held only for the request, then nulled.
  //   • Key is never logged and never sent to the client.
  //   • Fails closed if the encrypted key is unset or undecryptable (503).
  //   • Only model IDs are returned — no capabilities, pricing, or keys.
  //   • Behind the isPlatformAdmin gate (router-level).

  router.get("/models", async (req, res) => {
    const encKey = process.env.PLATFORM_ANTHROPIC_API_KEY;
    if (!encKey || encKey.trim().length === 0) {
      return res.status(503).json({ error: "Model listing is not configured" });
    }

    let apiKey;
    try {
      apiKey = decryptPlatformSecret(encKey.trim());
    } catch (err) {
      platformLog("error", "platform_key_decrypt_failed", { admin: req.user.sub });
      return res.status(503).json({ error: "Model listing is not configured" });
    }
    if (!apiKey || apiKey.length === 0) {
      return res.status(503).json({ error: "Model listing is not configured" });
    }

    const cached = getCachedModels();
    if (cached) {
      return res.json({ optgroups: cached });
    }

    try {
      // Vendor URL comes from the LLM registry profile, the single
      // sanctioned home for provider endpoints; the page limit is a
      // config getter. No vendor literals in the route layer.
      const anthropicProfile = getProvider("anthropic");
      const modelsUrl = resolveBaseUrl(anthropicProfile, process.env)
        + anthropicProfile.modelsPath + `?limit=${getModelListingPageLimit()}`;
      const resp = await fetch(modelsUrl, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        }
      });
      if (!resp.ok) {
        platformLog("error", "model_list_failed", { admin: req.user.sub, status: resp.status });
        return res.status(502).json({ error: "Could not retrieve models" });
      }
      const data = await resp.json();
      const optgroups = groupModelsByFamily(data.data || []);
      setCachedModels(optgroups);
      res.json({ optgroups });
    } catch (err) {
      platformLog("error", "model_list_error", { admin: req.user.sub, error: err.message });
      res.status(502).json({ error: "Could not retrieve models" });
    } finally {
      apiKey = null;
    }
  });
  
  // ── GET /tenants: tenant catalog for dropdowns ───────────
  // Populates tenant-select params (e.g. Set Language Model) so an
  // admin picks a tenant by name instead of pasting a UUID.
  //
  // Zero Trust:
  //   • Reads only the platform tenants table, under the platform
  //     admin DB role (SET LOCAL ROLE, transaction-scoped).
  //   • Returns only id, name, slug, and status. No secrets.
  //   • Behind the isPlatformAdmin gate (router-level).
  
  router.get("/tenants", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${resolveAdminRole()}`);   // ◄ same role elevation POST /execute uses
      const result = await client.query(
        `SELECT id, name, slug, status::text AS status
           FROM tenants
          ORDER BY name`
      );
      await client.query("COMMIT");
      res.json({ tenants: result.rows });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      platformLog("error", "tenant_list_failed", { admin: req.user.sub, error: err.message });
      res.status(502).json({ error: "Could not retrieve tenants" });
    } finally {
      client.release();
    }
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

    // ── Restricted table protection ──────────────────────────
    // Prevent admin queries from reading encrypted prompt content.
    // Metadata queries (key, description, updated_at) are allowed.
    var RESTRICTED_COLUMNS = [
      { table: "prompt_vault", columns: ["value_enc"] }
    ];

    var sqlLower = queryDef.sql.toLowerCase();
    for (var restriction of RESTRICTED_COLUMNS) {
      if (!sqlLower.includes(restriction.table)) continue;
      for (var col of restriction.columns) {
        if (sqlLower.includes(col)) {
          platformLog("warn", "platform_admin_restricted_column", {
            admin: req.user.sub, query: key, table: restriction.table, column: col
          });
          return res.status(403).json({ error: "Query references a restricted column" });
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${resolveAdminRole()}`);

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

  // ── Content genre insert ─────────────────────────────────
  // Dedicated endpoint — NOT part of QUERY_REGISTRY/execute.
  //
  // Why separate: the /execute path runs raw registry SQL and is
  // firewalled from prompt_vault.value_enc by design (encryption
  // must never happen client-side). Inserting a genre template
  // requires server-side AES-256-GCM encryption, so it goes
  // through storePromptGenre() in prompt-vault.js — the same
  // encrypt() the default prompt uses. Plaintext is received over
  // the authenticated admin request, encrypted in memory, and only
  // the ciphertext blob is persisted. The body is never logged.
  //
  // SECURITY NOTE (tracked, high priority): the template plaintext
  // travels over the wire and lives briefly in server memory during
  // this request. Same exposure profile as seeding the default
  // prompt. TLS termination at the ALB/CloudFront protects it in
  // transit. A future hardening pass should reduce this window.
  //
  // Gated by router-level requireAuth + requirePlatformAdmin.
  router.post("/content-genre", async (req, res) => {
    const { genre, template, description, confirmed } = req.body || {};

    // Audit the attempt WITHOUT the template body or any ciphertext.
    platformLog("info", "content_genre_write_attempt", {
      admin: req.user.sub,
      genre: typeof genre === "string" ? genre : "(invalid)",
      templateLength: typeof template === "string" ? template.length : 0,
      confirmed: confirmed === true
    });

    try {
      const result = await storePromptGenre(
        "content_generator", genre, template, description, confirmed === true
      );
      res.json({ success: true, action: result.action, key: "content_generator", genre });
    } catch (err) {
      // CONFIRM_OVERWRITE is not a failure — it tells the UI the
      // template already exists and to ask the admin to confirm
      // the overwrite, then resend with confirmed:true. 409 Conflict.
      if (err.code === "CONFIRM_OVERWRITE") {
        return res.status(409).json({
          needsConfirm: true,
          message: "A template for genre '" + genre + "' already exists. Overwrite it?"
        });
      }
      // Map known validation codes to safe 400s; everything else
      // is a generic 500 that never leaks internals.
      const SAFE = {
        INVALID_GENRE:  "Genre must be lowercase, start with a letter, and be 2-32 characters.",
        EMPTY_TEMPLATE: "Template text is required.",
        EMPTY_DESCRIPTION: "Description is required."
      };
      if (err.code && SAFE[err.code]) {
        platformLog("warn", "content_genre_write_rejected", {
          admin: req.user.sub, genre, reason: err.code
        });
        return res.status(400).json({ error: SAFE[err.code], code: err.code });
      }
      platformLog("error", "content_genre_write_failed", {
        admin: req.user.sub, error: err.message
      });
      return res.status(500).json({ error: "An internal error occurred" });
    }
  });

  return router;
}
