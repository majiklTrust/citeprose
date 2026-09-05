// ═══════════════════════════════════════════════════════════════
// src/automation/publishing-loop.js: the automated publish
// ═══════════════════════════════════════════════════════════════
// 4.25111.60. Under auto-post the agent publishes the oldest post in
// the approval queue by itself, one per sweep, once that post has
// waited its review window (Decision 1, confirmed; the window's
// business case is to give users time to intersect the auto-post
// process). This module is the second claim in the batch publisher's
// sweep, the sibling of the scheduled-post claim, with the same
// exactly-once discipline:
//
//   1. Decide, read-only, inside one tenant scope: the automation
//      state, the settings, the queue (oldest first), the cadence
//      floor, and the credential pre-flight for each destination
//      present in the queue. evaluatePublishing() (pure) says
//      publish this id, or hold with a reason.
//   2. Claim, in its OWN committed transaction: one UPDATE that
//      moves exactly that row from pending_approval to publishing
//      under FOR UPDATE SKIP LOCKED with the status re-checked
//      under the lock. A human approve that commits first wins;
//      this claim then finds no row and reports the race.
//   3. Publish, in its own tenant scope, through executePost, the
//      same path the human approve and the scheduled claim use,
//      swallowing the throw so the terminal status commits (the
//      batch publisher's discipline, 4.25111.58).
//
// This is a NEW edge, pending_approval to publishing, performed
// only here (post-status.js documents it). The trail carries
// post_auto_approved with the mode as the actor and no human
// subject, then the publish path's own post_published or
// post_publish_failed, exactly as for a human approve.
//
// Observability. Holds are on the tenant's trail (auto_publish_held)
// only when the reason changes, so a tenant that is holding for two
// days is not told so every fifteen minutes; a skipped row
// (too long, empty) is reported once per process per post
// (auto_publish_skipped, warn). Every line carries reasonCode and
// the facts behind it. Platform log rows carry the tenant. Outside
// auto-post the sweep says nothing at all.
//
// Must NOT be called inside an existing withTenant block; it opens
// its own, like runBatchForTenant.
// ═══════════════════════════════════════════════════════════════

import { withTenant } from "../db/with-tenant.js";
import { logActivityBestEffort } from "../services/database.js";
import { platformLog } from "../services/platform-log.js";
import { readMode, automationGate } from "./automation-mode.js";
import { readAutomationSettings } from "./settings.js";
import { evaluatePublishing } from "./rules-engine.js";
import { canPostNow, executePost } from "../services/scheduler.js";

// Per-process memory for the change-only trail lines.
const lastHold = new Map();
const reportedSkips = new Set();

function holdChanged(tenantId, decision) {
  const marker = `${decision.reasonCode}|${decision.blockedPostId ?? ""}|${decision.nextDueAt ?? ""}`;
  if (lastHold.get(tenantId) === marker) return false;
  lastHold.set(tenantId, marker);
  return true;
}

// ── Step 1: decide ───────────────────────────────────────────
async function decide(tenant) {
  return withTenant(tenant.id, async (client) => {
    const state = await readMode();
    const gate = automationGate({ loop: "publishing", mode: state.mode, paused: state.paused });
    if (!gate.allowed) return { decision: { action: "hold", reasonCode: gate.reasonCode, reason: null, skipped: [] }, quiet: true };

    const settings = await readAutomationSettings();
    const { rows } = await client.query(
      `SELECT id, queued_at, created_at, content, hashtags, publish_target
         FROM posts
        WHERE tenant_id = current_tenant_id() AND status = 'pending_approval'
        ORDER BY queued_at ASC NULLS LAST, created_at ASC, id ASC`
    );
    const { composeWireCommentary, getCommentaryMax } = await import("../services/linkedin-post-request.js");
    const { checkPublishCredentials } = await import("../services/linkedin-publisher.js");
    const credentialsByTarget = new Map();
    const queue = [];
    for (const r of rows) {
      const target = r.publish_target || null;
      if (!credentialsByTarget.has(target)) credentialsByTarget.set(target, await checkPublishCredentials(target));
      const hashtags = Array.isArray(r.hashtags) ? r.hashtags : [];
      queue.push({
        id: r.id,
        queuedAt: r.queued_at || r.created_at,
        content: r.content,
        wireLength: composeWireCommentary(r.content || "", hashtags).length,
        publishTarget: target,
        credentials: credentialsByTarget.get(target)
      });
    }
    const cadence = await canPostNow();
    const decision = evaluatePublishing({
      now: new Date(), mode: state.mode, paused: state.paused,
      reviewWindowHours: settings.reviewWindowHours, queue, cadence, wireMax: getCommentaryMax()
    });
    return { decision, quiet: false, settings, queueSize: queue.length, mode: state.mode };
  });
}

