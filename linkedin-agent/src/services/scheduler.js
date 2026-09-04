// ═══════════════════════════════════════════════════════════════
// Scheduler Service — Posting cadence enforcement & automation
// ═══════════════════════════════════════════════════════════════
//
// Tenant model: all per-tenant operations (database reads/writes,
// Anthropic calls, LinkedIn publishing) must run inside a
// withTenant(tenantId, ...) block. Two entry paths exist:
//
//   1. Route handlers (api.js) — the handler has already resolved
//      req.tenant and wraps the scheduler call in withTenant.
//      Functions like approvePost/rejectPost/forceCycle assume
//      they're already inside a tenant context.
//
//   2. Cron loop (startScheduler) — no request, no req.tenant.
//      The cron callback iterates every active tenant and wraps
//      each tenant's schedulerTick() in its own withTenant.
//      Tenant A's failure does not stop tenant B's tick.

import cron from "node-cron";
import {
  getRecentPosts,
  getPostsByStatus,
  getAgentState,
  setAgentState,
  createPost,
  updatePostStatus,
  logActivity,
  logActivityBestEffort,
  getPostStats,
  getPost,
  transitionPostStatus
} from "./database.js";
import { PRE_PUB_STATUSES } from "./post-status.js";
import { generatePost, qualityCheck } from "./content-generator.js";
import { publishPost, checkPublishCredentials } from "./linkedin-publisher.js";
import { composeWireCommentary, getCommentaryMax, commentaryTooLongError } from "./linkedin-post-request.js";
import { runOutputFilter } from "./output-filter.js";
import { withTenant } from "../db/with-tenant.js";
import { withTenantWorkflow } from "../db/tenant-workflow.js";
import { getPostsWindowDays, getMaxPostsPerWindowDays } from "../config/posts-window.js";
import { listActiveTenants } from "../tenant/platform-db.js";
import { dashboardCopy } from "../config/dashboard-copy.js";
import { platformLog } from "./platform-log.js";

let schedulerJob = null;

// ── Cadence Rules ────────────────────────────────────────────

const MIN_HOURS = () => parseInt(process.env.MIN_HOURS_BETWEEN_POSTS || "72", 10);
// Must be called inside withTenant. Returns a cadence decision
// for the current tenant — respects their post history and the
// global min-hours / max-posts-per-window configuration.
export async function canPostNow() {
  const recentPosts = await getRecentPosts(getPostsWindowDays());
  const stats = await getPostStats();

  // Rule 1: Max posts per configured window
  if (stats.postsInWindow >= getMaxPostsPerWindowDays()) {
    return {
      allowed: false,
      reason: `Already at ${stats.postsInWindow}/${getMaxPostsPerWindowDays()} posts in ${getPostsWindowDays()}-day window`,
      nextWindowOpens: estimateNextWindow(recentPosts)
    };
  }
  // Rule 2: Minimum hours between posts
  if (recentPosts.length > 0) {
    const lastPost = recentPosts[0];
    // posted_at comes back from pg as a Date object (TIMESTAMPTZ).
    // Keep the string-with-Z fallback for any legacy serialized rows.
    const postedAtMs = lastPost.posted_at instanceof Date
      ? lastPost.posted_at.getTime()
      : new Date(String(lastPost.posted_at).endsWith("Z") ? lastPost.posted_at : lastPost.posted_at + "Z").getTime();
    const hoursSince = (Date.now() - postedAtMs) / (1000 * 60 * 60);

    if (hoursSince < MIN_HOURS()) {
      const hoursRemaining = Math.ceil(MIN_HOURS() - hoursSince);
      return {
        allowed: false,
        reason: `Only ${Math.floor(hoursSince)}h since last post; minimum is ${MIN_HOURS()}h`,
        nextAllowedIn: `${hoursRemaining} hours`
      };
    }
  }

  return { allowed: true };
}

function estimateNextWindow(recentPosts) {
  if (recentPosts.length < getMaxPostsPerWindowDays()) return "now";
  const oldest = recentPosts[recentPosts.length - 1];
  const postedAtMs = oldest.posted_at instanceof Date
    ? oldest.posted_at.getTime()
    : new Date(String(oldest.posted_at).endsWith("Z") ? oldest.posted_at : oldest.posted_at + "Z").getTime();
  const agesOut = new Date(postedAtMs + getPostsWindowDays() * 24 * 60 * 60 * 1000);
  return agesOut.toISOString();
}

// ── Core Scheduling Loop ─────────────────────────────────────
// Must be called inside withTenant.

