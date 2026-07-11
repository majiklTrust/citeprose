// =================================================================
// src/services/analytics-sync.js, tenant metric sync (FR-P1-01/02)
// =================================================================
// Walks the tenant's published posts that carry a LinkedIn URN,
// fetches current share statistics, and upserts the latest snapshot
// into post_metrics; then refreshes follower_demographics as one
// coherent facet-replace inside the same transaction.
//
// Failure discipline (FR-CC-01/02):
//   TOKEN_EXPIRED / SCOPE_DENIED   systemic: abort the tenant batch,
//                                  log the DISTINCT action, report it
//   RATE_LIMITED                   stop politely, resume next cycle
//   ENDPOINT_ERROR / NETWORK       per-post: record and continue
//   missing credentials            skip tenant with a loud log entry
//
// Reads and writes go through currentClient() (metric-store
// precedent): parameterized SQL only, RLS-scoped, throws outside a
// withTenant frame. deps are injectable for the test suite.
// =================================================================

// Import discipline (LLM-layer precedent): DB-touching modules
// (with-tenant, platform-db, credential-store, database) arrive via
// lazy dynamic import inside the functions that need them, so this
// module LOADS with no database environment and the pure policy
// core is testable DB-free.
import {
  fetchShareStatistics, fetchFollowerStatistics, isPublishedPostUrn
} from "./linkedin-analytics.js";
import { LI_ERROR_CODES, isLinkedInApiError } from "./linkedin-errors.js";
import {
  getAnalyticsBatchSize, getAnalyticsCallDelayMs, getAnalyticsSyncCronRaw
} from "../config/analytics.js";
import { resolvePollSchedule } from "../config/poll-schedule.js";
import { platformLog } from "./platform-log.js";

import { isOrganizationManagerEnabled } from "./organization-manager.js";
async function client() {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) throw new Error("analytics sync requires tenant context (withTenant)");
  return c;
}

const SYSTEMIC = new Set([LI_ERROR_CODES.TOKEN_EXPIRED, LI_ERROR_CODES.SCOPE_DENIED]);

// Pure batch policy, exported for the test suite: decides whether a
// per-post failure ends the tenant batch and which activity action
// records it (distinct expiry vs scope, FR-CC-01).
export function batchPolicyFor(code) {
  if (SYSTEMIC.has(code)) {
    return {
      abort: true,
      action: code === LI_ERROR_CODES.TOKEN_EXPIRED
        ? "analytics_sync_token_expired"
        : "analytics_sync_scope_denied"
    };
  }
  if (code === LI_ERROR_CODES.RATE_LIMITED) {
    return { abort: true, action: "analytics_sync_rate_limited" };
  }
  return { abort: false, action: "analytics_sync_post_failed" };
}

async function sleep(ms) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

// ── Store helpers (parameterized, RLS-scoped) ─────────────────
export async function upsertPostMetrics(postId, m, retrievedAt) {
  await (await client()).query(
    `INSERT INTO post_metrics
       (tenant_id, post_id, impressions, clicks, likes, comments, shares, retrieved_at)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, post_id) DO UPDATE SET
       impressions = EXCLUDED.impressions,
       clicks      = EXCLUDED.clicks,
       likes       = EXCLUDED.likes,
       comments    = EXCLUDED.comments,
       shares      = EXCLUDED.shares,
       retrieved_at = EXCLUDED.retrieved_at`,
    [postId, m.impressions, m.clicks, m.likes, m.comments, m.shares, retrievedAt]
  );
}

export async function replaceDemographics(rows, retrievedAt) {
  const c = await client();
  const facets = [...new Set(rows.map((r) => r.facet))];
  // Replace whole facets so the table is always one coherent
  // snapshot; runs inside the caller's withTenant transaction.
  for (const facet of facets) {
    await c.query(
      "DELETE FROM follower_demographics WHERE tenant_id = current_tenant_id() AND facet = $1",
      [facet]
    );
  }
  for (const r of rows) {
    await c.query(
      `INSERT INTO follower_demographics
         (tenant_id, facet, entity, label, follower_count, retrieved_at)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, facet, entity) DO UPDATE SET
         label = EXCLUDED.label,
         follower_count = EXCLUDED.follower_count,
         retrieved_at = EXCLUDED.retrieved_at`,
      [r.facet, r.entity, r.label, r.followerCount, retrievedAt]
    );
  }
  return facets.length;
}