// ── Step 2: claim ────────────────────────────────────────────
async function claim(tenant, postId) {
  return withTenant(tenant.id, async (client) => {
    const { rows } = await client.query(
      `UPDATE posts
          SET status = 'publishing'
        WHERE id = (
          SELECT id FROM posts
           WHERE tenant_id = current_tenant_id()
             AND id = $1
             AND status = 'pending_approval'
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, title`,
      [postId]
    );
    return rows[0] || null;
  });
}

// ── The sweep for one tenant ─────────────────────────────────
// Returns the decision so a caller (the batch publisher, a suite)
// can see what happened and why.
export async function runAutoPublishForTenant(tenant) {
  let outcome;
  try {
    outcome = await decide(tenant);
  } catch (err) {
    platformLog("error", "auto_publish_decide_failed", { tenantId: tenant.id, tenant: tenant.slug || null, error: err.message });
    return { action: "hold", reasonCode: "sweep_failed", reason: err.message, skipped: [] };
  }
  const { decision, quiet } = outcome;

  // Skipped rows are named once per process each, whatever the
  // sweep decided.
  for (const s of decision.skipped || []) {
    const marker = `${tenant.id}|${s.postId}|${s.reasonCode}`;
    if (reportedSkips.has(marker)) continue;
    reportedSkips.add(marker);
    await withTenant(tenant.id, () => logActivityBestEffort("warn", "auto_publish_skipped", { postId: s.postId, reasonCode: s.reasonCode, wireLength: s.wireLength, limit: s.limit }));
    platformLog("warn", "auto_publish_skipped", { tenantId: tenant.id, tenant: tenant.slug || null, postId: s.postId, reasonCode: s.reasonCode });
  }

  if (decision.action !== "publish") {
    if (!quiet && holdChanged(tenant.id, decision)) {
      const details = { reasonCode: decision.reasonCode, reason: decision.reason, nextDueAt: decision.nextDueAt || null, postId: decision.blockedPostId ?? null, queueSize: outcome.queueSize ?? null, reviewWindowHours: outcome.settings ? outcome.settings.reviewWindowHours : null };
      await withTenant(tenant.id, () => logActivityBestEffort("info", "auto_publish_held", details));
      platformLog("info", "auto_publish_held", { tenantId: tenant.id, tenant: tenant.slug || null, ...details });
    }
    return decision;
  }
  lastHold.delete(tenant.id);

  let claimed;
  try {
    claimed = await claim(tenant, decision.postId);
  } catch (err) {
    platformLog("error", "auto_publish_claim_failed", { tenantId: tenant.id, tenant: tenant.slug || null, postId: decision.postId, error: err.message });
    return { ...decision, action: "hold", reasonCode: "claim_failed", reason: err.message };
  }
  if (!claimed) {
    // A human approve, reject, edit or schedule committed between
    // the decision and the claim. Nothing to do; say so.
    platformLog("info", "auto_publish_claim_raced", { tenantId: tenant.id, tenant: tenant.slug || null, postId: decision.postId });
    return { ...decision, action: "hold", reasonCode: "claim_raced", reason: "the post changed before the claim" };
  }
  platformLog("info", "auto_publish_claimed", { tenantId: tenant.id, tenant: tenant.slug || null, postId: claimed.id, queuedForHours: decision.queuedForHours });

  // Step 3: publish, the batch publisher's way.
  try {
    await withTenant(tenant.id, async () => {
      await logActivityBestEffort("info", "post_auto_approved", {
        postId: claimed.id, title: claimed.title, actor: outcome.mode,
        reviewWindowHours: outcome.settings.reviewWindowHours, queuedForHours: decision.queuedForHours
      });
      try {
        await executePost(claimed.id);
      } catch (err) {
        // executePost already wrote 'failed'/'blocked' (or bounced
        // the post back to pending_approval when too long) in THIS
        // transaction. Swallow so that status COMMITS.
        await logActivityBestEffort("error", "auto_publish_failed", { postId: claimed.id, error: err.message, status: err.postStatus || null });
        platformLog("error", "auto_publish_failed", { tenantId: tenant.id, tenant: tenant.slug || null, postId: claimed.id, error: err.message, status: err.postStatus || null });
      }
    });
  } catch (err) {
    // Transaction-level failure (could not open or commit). The post
    // is left in 'publishing' for reconciliation, as the scheduled
    // claim leaves its rows.
    platformLog("error", "auto_publish_txn_failed", { tenantId: tenant.id, tenant: tenant.slug || null, postId: claimed.id, error: err.message });
  }
  return decision;
}