async function schedulerTick(topicId = null) {
  const mode = await getAgentState("mode");
  const paused = await getAgentState("paused");

  if (paused === "true") {
    await logActivity("info", "scheduler_skipped", "Agent is paused");
    return;
  }

  // Step 1: Manual-mode hold if there are posts awaiting approval
  if (mode === "manual") {
    const pending = await getPostsByStatus("pending_approval");
    if (pending.length > 0) {
      await logActivity("info", "scheduler_waiting", `${pending.length} post(s) awaiting manual approval`);
      return;
    }
  }

  // Step 2: Cadence check
  const cadence = await canPostNow();
  if (!cadence.allowed) {
    await logActivity("info", "scheduler_cadence_hold", cadence.reason);
    return;
  }

  // Step 3: Generate content (includes research phase)
  await logActivity("info", "scheduler_generating", "Generating new post content with research");

  try {
    const generated = await generatePost(topicId || null);
    const cycleId = generated.cycleId || null;

    // Step 3a: Post was blocked due to insufficient sources
    if (generated.blocked) {
      await logActivity("info", "post_blocked", {
        cycleId,
        topicId: generated.topicId,
        angle: generated.angle,
        reason: generated.reason
      });
      return;
    }

    // Step 4: Quality check
    const quality = await qualityCheck(generated.content, generated.researchSummary, cycleId);
    await logActivity("info", "quality_check", {
      cycleId,
      overall: quality.overall,
      pass: quality.pass,
      sourceGrounding: quality.scores?.source_grounding,
      factualCaution: quality.scores?.factual_caution,
      factualFlags: quality.factual_flags
    });

    if (!quality.pass || quality.overall < 6) {
      await logActivity("warn", "quality_below_threshold", {
        cycleId,
        score: quality.overall,
        feedback: quality.feedback,
        factualFlags: quality.factual_flags
      });
      const retry = await generatePost(null);
      if (!retry.blocked) {
        const retryQuality = await qualityCheck(retry.content, retry.researchSummary, retry.cycleId);
        if (retryQuality.overall > quality.overall) {
          Object.assign(generated, retry);
          await logActivity("info", "quality_retry_improved", { cycleId: retry.cycleId, newScore: retryQuality.overall });
        }
      }
    }

    // createPost stores news_context as JSONB — pass the object
    // directly, no JSON.stringify wrapping.
    const storedContext = {
      cycleId,
      angle: generated.angle,
      sourcesUsed: generated.sourcesUsed || [],
      researchSummary: generated.researchSummary || null,
      qualityScores: quality.scores,
      factualFlags: quality.factual_flags
    };

    // Step 5: Save to database
    const postId = await createPost({
      topicId: generated.topicId,
      title: generated.title,
      content: generated.content,
      hashtags: generated.hashtags,
      newsContext: storedContext,
      scheduledFor: null
    });

    // Step 6: Route based on mode
    if (mode === "auto") {
      await executePost(postId);
    } else {
      await updatePostStatus(postId, "pending_approval");
      await logActivity("info", "post_queued_for_approval", { cycleId, postId, title: generated.title });
    }

  } catch (err) {
    // 4.25111.38: a tick that died on a Model Provider failure says
    // so, in class terms, instead of burying a raw message.
    const { classifyProviderError, providerFailureLogDetails } = await import("../llm/provider-error.js");
    const pf = err.providerFailure || classifyProviderError(err);
    // 4.25111.42: classified or not, the trail carries the
    // COMPLETE error (raw message, class, wire facts, provider
    // words), never a bare message string.
    await logActivity("error", "scheduler_error", providerFailureLogDetails(err, pf));
  }
}

// ── Post Execution ───────────────────────────────────────────
// Must be called inside withTenant.

export async function executePost(postId) {
  // 2.5.57: each unattended publish runs in its OWN activation so
  // spend from different posts can never share a lifecycle (the
  // enterWith bleed class). Continuation via posts.llm_activation_id
  // lands with the artifact-links delivery.
  const { runWithActivation } = await import("../spend/activation-context.js");
  return runWithActivation({ workflow: "auto_publish" }, () => executePostInner(postId));
}