// ── Per-tenant sync (runs INSIDE withTenant) ──────────────────
export async function syncTenantAnalytics(deps = {}) {
  const d = {
    fetchStats: fetchShareStatistics,
    fetchFollowers: fetchFollowerStatistics,
    batchSize: getAnalyticsBatchSize(),
    callDelayMs: getAnalyticsCallDelayMs(),
    respectEnabledFlag: true,
    ...deps
  };
  // DB-touching defaults load lazily; injected test deps skip them.
  if (!d.getToken || !d.getOrgUrn) {
    const cs = await import("../tenant/credential-store.js");
    d.getToken = d.getToken || cs.getLinkedInAccessToken;
    d.getOrgUrn = d.getOrgUrn || cs.getLinkedInOrgUrn;
  }
  if (!d.getState || !d.log) {
    const db = await import("./database.js");
    d.getState = d.getState || db.getAgentState;
    d.log = d.log || db.logActivity;
  }

  if (d.respectEnabledFlag) {
    const enabled = await d.getState("analytics_sync_enabled");
    if (String(enabled) === "false") {
      return { status: "disabled", postsUpdated: 0, postsFailed: 0, demographicsFacets: 0 };
    }
  }

  // Two DISTINCT missing-configuration states (FR-CC-01 spirit):
  // no access token means LinkedIn is not connected at all; a token
  // without an org URN means the org page is not configured. The
  // first is fixed by Connect/Reconnect, the second by Connect Org
  // Page. Collapsing them sends the operator to the wrong fix.
  let token, orgUrn;
  try {
    token = await d.getToken();
  } catch (err) {
    await d.log("warn", "analytics_sync_skipped", {
      code: LI_ERROR_CODES.NOT_CONNECTED, reason: err.message
    });
    return { status: "not_connected", postsUpdated: 0, postsFailed: 0, demographicsFacets: 0 };
  }
  try {
    orgUrn = await d.getOrgUrn();
  } catch (err) {
    await d.log("warn", "analytics_sync_skipped", {
      code: "LINKEDIN_ORG_NOT_CONFIGURED", reason: err.message
    });
    return { status: "org_not_configured", postsUpdated: 0, postsFailed: 0, demographicsFacets: 0 };
  }

  // Org share statistics exist ONLY for organization-authored
  // posts, so the sweep attempts exactly those. Legacy rows with a
  // NULL publish_target (published before the per-post column, or
  // under the env default) are excluded: their authorship is not
  // recorded, and attempting personally-authored posts against the
  // org endpoint only manufactures per-post failure noise. An
  // operator who knows legacy posts were org-authored can backfill
  // posts.publish_target to include them.
  const { rows: posts } = await (await client()).query(
    `SELECT id, linkedin_id
       FROM posts
      WHERE linkedin_id IS NOT NULL AND status = 'posted'
        AND publish_target = 'organization'
      ORDER BY posted_at DESC NULLS LAST, id DESC
      LIMIT $1`,
    [d.batchSize]
  );

  const summary = { status: "ok", postsUpdated: 0, postsFailed: 0, demographicsFacets: 0, aborted: null };
  const retrievedAt = new Date().toISOString();

  for (const post of posts) {
    if (!isPublishedPostUrn(post.linkedin_id)) {
      summary.postsFailed++;
      await d.log("warn", "analytics_sync_post_failed", {
        postId: post.id, code: LI_ERROR_CODES.ENDPOINT_ERROR, reason: "stored URN not recognized"
      });
      continue;
    }
    try {
      const metrics = await d.fetchStats(token, orgUrn, post.linkedin_id);
      await upsertPostMetrics(post.id, metrics, retrievedAt);
      summary.postsUpdated++;
    } catch (err) {
      const code = isLinkedInApiError(err) ? err.code : LI_ERROR_CODES.ENDPOINT_ERROR;
      const policy = batchPolicyFor(code);
      const details = { postId: post.id, code, ...(isLinkedInApiError(err) ? err.details : {}) };
      await d.log(policy.abort ? "error" : "warn", policy.action, details);
      if (policy.abort) {
        summary.status = "aborted";
        summary.aborted = code;
        return summary;
      }
      summary.postsFailed++;
    }
    await sleep(d.callDelayMs);
  }

  try {
    const demoRows = await d.fetchFollowers(token, orgUrn);
    summary.demographicsFacets = await replaceDemographics(demoRows, retrievedAt);
  } catch (err) {
    const code = isLinkedInApiError(err) ? err.code : LI_ERROR_CODES.ENDPOINT_ERROR;
    const policy = batchPolicyFor(code);
    await d.log("warn", policy.abort ? policy.action : "analytics_demographics_failed",
      { code, ...(isLinkedInApiError(err) ? err.details : {}) });
    if (policy.abort) {
      summary.status = "aborted";
      summary.aborted = code;
      return summary;
    }
  }

  await d.log("info", "analytics_sync_complete", {
    postsUpdated: summary.postsUpdated,
    postsFailed: summary.postsFailed,
    demographicsFacets: summary.demographicsFacets
  });
  return summary;
}

// ── Batch over active tenants + cron ──────────────────────────
export async function runAnalyticsSyncBatch() {
  let tenants = [];
  try {
    const { listActiveTenants } = await import("../tenant/platform-db.js");
    tenants = await listActiveTenants();
  } catch (err) {
    platformLog("error", "analytics_sync_tenant_list_failed", { error: err.message });
    return { tenants: 0, ok: 0, failed: 0 };
  }
  const { withTenant } = await import("../db/with-tenant.js");
  const summary = { tenants: tenants.length, ok: 0, failed: 0 };
  for (const tenant of tenants) {
    // Organization Manager gate: skip tenants with the capability
    // set disabled (read failure counts as enabled by design).
    let omEnabled = true;
    try {
      const { withTenant } = await import("../db/with-tenant.js");
      omEnabled = await withTenant(tenant.id, () => isOrganizationManagerEnabled());
    } catch {}
    if (!omEnabled) continue;

    try {
      const r = await withTenant(tenant.id, () => syncTenantAnalytics());
      if (r.status === "ok" || r.status === "disabled" || r.status === "not_connected" || r.status === "org_not_configured") summary.ok++;
      else summary.failed++;
    } catch (err) {
      summary.failed++;
      platformLog("error", "analytics_sync_tenant_failed", {
        tenant: tenant.slug, error: err.message
      });
    }
  }
  return summary;
}

export async function startAnalyticsSync() {
  const { default: cron } = await import("node-cron");
  const schedule = resolvePollSchedule(getAnalyticsSyncCronRaw());
  if (!schedule.valid) {
    platformLog("warn", "analytics_sync_cron_invalid", {
      rejected: schedule.rejected, using: schedule.expression
    });
  }
  platformLog("info", "analytics_sync_started", {
    schedule: schedule.expression, source: schedule.source
  });
  cron.schedule(schedule.expression, async () => {
    const summary = await runAnalyticsSyncBatch();
    platformLog("info", "analytics_sync_batch_complete", summary);
  });
}
