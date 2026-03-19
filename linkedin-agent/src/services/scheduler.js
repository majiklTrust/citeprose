// ═══════════════════════════════════════════════════════════════
// Scheduler Service — Posting cadence enforcement & automation
// ═══════════════════════════════════════════════════════════════

import cron from "node-cron";
import {
  getRecentPosts,
  getPostsByStatus,
  getAgentState,
  setAgentState,
  createPost,
  updatePostStatus,
  logActivity,
  getPostStats,
  getPost
} from "./database.js";
import { generatePost, qualityCheck } from "./content-generator.js";
import { publishPost } from "./linkedin-api.js";

let schedulerJob = null;

// ── Cadence Rules ────────────────────────────────────────────

const MIN_HOURS = () => parseInt(process.env.MIN_HOURS_BETWEEN_POSTS || "72", 10);
const MAX_PER_10_DAYS = () => parseInt(process.env.MAX_POSTS_PER_10_DAYS || "4", 10);

export function canPostNow() {
  const recentPosts = getRecentPosts(10);
  const stats = getPostStats();

  // Rule 1: Max posts per 10-day window
  if (stats.postsLast10Days >= MAX_PER_10_DAYS()) {
    return {
      allowed: false,
      reason: `Already at ${stats.postsLast10Days}/${MAX_PER_10_DAYS()} posts in 10-day window`,
      nextWindowOpens: estimateNextWindow(recentPosts)
    };
  }

  // Rule 2: Minimum hours between posts
  if (recentPosts.length > 0) {
    const lastPost = recentPosts[0];
    const hoursSince = (Date.now() - new Date(lastPost.posted_at + "Z").getTime()) / (1000 * 60 * 60);

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
  if (recentPosts.length < MAX_PER_10_DAYS()) return "now";
  // Find when the oldest post in the window will "age out"
  const oldest = recentPosts[recentPosts.length - 1];
  const agesOut = new Date(new Date(oldest.posted_at + "Z").getTime() + 10 * 24 * 60 * 60 * 1000);
  return agesOut.toISOString();
}

// ── Core Scheduling Loop ─────────────────────────────────────

async function schedulerTick(topicId = null) {
  const mode = getAgentState("mode");
  const paused = getAgentState("paused");

  if (paused === "true") {
    logActivity("info", "scheduler_skipped", "Agent is paused");
    return;
  }

  // Step 1: Check if there are posts pending approval (manual mode)
  if (mode === "manual") {
    const pending = getPostsByStatus("pending_approval");
    if (pending.length > 0) {
      logActivity("info", "scheduler_waiting", `${pending.length} post(s) awaiting manual approval`);
      return;
    }
  }

  // Step 2: Check cadence rules
  const cadence = canPostNow();
  if (!cadence.allowed) {
    logActivity("info", "scheduler_cadence_hold", cadence.reason);
    return;
  }

  // Step 3: Generate content (includes research phase)
  logActivity("info", "scheduler_generating", "Generating new post content with research");

  try {
    const generated = await generatePost(topicId || null);
    const cycleId = generated.cycleId || null;

    // Step 3a: Check if post was blocked due to insufficient sources
    if (generated.blocked) {
      logActivity("info", "post_blocked", {
        cycleId,
        topicId: generated.topicId,
        angle: generated.angle,
        reason: generated.reason
      });
      return;  // Skip this cycle — scheduler will try again next tick
    }

    // Step 4: Quality check (includes source grounding verification)
    const quality = await qualityCheck(generated.content, generated.researchSummary, cycleId);
    logActivity("info", "quality_check", {
      cycleId,
      overall: quality.overall,
      pass: quality.pass,
      sourceGrounding: quality.scores?.source_grounding,
      factualCaution: quality.scores?.factual_caution,
      factualFlags: quality.factual_flags
    });

    // If quality is below threshold, regenerate once
    if (!quality.pass || quality.overall < 6) {
      logActivity("warn", "quality_below_threshold", {
        cycleId,
        score: quality.overall,
        feedback: quality.feedback,
        factualFlags: quality.factual_flags
      });
      const retry = await generatePost(null);
      // Retry may also be blocked — check before quality checking
      if (!retry.blocked) {
        const retryQuality = await qualityCheck(retry.content, retry.researchSummary, retry.cycleId);
        if (retryQuality.overall > quality.overall) {
          Object.assign(generated, retry);
          logActivity("info", "quality_retry_improved", { cycleId: retry.cycleId, newScore: retryQuality.overall });
        }
      }
    }

    // Build research context for storage
    const storedContext = JSON.stringify({
      cycleId,
      angle: generated.angle,
      sourcesUsed: generated.sourcesUsed || [],
      researchSummary: generated.researchSummary || null,
      qualityScores: quality.scores,
      factualFlags: quality.factual_flags
    });

    // Step 5: Save to database
    const postId = createPost({
      topicId: generated.topicId,
      title: generated.title,
      content: generated.content,
      hashtags: generated.hashtags,
      newsContext: storedContext
    });

    // Step 6: Route based on mode
    if (mode === "auto") {
      await executePost(postId);
    } else {
      updatePostStatus(postId, "pending_approval");
      logActivity("info", "post_queued_for_approval", { cycleId, postId, title: generated.title });
    }

  } catch (err) {
    logActivity("error", "scheduler_error", err.message);
  }
}

// ── Post Execution ───────────────────────────────────────────

export async function executePost(postId) {
  const post = getPost(postId);
  if (!post) throw new Error(`Post ${postId} not found`);

  try {
    const result = await publishPost(post.content, post.hashtags);

    updatePostStatus(postId, "posted", {
      linkedinId: result.postId,
      postedAt: new Date().toISOString()
    });

    logActivity("info", "post_published", {
      postId,
      linkedinId: result.postId,
      title: post.title
    });

    return result;
  } catch (err) {
    updatePostStatus(postId, "failed", { errorMessage: err.message });
    logActivity("error", "post_publish_failed", { postId, error: err.message });
    throw err;
  }
}

// ── Manual Mode Actions ──────────────────────────────────────

export async function approvePost(postId) {
  const post = getPost(postId);
  if (!post) throw new Error(`Post ${postId} not found`);
  if (post.status !== "pending_approval") throw new Error(`Post ${postId} is not pending approval (status: ${post.status})`);
  updatePostStatus(postId, "approved");
  logActivity("info", "post_approved", { postId });
  return executePost(postId);
}

export function rejectPost(postId, reason = "") {
  const post = getPost(postId);
  if (!post) throw new Error(`Post ${postId} not found`);
  if (post.status !== "pending_approval") throw new Error(`Post ${postId} is not pending approval (status: ${post.status})`);
  updatePostStatus(postId, "rejected", { errorMessage: reason });
  logActivity("info", "post_rejected", { postId, reason });
}

// ── Scheduler Lifecycle ──────────────────────────────────────

export function startScheduler() {
  const hour = process.env.PREFERRED_POST_HOUR || "9";

  // Run at the preferred hour every day, and also at hour+12 for a second check
  const secondHour = (parseInt(hour) + 12) % 24;

  schedulerJob = cron.schedule(`0 ${hour},${secondHour} * * *`, () => {
    logActivity("info", "scheduler_tick", `Cron fired at preferred hours ${hour}, ${secondHour}`);
    schedulerTick().catch(err => {
      logActivity("error", "scheduler_tick_unhandled", err.message);
    });
  });

  logActivity("info", "scheduler_started", {
    checkTimes: [`${hour}:00`, `${secondHour}:00`],
    mode: getAgentState("mode")
  });

  console.log(`⏰ Scheduler started — checks at ${hour}:00 and ${secondHour}:00 daily`);
  return schedulerJob;
}

export function stopScheduler() {
  if (schedulerJob) {
    schedulerJob.stop();
    logActivity("info", "scheduler_stopped", "Manual stop");
  }
}

// ── Force a cycle (for testing/manual trigger) ───────────────

export async function forceCycle(topicId = null) {
  logActivity("info", "force_cycle", { manual: true, topicId: topicId || "auto" });
  return schedulerTick(topicId);
}