async function executePostInner(postId) {
  const post = await getPost(postId);
  if (!post) throw new Error(`Post ${postId} not found`);

  // Output security filter — last line of defense against
  // prompt injection or exfiltration via the generated content.
  const filterResult = runOutputFilter(post.content);
  if (filterResult.blocked) {
    await updatePostStatus(postId, "blocked", { errorMessage: filterResult.reason });
    await logActivity("warn", "post_blocked_by_filter", {
      postId,
      title: post.title,
      reason: filterResult.reason,
      checks: filterResult.checks
    });
    throw withPostStatus(new Error(`Post blocked by output filter: ${filterResult.reason}`), "blocked");
  }

  try {
    // Resolve an attached generated image to bytes. A stored image
    // has no public URL and must be read from the image store, not
    // fetched through the publisher's SSRF-guarded URL path. If the
    // operator attached an image on purpose but it cannot be read,
    // fail the publish loudly rather than silently posting the text
    // without it.
    //
    // 4.25111.52: the read now sits INSIDE the try so its failure
    // reaches the catch below and writes 'failed' with the reason.
    // It used to throw before the try, writing nothing: the batch
    // publisher (which swallows the throw and commits) stranded such
    // a post in 'publishing', and the interactive route, now that it
    // commits publish failures, would have left it in 'approved'.
    let imageBytes = null;
    if (post.generated_image_id) {
      try {
        const { readImageBytes } = await import("./image-store.js");
        const img = await readImageBytes(post.generated_image_id);
        imageBytes = { buffer: img.bytes, contentType: img.mime };
      } catch (err) {
        // 4.25111.58: best-effort. If the read failed because the
        // transaction is already aborted, a plain logActivity would
        // throw here and skip the 'failed' write below.
        await logActivityBestEffort("error", "post_image_read_failed", {
          postId, imageId: post.generated_image_id, error: err.message
        });
        throw new Error(
          `Attached image ${post.generated_image_id} could not be read: ${err.message}`
        );
      }
    }

    const result = await publishPost(post.content, post.hashtags, post.image_url, post.publish_target || null, imageBytes);

    // 4.25111.52: 'posted' means the publisher AFFIRMED success. Both
    // real publishers return { success: true, postId }; anything else
    // (a stand-in wired in for a dry run, a future publisher that
    // resolves with a bare object) is a failure with a reason, not a
    // published post. A row that says 'posted' with no LinkedIn URN
    // behind it is exactly the kind of row an operator cannot explain.
    if (!result || result.success !== true) {
      throw new Error(dashboardCopy("publishNoSuccessConfirmation"));
    }

    await updatePostStatus(postId, "posted", {
      linkedinId: result.postId,
      postedAt: new Date().toISOString()
    });

    await logActivity("info", "post_published", {
      postId,
      linkedinId: result.postId,
      title: post.title
    });

    return result;
  } catch (err) {
    if (err.code === "COMMENTARY_TOO_LONG") {
      // 4.25111.7: a content decision, not a fault. The post
      // returns to the approval queue intact and editable, with
      // the polite reason attached, instead of being branded
      // 'failed' (which reads as an infrastructure fault and is
      // not editable). Reached only from the unattended paths
      // (batch publisher claim state 'publishing') or any future
      // caller that skips the approve pre-flight.
      await updatePostStatus(postId, "pending_approval", { errorMessage: err.message });
      await logActivity("warn", "post_too_long_for_linkedin", { postId, ...(err.details || {}) });
      throw withPostStatus(err, "pending_approval");
    }
    await updatePostStatus(postId, "failed", { errorMessage: err.message });
    await logActivity("error", "post_publish_failed", { postId, error: err.message });
    throw withPostStatus(err, "failed");
  }
}

// 4.25111.52. Every throw that leaves executePostInner AFTER a status
// write carries the status the row now holds. The interactive approve
// route reads it to decide between "the row already says what
// happened, commit and report the reason" and "this is a fault, roll
// back". The unattended callers (batch publisher, auto-mode tick)
// ignore it; they swallow the throw and commit as before.
function withPostStatus(err, status) {
  err.postStatus = status;
  return err;
}

// ── Manual Mode Actions ──────────────────────────────────────
// Called from api.js routes which wrap them in withTenant.

