// =================================================================
// src/services/advocacy-token-refresh.js, member token sweep
// =================================================================
// Personal connections renew exactly like the tenant connection:
// the deps-injectable refreshTenantToken core is reused UNCHANGED,
// with member-credential accessors injected in place of the tenant
// ones. Bookmarks (linkedin_token_expires_at,
// linkedin_refresh_expires_at) live as member_credentials rows so
// every member secret shares one store and one wipe path.
//
// reauthorization_required flips the member's connected flag off,
// which the Advocacy page already renders as "reconnect needed",
// and auto mode stops cold because maybeAutoPublish requires
// connected = true.
// =================================================================

import { platformLog } from "./platform-log.js";
import { refreshTenantToken } from "./linkedin-token.js";

import { isOrganizationManagerEnabled } from "./organization-manager.js";
// Member-flavored deps for the shared refresh core. getState reads
// degrade to null (unknown bookmark, the core's establish-
// bookkeeping path); log entries carry the member sub.
export function buildMemberRefreshDeps(memberSub, helpers) {
  const h = helpers; // { store, fetch, has, logActivity }
  return {
    getRefreshToken: () => h.fetch(memberSub, "linkedin_refresh_token"),
    hasRefreshToken: () => h.has(memberSub, "linkedin_refresh_token"),
    store: (key, value) => h.store(memberSub, key, value),
    getState: async (key) => {
      try { return await h.fetch(memberSub, key); } catch { return null; }
    },
    setState: (key, value) => h.store(memberSub, key, String(value)),
    log: (level, action, details) => h.logActivity(level, action, { ...details, memberScope: true }, memberSub),
    invalidateCache: () => {},
    tenantId: null
  };
}

// Runs INSIDE withTenant: refresh every connected member of the
// current tenant, flipping connected off on reauthorization.
export async function refreshTenantMembers() {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) throw new Error("member refresh requires tenant context");
  const mc = await import("../tenant/member-credential-store.js");
  const { logActivity } = await import("./database.js");
  const helpers = {
    store: mc.storeMemberCredential,
    fetch: mc.fetchMemberCredential,
    has: mc.hasMemberCredential,
    logActivity
  };

  const { rows: members } = await c.query(
    "SELECT auth_sub FROM advocacy_members WHERE connected = true"
  );
  const summary = { members: members.length, refreshed: 0, failed: 0, skipped: 0, reauthRequired: 0 };
  for (const m of members) {
    try {
      const result = await refreshTenantToken(buildMemberRefreshDeps(m.auth_sub, helpers));
      if (result.status === "refreshed") summary.refreshed++;
      else if (result.status === "reauthorization_required") {
        summary.reauthRequired++;
        await c.query(
          `UPDATE advocacy_members
              SET connected = false, disconnected_at = now(), mode = 'manual', updated_at = now()
            WHERE auth_sub = $1`,
          [m.auth_sub]
        );
        await logActivity("warn", "advocacy_member_reauthorization_required", {}, m.auth_sub);
      }
      else if (result.status === "failed") summary.failed++;
      else summary.skipped++;
    } catch (err) {
      summary.failed++;
      platformLog("error", "advocacy_member_refresh_failed", { error: err.message });
    }
  }
  return summary;
}

// Batch over active tenants, mirroring runTokenRefreshBatch.
export async function runMemberTokenRefreshBatch() {
  let tenants = [];
  try {
    const { listActiveTenants } = await import("../tenant/platform-db.js");
    tenants = await listActiveTenants();
  } catch (err) {
    platformLog("error", "advocacy_refresh_tenant_list_failed", { error: err.message });
    return { refreshed: 0, failed: 0, skipped: 0, reauthRequired: 0 };
  }
  const { withTenant } = await import("../db/with-tenant.js");
  const total = { refreshed: 0, failed: 0, skipped: 0, reauthRequired: 0 };
  // Payments (2.3.1.1): lazy import per the module-loads-DB-free
  // discipline; automated processing halts outside good standing.
  const { isTenantProcessingAllowed } = await import("./entitlements.js");
  for (const tenant of tenants) {
    // Payments (2.3.1.1): automated processing halts for tenants
    // outside good standing. Fail-closed: a read failure skips.
    if (!(await isTenantProcessingAllowed(tenant.id))) {
      console.log(`[advocacy_token_refresh] tenant ${tenant.slug || tenant.id} skipped: subscription not in good standing`);
      continue;
    }
    // Organization Manager gate: skip tenants with the capability
    // set disabled (read failure counts as enabled by design).
    let omEnabled = true;
    try {
      const { withTenant } = await import("../db/with-tenant.js");
      omEnabled = await withTenant(tenant.id, () => isOrganizationManagerEnabled());
    } catch {}
    if (!omEnabled) continue;

    try {
      const s = await withTenant(tenant.id, () => refreshTenantMembers());
      total.refreshed += s.refreshed;
      total.failed += s.failed;
      total.skipped += s.skipped;
      total.reauthRequired += s.reauthRequired;
    } catch (err) {
      total.failed++;
      platformLog("error", "advocacy_refresh_tenant_failed", {
        tenant: tenant.slug, error: err.message
      });
    }
  }
  return total;
}

// Same cron source as the tenant refresher: personal and tenant
// tokens age on the same clock, one schedule config governs both.
export async function startMemberTokenRefresher() {
  const { default: cron } = await import("node-cron");
  const { resolvePollSchedule } = await import("../config/poll-schedule.js");
  const { getTokenRefreshCronRaw } = await import("../config/analytics.js");
  const schedule = resolvePollSchedule(getTokenRefreshCronRaw());
  platformLog("info", "advocacy_token_refresher_started", {
    schedule: schedule.expression, source: schedule.source
  });
  cron.schedule(schedule.expression, async () => {
    const summary = await runMemberTokenRefreshBatch();
    platformLog("info", "advocacy_token_refresh_batch_complete", summary);
  });
  runMemberTokenRefreshBatch()
    .then((summary) => platformLog("info", "advocacy_token_refresh_initial_sweep", summary))
    .catch((err) => platformLog("error", "advocacy_token_refresh_initial_sweep_failed", { error: err.message }));
}
