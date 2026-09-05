// ═══════════════════════════════════════════════════════════════
// Batch Publisher — fires scheduled posts at their set time
// ═══════════════════════════════════════════════════════════════
//
// This is a SEPARATE concern from scheduler.js. scheduler.js runs a
// twice-daily *generation* cycle (research → write → route). This
// runs frequently (BATCH_PUBLISH_INTERVAL_MINUTES, default 15) and
// only *publishes* posts a user already scheduled — it never
// generates content.
//
// Correctness model (exactly-once), shaped by the one-transaction-
// per-withTenant DB layer:
//
//   1. CLAIM (one committed transaction per tenant): atomically take a
//      batch of due posts with FOR UPDATE SKIP LOCKED and flip them
//      'scheduled' -> 'publishing'. SKIP LOCKED means concurrent
//      workers (or a future second app instance) never grab the same
//      row, so no double-publish. Committing the claim before any
//      LinkedIn call means a crash leaves the post in 'publishing'
//      (visible, reconcilable) rather than 'scheduled' (re-claimed and
//      re-posted).
//
//   2. PUBLISH (one transaction PER post): each claimed post is sent via
//      the existing executePost in its OWN withTenant block. Per-post
//      isolation is essential — a single failure must not roll back the
//      'posted' status of the others in the batch. executePost writes
//      'posted'/'failed'/'blocked' itself; we swallow its throw inside
//      the block so that status COMMITS (re-throwing would ROLLBACK the
//      status write — see scheduler.schedulerTick for the same pattern).
//
// Posts stranded in 'publishing' (process killed between the LinkedIn
// 200 and the status write) are intentionally NOT auto-recovered here —
// that requires a human/decision (did it actually post?). A stuck-post
// reconciliation pass is a documented follow-on, not part of this path.
// ═══════════════════════════════════════════════════════════════

import cron from "node-cron";
import { withTenant } from "../db/with-tenant.js";
import { logActivityBestEffort } from "./database.js";
import { executePost } from "./scheduler.js";
import { listActiveTenants } from "../tenant/platform-db.js";
import { platformLog } from "./platform-log.js";
import { runAutoPublishForTenant } from "../automation/publishing-loop.js";

let publisherJob = null;

// ── Configuration ────────────────────────────────────────────

// Interval is expressed in MINUTES and rendered as a "*/N * * * *"
// cron. Clamped to 1..59 (a single minute field). Invalid/unset falls
// back to 15 LOUDLY rather than silently picking an odd cadence.
function resolveIntervalMinutes() {
  const raw = process.env.BATCH_PUBLISH_INTERVAL_MINUTES;
  const n = parseInt(raw ?? "", 10);
  if (!Number.isInteger(n) || n < 1 || n > 59) {
    if (raw !== undefined && String(raw).trim() !== "") {
      platformLog("warn", "batch_publish_interval_invalid", { rejected: String(raw).slice(0, 20), using: 15 });
    }
    return 15;
  }
  return n;
}

// Upper bound on posts published per tenant per run. Bounds the work
// (and the LinkedIn call rate) when a backlog accumulates, e.g. after
// downtime. Defaults to 25.
function resolveMaxPerRun() {
  const n = parseInt(process.env.BATCH_PUBLISH_MAX_PER_RUN ?? "", 10);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 25;
}

// ── Claim + publish for one tenant ───────────────────────────
// Must NOT be called inside an existing withTenant block — it opens
// its own.