// 4.25111.52: every refusal below carries a code so the route can
// answer with the reason instead of a generic 500. A refusal writes
// nothing but its audit line and leaves the post exactly as found.
export async function approvePost(postId, userSub = null) {
  const post = await getPost(postId);
  if (!post) throw refusal(`Post ${postId} not found`, "NOT_FOUND");
  if (post.status !== "pending_approval") {
    throw refusal(`Post ${postId} is not pending approval (status: ${post.status})`, "NOT_PENDING");
  }
  if (!(post.content || "").trim()) {
    throw refusal("Cannot publish an empty post.", "EMPTY_CONTENT");
  }
  // 4.25111.7: wire-length pre-flight BEFORE any state transition
  // (validate-before-mutate: a refusal here leaves the post in
  // pending_approval with content untouched; the only write is the
  // append-only audit line, so the refusal is idempotent and there
  // is never partial state to repair). Escaped length is the
  // conservative measure for both publish modes: legacy v2 sends
  // the raw, never-longer text.
  const wire = composeWireCommentary(post.content, post.hashtags);
  const wireMax = getCommentaryMax();
  if (wire.length > wireMax) {
    await logActivity("warn", "post_too_long_for_linkedin", {
      postId, wireLength: wire.length, limit: wireMax, overBy: wire.length - wireMax
    }, userSub);
    throw commentaryTooLongError(wire.length, wireMax);
  }
  // 4.25111.52: credential pre-flight, same discipline. The publish
  // path reads the token and author URN first thing and throws
  // "credentials not configured" when they are absent; asked here,
  // before the row moves, the same absence is a refusal the operator
  // can act on (connect LinkedIn, then click Publish again) with no
  // 'approved' -> 'failed' flip and no requeue in between.
  const creds = await checkPublishCredentials(post.publish_target || null);
  if (!creds.ok) {
    await logActivity("warn", "post_publish_refused", {
      postId, code: creds.code, mode: creds.mode, target: creds.target, reason: creds.reason
    }, userSub);
    const err = refusal(creds.reason, creds.code);
    err.details = { mode: creds.mode, target: creds.target };
    throw err;
  }
  await updatePostStatus(postId, "approved");
  await logActivity("info", "post_approved", { postId }, userSub);
  return executePost(postId);
}

