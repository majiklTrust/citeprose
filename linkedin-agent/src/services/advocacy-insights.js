// =================================================================
// src/services/advocacy-insights.js, performance intelligence
// =================================================================
// Step 5, re-scoped within the granted OAuth set (D6 outcome:
// r_member_postAnalytics unavailable at the current tier). Every
// number here is one of exactly three honest kinds:
//   stored fact      variant lifecycle rows, timestamps, the
//                    reach_at_publish stamp
//
//   computed         funnel rates, latencies, uptake, activated
//                    reach sums (badged computed in the UI)
//   member-reported  self-entered post performance, provenance
//                    labeled everywhere it renders, NEVER merged
//                    with API-retrieved metrics
// Unknown is unknown: NULL reach never sums as zero; empty cohorts
// yield counts of zero and rates of null, not fabricated 0%.
//
// Pure computations are exported for DB-free testing; DB access is
// lazy and runs INSIDE withTenant.
// =================================================================

// -- Pure: funnel over variant rows ------------------------------
// rows: [{ member_sub, status, member_edited, created_at,
//          resolved_at, quality }]
export function computeFunnel(rows = []) {
  const perMember = new Map();
  const gateFailures = new Map();
  const totals = { generated: 0, pending: 0, approved: 0, rejected: 0, published: 0, voided: 0, failed: 0 };

  for (const r of rows) {
    if (!r || typeof r.member_sub !== "string") continue;
    totals.generated++;
    const m = perMember.get(r.member_sub) || {
      sub: r.member_sub, generated: 0, pending: 0, approved: 0, rejected: 0,
      published: 0, voided: 0, failed: 0, edited: 0, latencySumMs: 0, latencyCount: 0
    };
    m.generated++;
    const bucket = { pending_approval: "pending", approved: "approved", rejected: "rejected",
      published: "published", voided: "voided", failed: "failed" }[r.status];
    if (bucket) { m[bucket]++; totals[bucket]++; }
    if (r.member_edited === true && (r.status === "approved" || r.status === "published")) m.edited++;
    if (r.status === "failed") {
      const gate = r.quality && typeof r.quality === "object" && typeof r.quality.failedGate === "string"
        ? r.quality.failedGate : "unknown";
      gateFailures.set(gate, (gateFailures.get(gate) || 0) + 1);
    }
    const created = Date.parse(r.created_at);
    const resolved = Date.parse(r.resolved_at);
    if (Number.isFinite(created) && Number.isFinite(resolved) && resolved >= created
        && (r.status === "approved" || r.status === "rejected" || r.status === "published")) {
      m.latencySumMs += resolved - created;
      m.latencyCount++;
    }
    perMember.set(r.member_sub, m);
  }

  const members = Array.from(perMember.values()).map((m) => {
    const decided = m.published + m.approved + m.rejected;
    return {
      sub: m.sub,
      generated: m.generated,
      published: m.published,
      approved: m.approved,
      rejected: m.rejected,
      pending: m.pending,
      failed: m.failed,
      voided: m.voided,
      // Rates are null when the denominator is zero: no cohort, no
      // percentage, never a fabricated 0%.
      publishRate: m.generated > 0 ? Math.round((m.published / m.generated) * 100) : null,
      editRate: (m.approved + m.published) > 0 ? Math.round((m.edited / (m.approved + m.published)) * 100) : null,
      avgDecisionHours: m.latencyCount > 0 ? Math.round((m.latencySumMs / m.latencyCount) / 3600000 * 10) / 10 : null,
      decided
    };
  });

  return {
    totals,
    publishRate: totals.generated > 0 ? Math.round((totals.published / totals.generated) * 100) : null,
    members,
    gateFailures: Array.from(gateFailures.entries()).map(([gate, n]) => ({ gate, n }))
      .sort((a, b) => b.n - a.n)
  };
}

// -- Pure: per-source-post uptake --------------------------------
export function computeUptake(rows = []) {
  const byPost = new Map();
  for (const r of rows) {
    if (!r || r.source_post_id == null) continue;
    const p = byPost.get(r.source_post_id) || { sourcePostId: r.source_post_id, generated: 0, published: 0 };
    p.generated++;
    if (r.status === "published") p.published++;
    byPost.set(r.source_post_id, p);
  }
  return Array.from(byPost.values())
    .map((p) => ({ ...p, uptake: p.generated > 0 ? Math.round((p.published / p.generated) * 100) : null }))
    .sort((a, b) => b.published - a.published || b.generated - a.generated);
}

