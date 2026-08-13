// =================================================================
// src/routes/platform-admin-queries.js - the console query registry
// =================================================================
// DATA module (2.5.66 split, was inline in platform-admin-api at
// 1482 lines): every console query's label, sql, params, and flags,
// plus the SQL builders some entries evaluate at load, with their
// one data source import (seed-defaults). No routing, no side
// effects: adding a query is an append here and nothing else, which
// also retires this registry's history as the tree's worst
// merge-conflict magnet. Frozen at the top level.

import { getCatchallFeedList } from "../tenant/seed-defaults.js";

// SQL builders the registry entries evaluate at load: they are
// part of the DATA and travel with it (2.5.67).
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

export const QUERY_REGISTRY = Object.freeze({

  "add-member": {
    label: "Add Member as Owner",
    description: "Adds an owner user for the tenant.",
    capability: "MEMBERSHIPS",
    sql: `INSERT INTO public.memberships(
            tenant_id, auth_provider, auth_sub, role)
            VALUES ($1::uuid, 'auth0', $2::text, 'owner')`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true },
      { name: "auth_sub", label: "Auth Sub", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "catchall-v1": {
    label: "feeds serving each topic",
    description: "-- V1: feeds serving each topic, by tier and catchall, across all tenants.",
    capability: "FEEDS CATCHALL",
    sql: `SELECT te.slug AS tenant, t.slug AS topic_slug,
            f.tier::text AS tier, f.is_catchall,
            count(*) AS feed_count
          FROM tenants te
          JOIN topics   t ON t.tenant_id = te.id AND t.enabled = true
          JOIN feeds_v2 f ON f.tenant_id = te.id AND f.enabled = true
          WHERE f.is_catchall
            OR EXISTS (SELECT 1 FROM feed_topics ft WHERE ft.feed_id = f.id AND ft.topic_id = t.id)
            OR (t.domains <> '[]'::jsonb
                AND f.domains ?| ARRAY(SELECT jsonb_array_elements_text(t.domains)))
          GROUP BY te.slug, t.slug, f.tier, f.is_catchall
          ORDER BY te.slug, t.slug, f.tier, f.is_catchall`,
    params: [],
    destructive: false,
    readOnly: true
  },
  "catchall-v2": {
    label: "tier profile per topic",
    description: "-- V2: tier profile per topic (wide format).",
    capability: "FEEDS CATCHALL",
    sql: `SELECT te.slug AS tenant, t.slug AS topic_slug,
            count(*) FILTER (WHERE f.tier = 'authoritative') AS authoritative,
            count(*) FILTER (WHERE f.tier = 'primary')       AS primary_ct,
            count(*) FILTER (WHERE f.tier = 'secondary')     AS secondary_ct,
            count(*) FILTER (WHERE f.is_catchall)            AS catchall,
            count(*) FILTER (WHERE NOT f.is_catchall)        AS dedicated,
            count(*)                                         AS total_feeds
          FROM tenants te
          JOIN topics   t ON t.tenant_id = te.id AND t.enabled = true
          JOIN feeds_v2 f ON f.tenant_id = te.id AND f.enabled = true
          AND ( f.is_catchall
              OR EXISTS (SELECT 1 FROM feed_topics ft WHERE ft.feed_id = f.id AND ft.topic_id = t.id)
              OR (t.domains <> '[]'::jsonb
                  AND f.domains ?| ARRAY(SELECT jsonb_array_elements_text(t.domains))) )
          GROUP BY te.slug, t.slug
          ORDER BY te.slug, t.slug`,
    params: [],
    destructive: false,
    readOnly: true
  },
  "catchall-v3": {
    label: "how feeds reach each topic",
    description: "-- V3: how feeds reach each topic (explicit map / domain overlap / catchall).",
    capability: "FEEDS CATCHALL",
    sql: `SELECT te.slug AS tenant, t.slug AS topic_slug,
            count(*) FILTER (WHERE ft.feed_id IS NOT NULL) AS via_explicit_map,
            count(*) FILTER (WHERE t.domains <> '[]'::jsonb
                  AND f.domains ?| ARRAY(SELECT jsonb_array_elements_text(t.domains))) AS via_domain_overlap,
            count(*) FILTER (WHERE f.is_catchall) AS via_catchall,
            count(*) AS feeds_serving
          FROM tenants te
          JOIN topics   t ON t.tenant_id = te.id AND t.enabled = true
          JOIN feeds_v2 f ON f.tenant_id = te.id AND f.enabled = true
          LEFT JOIN feed_topics ft ON ft.feed_id = f.id AND ft.topic_id = t.id
          WHERE f.is_catchall
            OR ft.feed_id IS NOT NULL
            OR (t.domains <> '[]'::jsonb
                AND f.domains ?| ARRAY(SELECT jsonb_array_elements_text(t.domains)))
          GROUP BY te.slug, t.slug
          ORDER BY te.slug, t.slug`,
    params: [],
    destructive: false,
    readOnly: true
  },
  "catchall-v4": {
    label: "under-served topics",
    description: "-- V4: under-served topics (no dedicated feed, or no authoritative source).",
    capability: "FEEDS CATCHALL",
    sql: `SELECT te.slug AS tenant, t.slug AS topic_slug,
            count(f.id) FILTER (WHERE NOT f.is_catchall)      AS dedicated_feeds,
            count(f.id) FILTER (WHERE f.tier='authoritative') AS authoritative_feeds,
            count(f.id) FILTER (WHERE f.is_catchall)          AS catchall_feeds,
            count(f.id)                                       AS total_serving
          FROM tenants te
          JOIN topics t ON t.tenant_id = te.id AND t.enabled = true
          LEFT JOIN feeds_v2 f
                ON f.tenant_id = te.id AND f.enabled = true
                AND ( f.is_catchall
                  OR EXISTS (SELECT 1 FROM feed_topics ft WHERE ft.feed_id = f.id AND ft.topic_id = t.id)
                  OR (t.domains <> '[]'::jsonb
                      AND f.domains ?| ARRAY(SELECT jsonb_array_elements_text(t.domains))) )
          GROUP BY te.slug, t.slug
          HAVING count(f.id) FILTER (WHERE NOT f.is_catchall) = 0
              OR count(f.id) FILTER (WHERE f.tier='authoritative') = 0
          ORDER BY total_serving ASC, dedicated_feeds ASC, te.slug, t.slug`,
    params: [],
    destructive: false,
    readOnly: true
  },
  "catchall-v5": {
    label: "per-tenant feed inventory",
    description: "-- V5 (preferred): no correlated subquery; distinct counts over two LEFT JOINs.",
    capability: "FEEDS CATCHALL",
    sql: `SELECT te.slug AS tenant, te.name AS tenant_name, te.status::text AS status,
            count(f.id) FILTER (WHERE f.tier='authoritative')   AS authoritative,
            count(f.id) FILTER (WHERE f.tier='primary')         AS primary_ct,
            count(f.id) FILTER (WHERE f.tier='secondary')       AS secondary_ct,
            count(f.id) FILTER (WHERE f.is_catchall)            AS catchall,
            count(f.id) FILTER (WHERE NOT f.is_catchall)        AS dedicated,
            count(f.id) FILTER (WHERE f.domains <> '[]'::jsonb) AS domain_tagged,
            count(f.id)                                         AS total_feeds,
            (SELECT count(*) FROM topics t WHERE t.tenant_id = te.id AND t.enabled) AS enabled_topics
          FROM tenants te
          LEFT JOIN feeds_v2 f ON f.tenant_id = te.id AND f.enabled = true
          GROUP BY te.id, te.slug, te.name, te.status
          ORDER BY te.slug;`,
    params: [],
    destructive: false,
    readOnly: true
  },

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

  "image-studio-activity": {
    label: "Image Studio Activity",
    description: "Recent Image Studio events across all tenants, newest first: renders, refinements, attachments, budget refusals, storage switches.",
    capability: "Watch the image pipeline operate end to end.",
    sql: `SELECT created_at, tenant_id, level, event, detail
          FROM platform_log WHERE event LIKE 'image\\_%'
          ORDER BY created_at DESC LIMIT 200`,
    params: [],
    destructive: false,
    readOnly: true
  },
  "image-cost-report": {
    label: "Image Cost Report (Estimate v. Actual)",
    description: "Per tenant and model over the window: renders, images, the pre-spend the budget gate charged, and the reconciled actual cost from token usage.",
    capability: "Reconcile what the gate charged against what the vendor billed.",
    sql: `SELECT tenant_id, detail->>'model' AS model,
                 COUNT(*) AS renders,
                 SUM((detail->>'imageCount')::int) AS images,
                 ROUND(SUM((detail->>'preSpendUsd')::numeric), 4) AS pre_spend_usd,
                 ROUND(SUM((detail->>'costEstimateUsd')::numeric), 4) AS actual_cost_usd,
                 SUM((detail->'usage'->>'outputTokens')::bigint) AS output_tokens
          FROM platform_log
          WHERE event = 'image_response_orchestrated'
            AND created_at >= now() - ($1 || ' days')::interval
          GROUP BY tenant_id, detail->>'model'
          ORDER BY actual_cost_usd DESC NULLS LAST LIMIT 200`,
    params: [
      { name: "days", label: "Window (days)", type: "text", required: true }
    ],
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

  // ── Phase 0 capacity instrumentation ────────────────────────
  // Reads runtime_metric, written once per sampling window by
  // services/runtime-metrics.js. These four are the baseline
  // scoreboard for the transaction-scope work: they answer how
  // long connections are held, whether the pool is starving,
  // whether the event loop is blocked, and which call sites are
  // responsible.

  "runtime-gauges": {
    label: "Runtime Gauges (Recent Windows)",
    description: "Latest sampling windows: event loop lag, transaction hold times, pool saturation, and memory.",
    capability: "The capacity scoreboard: one row per window, newest first.",
    sql: `SELECT captured_at, window_seconds,
                 loop_lag_p99_ms, loop_lag_max_ms,
                 txn_count, txn_hold_p50_ms, txn_hold_p99_ms, txn_hold_max_ms,
                 txn_wait_p99_ms, txn_open_max, txn_error_count,
                 acquire_failure_count,
                 pool_total, pool_idle, pool_waiting_max, pool_max,
                 rss_mb, heap_used_mb
          FROM runtime_metric
          ORDER BY captured_at DESC LIMIT 200`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "transaction-hold-summary": {
    label: "Transaction Hold Summary (Window)",
    description: "Aggregated transaction hold and wait behavior over the last N hours, with the worst window called out.",
    capability: "Prove whether transaction hold time is improving, in one number.",
    sql: `SELECT COUNT(*)::bigint AS windows,
                 SUM(txn_count)::bigint AS transactions,
                 ROUND(AVG(txn_hold_p50_ms), 3) AS avg_hold_p50_ms,
                 ROUND(MAX(txn_hold_p99_ms), 3) AS worst_hold_p99_ms,
                 ROUND(MAX(txn_hold_max_ms), 3) AS worst_hold_max_ms,
                 ROUND(MAX(txn_wait_p99_ms), 3) AS worst_wait_p99_ms,
                 MAX(txn_open_max) AS peak_open_transactions,
                 MAX(pool_max) AS pool_ceiling,
                 SUM(txn_error_count)::bigint AS rollbacks,
                 SUM(acquire_failure_count)::bigint AS pool_acquire_failures,
                 ROUND(MAX(loop_lag_p99_ms), 3) AS worst_loop_lag_p99_ms
          FROM runtime_metric
          WHERE captured_at >= now() - ($1 || ' hours')::interval`,
    params: [
      { name: "hours", label: "Window (hours)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "transaction-slow-sites": {
    label: "Slow Transaction Call Sites",
    description: "Call sites ranked by worst observed transaction hold time over the last N hours.",
    capability: "Name the exact file and line holding connections longest, ranked worst first.",
    sql: `SELECT s->>'site' AS call_site,
                 SUM((s->>'count')::bigint) AS slow_transactions,
                 ROUND(MAX((s->>'maxMs')::numeric), 3) AS worst_hold_ms,
                 ROUND(AVG((s->>'avgMs')::numeric), 3) AS avg_hold_ms,
                 MIN(captured_at) AS first_seen,
                 MAX(captured_at) AS last_seen
          FROM runtime_metric,
               LATERAL jsonb_array_elements(COALESCE(detail->'slowSites', '[]'::jsonb)) AS s
          WHERE captured_at >= now() - ($1 || ' hours')::interval
          GROUP BY s->>'site'
          ORDER BY worst_hold_ms DESC NULLS LAST LIMIT 100`,
    params: [
      { name: "hours", label: "Window (hours)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "pool-saturation-windows": {
    label: "Pool Saturation Windows",
    description: "Only the windows where callers queued for a connection or an acquisition failed outright.",
    capability: "Isolate the exact moments the pool ran dry and users saw errors.",
    sql: `SELECT captured_at, txn_count, txn_open_max, pool_max,
                 pool_waiting_max, acquire_failure_count,
                 txn_wait_p99_ms, txn_hold_p99_ms, txn_hold_max_ms,
                 loop_lag_p99_ms
          FROM runtime_metric
          WHERE (pool_waiting_max > 0 OR acquire_failure_count > 0)
            AND captured_at >= now() - ($1 || ' hours')::interval
          ORDER BY captured_at DESC LIMIT 200`,
    params: [
      { name: "hours", label: "Window (hours)", type: "text", required: true }
    ],
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
    capability: "MEMBERSHIPS.",
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
    capability: "MEMBERSHIPS.",
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
    capability: "MEMBERSHIPS.",
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
    description: "Shows all agent_state configuration values for a tenant with schema metadata.",
    capability: "agent_state per tenant.",
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
    description: "Sets feeds_manager_version for a tenant, v1 and v2 Feeds Manager (1 or 2).",
    capability: "agent_state per tenant.",
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
    description: "Removes all posts for a tenant — useful for resetting a demo or test tenant.",
    capability: "REMOVETENANT.",
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
    capability: "REMOVETENANT.",
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
    capability: "REMOVETENANT INVITES.",
    sql: `DELETE FROM invites WHERE tenant_id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "select-tenant-invites": {
    label: "Shows Tenant Registration Invites (all users)",
    description: "Shows all invites (pending and claimed) for a tenant.",
    capability: "REGISTER INVITES.",
    sql: `select tr.email, i.status Invite, tr.invited_by_sub InvitedBy, i.created_at CreatedAt
              ,i.claimed_at Claimed, t.name Tenant, s.state Subscription, s.comp
          from tenant_registrations tr
          left join invites i on i.tenant_id = tr.tenant_id
          left join tenants t on t.id = i.tenant_id
          left join subscriptions s on s.tenant_id = i.tenant_id
          order by s.state,s.comp,i.status`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "clear-self-service-registrations": {
    label: "Clear Self-Service Registrations",
    description: "Removes the tenant registrations for self-service signups using the email address.",
    capability: "REMOVETENANT SELFSERVICE REGISTER",
    // lower() on BOTH sides: the store INSERTs lower(email), so a
    // mixed-case address typed here must still match (a bare
    // email = $1 silently deleted nothing).
    sql: `DELETE FROM tenant_registrations
            WHERE invited_by_sub
            LIKE 'self:%'
              AND lower(email) = lower($1)`,
    params: [
      { name: "email", label: "Email Address", type: "text", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "show-self-service-registrations": {
    label: "Show Self-Service Registrations",
    description: "Finds the self-service tenant registrations for the email address.",
    capability: "TENANT SELFSERVICE REGISTER",
    // lower() on BOTH sides: matches the store's lower(email) writes.
    sql: `SELECT tr.email, tr.status Registration, t.name Tenant, tr.created_at RegCreated, expires_at RegExpires, tr.invited_by_sub InvitedBy
            FROM tenant_registrations tr
              LEFT JOIN tenants t ON tr.tenant_id = t.id
            WHERE invited_by_sub
            LIKE 'self:%'
              AND lower(tr.email) = lower($1)`,
    params: [
      { name: "email", label: "Email Address", type: "text", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "clear-tenant-memberships": {
    label: "Clear Tenant Membership",
    description: "Removes all memberships for a tenant, revoking every user's access.",
    capability: "REMOVETENANT MEMBERSHIPS",
    sql: `DELETE FROM memberships WHERE tenant_id = $1::uuid`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-master": {
    label: "Clear Tenant",
    description: "Deletes the tenant - Final teardown step. Run the other REMOVETENANT queries first to remove dependent data.",
    capability: "REMOVETENANT.",
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
    capability: "agent_state per tenant.",
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

  "clear-tenant-api-keys": {
    label: "Clear LLM Credentials",
    description: "Removes API keys and LLM credentials",
    capability: "TENANT LLM SETTINGS",
    sql: `DELETE FROM credentials
          WHERE tenant_id = $1::uuid
          AND key in (
            'anthropic_api_key',
            'openai_api_key'
          )`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-linked-creds": {
    label: "Clear LinkedIn Credentials",
    description: "Removes linkedin_person_urn,linkedin_org_urn,linkedin_access_token,linkedin_refresh_token",
    capability: "TENANT LINKEDIN SETTINGS",
    sql: `DELETE FROM credentials
          WHERE tenant_id = $1::uuid
          AND key in (
            'linkedin_person_urn'
            ,'linkedin_org_urn'
            ,'linkedin_access_token'
            ,'linkedin_refresh_token'
          )`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  "clear-llm-providers": {
    label: "Clear LLM Providers",
    description: "Removes language and image LLM provider and model settings",
    capability: "agent_state per tenant TENANT LLM SETTINGS",
    sql: `DELETE FROM agent_state
          WHERE tenant_id = $1::uuid
          AND key in (
            'image_provider',
            'image_model',
            'llm_provider',
            'llm_model',
            'anthropic_model'
          )`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: true,
    readOnly: false
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
    description: "Pauses or resumes the agentic generation for a tenant. Value must be 'true' or 'false'.",
    capability: "agent_state per tenant",
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
    description: "Toggles multi-source, fact-checking corroboration for a tenant's content pipeline. Value must be 'enabled' or 'disabled'.",
    capability: "agent_state per tenant",
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
    description: "Sets the per-tenant Language Model override from the live Anthropic model catalog for the generation pipeline. Falls back to the deployment default when unset.",
    capability: "agent_state per tenant AI Model display card.",
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
    description: "Maintenance escape hatch — adjust any single agent_state property by key. Sets any agent_state key/value for a tenant. Use for properties without a dedicated setter.",
    capability: "agent_state per tenant.",
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
          LIMIT 200`,
    params: [
      { name: "tenant_id", label: "Tenant", type: "select", source: "tenants", required: true }
    ],
    destructive: false,
    readOnly: true
  },

  "llm-spend-by-tenant": {
    label: "LLM Spend by Tenant",
    description: "Ledger sums over the window per tenant, provider, and key source: calls, tokens, and estimate dollars. The double-ledger view: whose money burned where.",
    capability: "See what every workspace spends, split by who paid.",
    sql: `SELECT tenant_id, provider::text, key_source::text,
                 COUNT(*) AS calls,
                 SUM(COALESCE(input_tokens,0)) AS input_tokens,
                 SUM(COALESCE(output_tokens,0)) AS output_tokens,
                 ROUND(SUM(cost_estimate_usd), 4) AS cost_estimate_usd
          FROM llm_spend_events
          WHERE created_at >= now() - ($1 || ' days')::interval
          GROUP BY tenant_id, provider, key_source
          ORDER BY cost_estimate_usd DESC NULLS LAST`,
    params: [{ name: "days", label: "Window (days)", type: "text", required: true }],
    destructive: false,
    readOnly: true
  },

  "llm-activations-by-workflow": {
    label: "LLM Activations by Workflow",
    description: "Lifecycle counts and spend per workflow kind over the window: which product surfaces drive cost.",
    capability: "Attribute spend to the workflows that caused it.",
    sql: `SELECT a.workflow::text,
                 COUNT(DISTINCT a.id) AS activations,
                 COUNT(e.id) AS calls,
                 ROUND(SUM(e.cost_estimate_usd), 4) AS cost_estimate_usd
          FROM llm_activations a
          LEFT JOIN llm_spend_events e ON e.activation_id = a.id
          WHERE a.created_at >= now() - ($1 || ' days')::interval
          GROUP BY a.workflow
          ORDER BY cost_estimate_usd DESC NULLS LAST`,
    params: [{ name: "days", label: "Window (days)", type: "text", required: true }],
    destructive: false,
    readOnly: true
  },

  "trial-burn-by-tenant": {
    label: "Trial Burn by Tenant",
    description: "Every trial grant with its tenant, caps, and ledger-summed burn. The platform's money, accounted.",
    capability: "Watch trial keys burn against their caps in real time.",
    sql: `SELECT k.name, k.provider::text, k.key_fingerprint, ta.tenant_id,
                 ta.active AS grant_active, k.active AS key_active,
                 k.starts_at, k.ends_at,
                 ROUND(trial_activation_spend_usd(ta.id), 4) AS activation_spent_usd,
                 ta.max_spend_usd AS activation_cap_usd,
                 ROUND(trial_key_spend_usd(k.id), 4) AS key_spent_usd,
                 k.max_spend_usd AS key_cap_usd
          FROM trial_key_activations ta
          JOIN trial_keys k ON k.id = ta.trial_key_id
          ORDER BY ta.activated_at DESC`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "llm-unknown-usage-audit": {
    label: "Unknown Usage Audit",
    description: "Spend events where tokens were possibly consumed but never reported (timeouts): the rows to reconcile first when an invoice surprises.",
    capability: "Find the money that may have moved unreported.",
    sql: `SELECT created_at, tenant_id, provider::text, model, key_source::text, request_type::text
          FROM llm_spend_events
          WHERE status = 'unknown_usage'
          ORDER BY created_at DESC LIMIT 200`,
    params: [],
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
    capability: "SUBSCRIPTION",
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
    capability: "SUBSCRIPTION",
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
    capability: "SUBSCRIPTION",
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
    capability: "SUBSCRIPTION",
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

  "sub-add-or-change-no-comp": {
    label: "Add Or Change Subscription",
    description: "Immediately add or update a tenant's subscription tier; clears any pending tier. Audited. Operator tier override, atomic with its audit row. The CHECK constraint refuses unknown tiers.",
    capability: "SUBSCRIPTION",
    group: "subscriptions",
    sql: `WITH upd AS (
            insert into subscriptions (tenant_id,tier,state,comp)
               values ($1::uuid,$2::text,'active',false)
               ON CONFLICT (tenant_id) do update set tier=$2::text
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
    capability: "SUBSCRIPTION",
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
    capability: "SUBSCRIPTION",
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
    capability: "SUBSCRIPTION",
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
});