function refusal(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export async function rejectPost(postId, reason = "", userSub = null) {
  const post = await getPost(postId);
  if (!post) throw new Error(`Post ${postId} not found`);
  if (post.status !== "pending_approval") {
    throw new Error(`Post ${postId} is not pending approval (status: ${post.status})`);
  }
  await updatePostStatus(postId, "rejected", { errorMessage: reason });
  await logActivity("info", "post_rejected", { postId, reason }, userSub);
}

// ── Status transitions (manual) ──────────────────────────────
// Called from POST /api/posts/:id/status inside withTenant. Moves a post
// between the pre-publication states (draft, pending_approval, scheduled).
// The canTransition policy (post-status.js) is the single authority and is
// enforced under row lock in transitionPostStatus. Entering 'scheduled'
// requires a future time; leaving it clears scheduled_for. Any supplied
// editor content is saved with the move (save-then-transition).
//
// 4.25111.45: the same entry point carries the recovery edge
// failed -> pending_approval. The target is still validated against
// PRE_PUB_STATUSES (pending_approval is one), the policy decides
// whether 'failed' may reach it, and the trail records the recovery
// as its own line, carrying the failure reason the row just shed, so
// "why did this post fail before it was requeued" is answerable from
// the activity log after the column is cleared.
const SCHEDULE_SPACING_MIN = () => parseInt(process.env.MIN_MINUTES_BETWEEN_SCHEDULED_POSTS || "0", 10);

export async function transitionStatus(postId, to, opts = {}, userSub = null) {
  if (!PRE_PUB_STATUSES.includes(to)) {
    const err = new Error(`Unsupported target status '${to}'`);
    err.code = "VALIDATION";
    throw err;
  }

  let scheduledForIso = null;
  if (to === "scheduled") {
    const when = new Date(opts.scheduledFor);
    if (!opts.scheduledFor || isNaN(when.getTime())) {
      const err = new Error("A valid future date/time is required to schedule");
      err.code = "VALIDATION";
      throw err;
    }
    if (when.getTime() <= Date.now()) {
      const err = new Error("Scheduled time must be in the future");
      err.code = "VALIDATION";
      throw err;
    }
    scheduledForIso = when.toISOString();
  }

  const spacing = SCHEDULE_SPACING_MIN();
  const moved = await transitionPostStatus({
    id: postId,
    to,
    scheduledFor: scheduledForIso,
    title: opts.title,
    content: opts.content,
    hashtags: opts.hashtags,
    imageUrl: opts.imageUrl,
    spacingMinutes: to === "scheduled" && Number.isInteger(spacing) && spacing > 0 ? spacing : 0
  });

  await logActivity("info", "post_status_changed", { postId, from: moved.from, to, scheduledFor: scheduledForIso }, userSub);
  if (moved.from === "failed") {
    await logActivity("info", "post_recovered_from_failed", {
      postId, to, previousError: moved.previousErrorMessage
    }, userSub);
  }
  return { status: to, scheduledForIso, from: moved.from };
}

// ── Scheduler Lifecycle ──────────────────────────────────────

// The cron callback iterates every active tenant and runs each
// tenant's schedulerTick inside its own withTenant block. Each
// iteration is independent: a failure in one tenant's tick is
// logged (best-effort) and the loop continues to the next tenant.
async function runTickForAllTenants() {
  let tenants;
  try {
    tenants = await listActiveTenants();
  } catch (err) {
    // Platform-level: no tenant context. 4.25111.58: persisted (the
    // console line stays; platformLog prints it first). This failure
    // stops generation for EVERY tenant and used to leave no row.
    platformLog("error", "scheduler_tenant_list_failed", { error: err.message });
    return;
  }

  // Payments (2.3.3): platform-level lapse sweep runs once per
  // cron fire, before the tenant loop, so a lapsed period is
  // already past_due when the entitlement checks below read it.
  try {
    const { sweepLapsedPeriods } = await import("./subscription-lifecycle.js");
    await sweepLapsedPeriods();
  } catch (err) {
    platformLog("error", "scheduler_lapse_sweep_failed", { error: err.message });
  }

  // Self-awareness (2.4.1): platform log retention, platform-level,
  // once per cron fire.
  try {
    const { prunePlatformLog } = await import("./platform-log.js");
    await prunePlatformLog();
  } catch (err) {
    platformLog("error", "platform_log_prune_failed", { error: err.message });
  }

  // 3.25111.1: registration expiry sweep. expireStaleRegistrations
  // was written for "a cleanup job" (platform-db.js) but no job ever
  // called it, so expired pending/active rows lingered forever and,
  // worse, their encrypted admin-provided API keys were never NULLed
  // as the 09.1 DDL design requires. Platform-level, once per cron
  // fire, same posture as the prune above.
  try {
    const { expireStaleRegistrations } = await import("../tenant/platform-db.js");
    const expired = await expireStaleRegistrations();
    if (expired > 0) {
      console.log(`[scheduler] registration sweep expired ${expired} stale registration(s)`);
    }
  } catch (err) {
    platformLog("error", "registration_sweep_failed", { error: err.message });
  }

  // Payments (2.3.1.1): lazy import per the module-loads-DB-free
  // discipline; automated processing halts outside good standing.
  const { isTenantProcessingAllowed } = await import("./entitlements.js");
  for (const tenant of tenants) {
    // Payments (2.3.1.1): automated processing halts for tenants
    // outside good standing. Fail-closed: a read failure skips.
    if (!(await isTenantProcessingAllowed(tenant.id))) {
      // 4.25111.58: persisted with the tenant in the column (the
      // platform log lifts tenantId), so "why did this workspace
      // stop generating" is answerable from the per-tenant query.
      platformLog("info", "scheduler_tenant_skipped_subscription", { tenantId: tenant.id, tenant: tenant.slug || null });
      continue;
    }
    try {
      // Item #1 Phase 3 (4.25111.40): the tick runs under the LEASED
      // envelope, not one long transaction. A cron cycle spends most
      // of its wall time waiting on Model Providers (and, in auto
      // mode, on LinkedIn); the pipeline's yieldDb crossings now
      // surrender the connection through every one of those waits.
      // Writes commit per lease, which changes nothing observable
      // here: this tick already caught its own errors and committed
      // its activity trail, so failure behavior is identical, minus
      // the pinned client and the run-long transaction.
      await withTenantWorkflow(tenant.id, async () => {
        await logActivity("info", "scheduler_tick", `Cron fired for tenant ${tenant.slug}`);
        await schedulerTick();
      });
    } catch (err) {
      // A tick that died OUTSIDE schedulerTick's own catch (the
      // envelope could not open, the entitlement read threw, the
      // trail write failed). 4.25111.58: persisted with the tenant.
      platformLog("error", "scheduler_tick_failed", { tenantId: tenant.id, tenant: tenant.slug || null, error: err.message });
    }
  }
}

export function startScheduler() {
  const hour = process.env.PREFERRED_POST_HOUR || "9";
  const secondHour = (parseInt(hour) + 12) % 24;

  schedulerJob = cron.schedule(`0 ${hour},${secondHour} * * *`, () => {
    runTickForAllTenants().catch(err => {
      platformLog("error", "scheduler_sweep_failed", { error: err.message });
    });
  });

  console.log(`⏰ Scheduler started — checks at ${hour}:00 and ${secondHour}:00 daily, iterating all active tenants`);
  return schedulerJob;
}

export function stopScheduler() {
  if (schedulerJob) {
    schedulerJob.stop();
    console.log("⏰ Scheduler stopped");
  }
}

// ── Force a cycle (for testing/manual trigger) ───────────────
// Called from /api/force-cycle which wraps this in withTenant.

export async function forceCycle(topicId = null, userSub = null) {
  await logActivity("info", "force_cycle", { manual: true, topicId: topicId || "auto" }, userSub);
  return schedulerTick(topicId);
}