// -- Pure: activated reach over published rows -------------------
export function computeActivatedReach(rows = []) {
  let known = 0;
  let knownCount = 0;
  let unknownCount = 0;
  for (const r of rows) {
    if (!r || r.status !== "published") continue;
    const n = typeof r.reach_at_publish === "number" && Number.isFinite(r.reach_at_publish) && r.reach_at_publish >= 0
      ? r.reach_at_publish : null;
    if (n === null) unknownCount++;
    else { known += n; knownCount++; }
  }
  return { activatedReach: known, publishedWithReach: knownCount, publishedUnknownReach: unknownCount };
}

// -- Pure: member report validation ------------------------------
const REPORT_FIELDS = Object.freeze(["impressions", "reactions", "comments"]);
export function validateMemberReport(input = {}) {
  const out = {};
  for (const f of REPORT_FIELDS) {
    const v = input[f];
    if (v === null || v === undefined || v === "") { out[f] = null; continue; }
    // Explicit type branches (adversarial tier): numbers pass to
    // the integer check; strings must be PURELY numeric because
    // parseInt('12.5') and parseInt('1204; DROP ...') both yield
    // plausible integers; every other type (objects with valueOf,
    // booleans, arrays) is refused outright, never coerced.
    let n;
    if (typeof v === "number") {
      n = v;
    } else if (typeof v === "string") {
      const t = v.trim();
      if (!/^\d+$/.test(t)) {
        return { valid: false, reason: `${f} must be a whole number between 0 and 1,000,000,000` };
      }
      n = Number.parseInt(t, 10);
    } else {
      return { valid: false, reason: `${f} must be a whole number between 0 and 1,000,000,000` };
    }
    if (!Number.isInteger(n) || n < 0 || n > 1000000000) {
      return { valid: false, reason: `${f} must be a whole number between 0 and 1,000,000,000` };
    }
    out[f] = n;
  }
  if (out.impressions === null && out.reactions === null && out.comments === null) {
    return { valid: false, reason: "report at least one value" };
  }
  return { valid: true, fields: out };
}

// -- DB orchestration (runs INSIDE withTenant) --------------------
async function client() {
  const { currentClient } = await import("../db/with-tenant.js");
  const c = currentClient();
  if (!c) throw new Error("advocacy insights requires tenant context");
  return c;
}

export async function getAdvocacyInsights() {
  const c = await client();
  const { rows } = await c.query(
    `SELECT member_sub, source_post_id, status, member_edited, quality,
            reach_at_publish, reported_impressions, reported_reactions,
            reported_comments, reported_at, created_at, resolved_at
       FROM advocacy_variants`
  );
  const funnel = computeFunnel(rows);
  // Burden reduction (Step 0): the owner reads names, not auth
  // subs. Enrich the per-member lines from the members table.
  const { rows: nameRows } = await c.query(
    "SELECT auth_sub, member_name FROM advocacy_members"
  );
  const nameBySub = new Map(nameRows.map((r) => [r.auth_sub, r.member_name]));
  for (const m of funnel.members) {
    m.name = nameBySub.get(m.sub) || null;
  }
  const uptake = computeUptake(rows);
  const reach = computeActivatedReach(rows);

  // Member-reported aggregate: provenance-labeled, never merged
  // with API metrics. Reported counts sum only what was reported.
  let reported = { variants: 0, impressions: 0, reactions: 0, comments: 0, latestAt: null };
  for (const r of rows) {
    if (r.reported_at) {
      reported.variants++;
      reported.impressions += r.reported_impressions || 0;
      reported.reactions += r.reported_reactions || 0;
      reported.comments += r.reported_comments || 0;
      if (!reported.latestAt || r.reported_at > reported.latestAt) reported.latestAt = r.reported_at;
    }
  }

  return { funnel, uptake, ...reach, reported };
}

// Member self-report: ownership is the session sub, only published
// variants accept reports, replace-on-save (mirrors voice notes).
export async function saveMemberReport(authSub, variantId, input) {
  const verdict = validateMemberReport(input);
  if (!verdict.valid) return { status: "rejected", reason: verdict.reason };
  const c = await client();
  const r = await c.query(
    `UPDATE advocacy_variants
        SET reported_impressions = $3,
            reported_reactions = $4,
            reported_comments = $5,
            reported_at = now()
      WHERE id = $1 AND member_sub = $2 AND status = 'published'
      RETURNING id`,
    [variantId, authSub, verdict.fields.impressions, verdict.fields.reactions, verdict.fields.comments]
  );
  if (r.rowCount === 0) return { status: "not_reportable" };
  return { status: "saved", variantId };
}
