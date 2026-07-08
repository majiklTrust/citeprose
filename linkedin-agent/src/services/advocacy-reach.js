// =================================================================
// src/services/advocacy-reach.js, the reach calculator (FR-P2-05)
// =================================================================
// The organizational tie-in: how far can this workspace's content
// travel through its members versus its own page? Three honest
// numbers, each carrying its retrieval time (FR-CC-07):
//   org followers        real total from networkSizes, tenant token
//   total member reach   sum of KNOWN member connection sizes;
//                        members without a retrieved size count as
//                        unknown, never as zero
//   posts amplified      distinct source posts with at least one
//                        published variant
//
// The weekly refresher re-snapshots every connected member's
// connection size with THAT member's token and the org total with
// the tenant token, per-target failure isolation throughout.
// =================================================================

import { platformLog } from "./platform-log.js";

export const ORG_FOLLOWERS_STATE_KEY = "org_follower_count";
export const ORG_FOLLOWERS_AT_STATE_KEY = "org_follower_count_retrieved_at";

// -- Pure summary math -------------------------------------------
export function computeReachSummary(members = [], orgFollowerCount = null) {
  let knownSum = 0;
  let knownCount = 0;
  let unknownCount = 0;
  for (const m of members) {
    const n = m && typeof m.connections_size === "number" && Number.isFinite(m.connections_size) && m.connections_size >= 0
      ? m.connections_size : null;
    if (n === null) unknownCount++;
    else { knownSum += n; knownCount++; }
  }
  const org = typeof orgFollowerCount === "number" && Number.isFinite(orgFollowerCount) && orgFollowerCount >= 0
    ? orgFollowerCount : null;
  // Amplification is a COMPUTED ratio; it exists only when both
  // sides are known and the org side is nonzero.
  const amplification = org !== null && org > 0 && knownCount > 0
    ? Math.round((knownSum / org) * 10) / 10
    : null;
  return { totalKnownReach: knownSum, knownCount, unknownCount, orgFollowerCount: org, amplification };
}

// -- Weekly refresh (runs INSIDE withTenant) ----------------------
export async function refreshTenantReach() {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) throw new Error("reach refresh requires tenant context");
  const summary = { orgTotal: "skipped", members: 0, snapshots: 0, failures: 0 };

  // Org follower total, tenant token; failure never blocks the
  // member snapshots.
  try {
    const cs = await import("../tenant/credential-store.js");
    const { fetchOrgFollowerCount } = await import("./linkedin-analytics.js");
    const { setAgentState } = await import("./database.js");
    const token = await cs.getLinkedInAccessToken();
    const orgUrn = await cs.getLinkedInOrgUrn();
    const total = await fetchOrgFollowerCount(token, orgUrn);
    if (total !== null) {
      await setAgentState(ORG_FOLLOWERS_STATE_KEY, String(total));
      await setAgentState(ORG_FOLLOWERS_AT_STATE_KEY, new Date().toISOString());
      summary.orgTotal = "stored";
    } else {
      summary.orgTotal = "unavailable";
    }
  } catch (err) {
    summary.orgTotal = "failed";
    platformLog("warn", "advocacy_org_followers_refresh_failed", { code: err.code || "error" });
  }

  // Member connection sizes, each with the member's own token.
  const { rows: members } = await c.query(
    "SELECT auth_sub FROM advocacy_members WHERE connected = true"
  );
  summary.members = members.length;
  const mc = await import("../tenant/member-credential-store.js");
  const { fetchConnectionsSize } = await import("./linkedin-member.js");
  const { snapshotConnectionsSize } = await import("./advocacy-members.js");
  for (const m of members) {
    try {
      const token = await mc.fetchMemberCredential(m.auth_sub, "linkedin_access_token");
      const size = await fetchConnectionsSize(token);
      const stored = await snapshotConnectionsSize(m.auth_sub, size);
      if (stored.status === "stored") summary.snapshots++;
    } catch (err) {
      summary.failures++;
      platformLog("warn", "advocacy_reach_member_failed", { code: err.code || "error" });
    }
  }
  return summary;
}

// -- Read API (runs INSIDE withTenant) ----------------------------
export async function getAdvocacyReach() {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) throw new Error("reach read requires tenant context");
  const { getAgentState } = await import("./database.js");

  const { rows: members } = await c.query(
    `SELECT auth_sub, member_name, connected, connections_size, connections_size_at
       FROM advocacy_members
      ORDER BY enabled_at ASC`
  );
  const rawCount = await getAgentState(ORG_FOLLOWERS_STATE_KEY);
  const parsed = Number.parseInt(String(rawCount ?? ""), 10);
  const orgFollowerCount = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  const orgRetrievedAt = await getAgentState(ORG_FOLLOWERS_AT_STATE_KEY);

  const { rows: amp } = await c.query(
    `SELECT COUNT(DISTINCT source_post_id) FILTER (WHERE source_post_id IS NOT NULL)::int AS posts_amplified,
            COUNT(*)::int AS variants_published
       FROM advocacy_variants
      WHERE status = 'published'`
  );

  const connectedMembers = members.filter((m) => m.connected === true);
  const summary = computeReachSummary(connectedMembers, orgFollowerCount);
  return {
    orgFollowers: { count: orgFollowerCount, retrievedAt: orgRetrievedAt || null },
    members: connectedMembers.map((m) => ({
      sub: m.auth_sub,
      name: m.member_name || null,
      connectionsSize: m.connections_size ?? null,
      retrievedAt: m.connections_size_at || null
    })),
    totalKnownReach: summary.totalKnownReach,
    knownCount: summary.knownCount,
    unknownCount: summary.unknownCount,
    amplification: summary.amplification,
    postsAmplified: amp[0].posts_amplified,
    variantsPublished: amp[0].variants_published
  };
}

// -- Batch + cron -------------------------------------------------
export async function runReachRefreshBatch() {
  let tenants = [];
  try {
    const { listActiveTenants } = await import("../tenant/platform-db.js");
    tenants = await listActiveTenants();
  } catch (err) {
    platformLog("error", "advocacy_reach_tenant_list_failed", { error: err.message });
    return { tenants: 0, failures: 1 };
  }
  const { withTenant } = await import("../db/with-tenant.js");
  const total = { tenants: tenants.length, snapshots: 0, failures: 0 };
  for (const tenant of tenants) {
    try {
      const s = await withTenant(tenant.id, () => refreshTenantReach());
      total.snapshots += s.snapshots;
      total.failures += s.failures;
    } catch (err) {
      total.failures++;
      platformLog("error", "advocacy_reach_tenant_failed", { tenant: tenant.slug, error: err.message });
    }
  }
  return total;
}

export async function startReachRefresher() {
  const { default: cron } = await import("node-cron");
  const { resolvePollSchedule } = await import("../config/poll-schedule.js");
  const { getAdvocacyReachCronRaw } = await import("../config/analytics.js");
  const schedule = resolvePollSchedule(getAdvocacyReachCronRaw());
  platformLog("info", "advocacy_reach_refresher_started", {
    schedule: schedule.expression, source: schedule.source
  });
  cron.schedule(schedule.expression, async () => {
    const summary = await runReachRefreshBatch();
    platformLog("info", "advocacy_reach_batch_complete", summary);
  });
  runReachRefreshBatch()
    .then((summary) => platformLog("info", "advocacy_reach_initial_sweep", summary))
    .catch((err) => platformLog("error", "advocacy_reach_initial_sweep_failed", { error: err.message }));
}