async function runBatchForTenant(tenant) {
  const maxPerRun = resolveMaxPerRun();

  // Step 1 — CLAIM (own transaction). Atomic select-and-mark.
  let claimed;
  try {
    claimed = await withTenant(tenant.id, async (client) => {
      const { rows } = await client.query(
        `UPDATE posts
            SET status = 'publishing'
          WHERE id IN (
            SELECT id FROM posts
             WHERE tenant_id = current_tenant_id()
               AND status = 'scheduled'
               AND scheduled_for <= now()
             ORDER BY scheduled_for ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $1
          )
          RETURNING id, title`,
        [maxPerRun]
      );
      return rows;
    });
  } catch (err) {
    platformLog("error", "batch_publish_claim_failed", { tenantId: tenant.id, tenant: tenant.slug, error: err.message });
    return;
  }

  if (claimed.length === 0) return;
  platformLog("info", "batch_publish_claimed", { tenantId: tenant.id, tenant: tenant.slug, count: claimed.length });

  // Step 2 — PUBLISH each claimed post in its own transaction.
  for (const post of claimed) {
    try {
      await withTenant(tenant.id, async () => {
        try {
          await executePost(post.id);
        } catch (err) {
          // executePost already wrote 'failed'/'blocked' in THIS
          // transaction. Swallow so that status COMMITS — re-throwing
          // would ROLLBACK the status write and strand the post.
          // 4.25111.58: best-effort. When the failure was the
          // database's (the transaction is aborted, 25P02), a plain
          // logActivity threw out of this swallow and stranded the
          // post in 'publishing'; the record now lands in the
          // platform log instead and the swallow keeps its promise.
          await logActivityBestEffort("error", "scheduled_publish_failed", { postId: post.id, error: err.message });
        }
      });
    } catch (err) {
      // Transaction-level failure (couldn't even open/commit). The post
      // is left in 'publishing' for reconciliation.
      platformLog("error", "batch_publish_txn_failed", { tenantId: tenant.id, tenant: tenant.slug, postId: post.id, error: err.message });
    }
  }
}

// ── All-tenants sweep ────────────────────────────────────────

async function runBatchForAllTenants() {
  let tenants;
  try {
    tenants = await listActiveTenants();
  } catch (err) {
    // 4.25111.58: persisted. Scheduled posts stop publishing for
    // every tenant when this fails, and it used to leave no row.
    platformLog("error", "batch_publish_tenant_list_failed", { error: err.message });
    return;
  }
  // Payments (2.3.1.1): lazy import per the module-loads-DB-free
  // discipline; automated processing halts outside good standing.
  const { isTenantProcessingAllowed } = await import("./entitlements.js");
  for (const tenant of tenants) {
    // Payments (2.3.1.1): automated processing halts for tenants
    // outside good standing. Fail-closed: a read failure skips.
    if (!(await isTenantProcessingAllowed(tenant.id))) {
      console.log(`[batch_publisher] tenant ${tenant.slug || tenant.id} skipped: subscription not in good standing`);
      continue;
    }
    await runBatchForTenant(tenant);
    // 4.25111.60: the second claim. Under auto-post the tenant's
    // oldest queued post past its review window is approved and
    // published by the mode, one per sweep, through the same
    // exactly-once discipline as the scheduled claim above. Outside
    // auto-post it decides "hold" silently and costs one read. Its
    // own failures are its own (it never throws); a tenant's
    // automated publish cannot stop the next tenant's sweep.
    try {
      await runAutoPublishForTenant(tenant);
    } catch (err) {
      platformLog("error", "auto_publish_sweep_failed", { tenantId: tenant.id, tenant: tenant.slug || null, error: err.message });
    }
  }
}

// ── Lifecycle ────────────────────────────────────────────────

export function startBatchPublisher() {
  const minutes = resolveIntervalMinutes();
  const expression = `*/${minutes} * * * *`;

  // Initial sweep at startup so a post whose time passed during a
  // restart isn't delayed a whole interval. Non-blocking.
  runBatchForAllTenants().catch(err => {
    platformLog("error", "batch_publish_sweep_failed", { phase: "startup", error: err.message });
  });

  publisherJob = cron.schedule(expression, () => {
    runBatchForAllTenants().catch(err => {
      platformLog("error", "batch_publish_sweep_failed", { error: err.message });
    });
  });

  console.log(`🗓️  Batch publisher started — sweeping due scheduled posts every ${minutes} min ("${expression}"), all active tenants`);
  return publisherJob;
}

export function stopBatchPublisher() {
  if (publisherJob) {
    publisherJob.stop();
    console.log("🗓️  Batch publisher stopped");
  }
}
