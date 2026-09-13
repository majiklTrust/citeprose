// ═══════════════════════════════════════════════════════════════
// src/automation/generation-loop.js: the generation half
// ═══════════════════════════════════════════════════════════════
// 4.25111.60. The body of schedulerTick, moved here from
// scheduler.js and gated by the automation state instead of by two
// string comparisons. scheduler.js keeps the tick's envelope (the
// scheduler_error catch that classifies a Model Provider failure),
// the cron, forceCycle, and everything on the publishing side;
// this module owns "should the agent generate now, and if so do
// it and queue the result".
//
// What changed against the old tick body, and nothing else:
//
//   1. The gate. Was `mode === "manual"` (hold while pending) and
//      `mode === "auto"` (publish inline). Now automationGate()
//      from automation-mode.js: manual holds outright, the two
//      automated modes proceed, pause wins over everything.
//   2. (4.25111.60, REMOVED in 4.25111.87.) The .60 delivery lifted
//      the old manual-only pending hold out of that branch, made it
//      the tenant setting hold_while_pending (default true) and
//      applied it to both automated modes, describing that as "the
//      old manual-mode behavior". It was not: under the old tick a
//      tenant whose stored mode was anything but the literal string
//      "manual" (including no row at all) generated on every tick
//      regardless of the queue. Applying the hold to auto-generate
//      froze every such tenant with a non-empty review queue on the
//      first tick of the new code, silently (scheduler_waiting on
//      the tenant trail, nothing on the dashboard). Owner's ruling
//      (2026-09-12): nothing holds generation on the state of the
//      review queue; the ONLY hold in the system is auto-post's
//      review window (review_window_hours, publishing-loop.js).
//      Generation no longer reads pending_approval at all; the
//      setting is retired (DDL 49.0 removes the registry key and
//      any stored rows; the routes refuse the name).
//   3. Under auto-post the cadence floor is asked with a look-ahead
//      of the review window plus one publishing sweep (see
//      canPostNow in scheduler.js), so the window overlaps the floor instead of
//      adding to it.
//   4. A generated post ALWAYS goes to pending_approval. The inline
//      publish that `auto` used to perform is gone; auto-post
//      publishes from the queue through the publishing loop after
//      the review window (Decision 1, confirmed).
//   5. Force Cycle passes { forced: true }: it skips the mode gate
//      (a human pressed it) and keeps pause and the cadence floor
//      exactly as the old tick kept them.
//
// Every exit returns a decision object so a caller (the cron, the
// force-cycle route, a suite) can see why nothing happened:
//   { action: "hold", reasonCode, reason }
//   { action: "generated", postId, cycleId, topicId }
//   { action: "blocked", reasonCode, reason, cycleId }
// The trail lines the old tick wrote (scheduler_skipped,
// scheduler_cadence_hold, scheduler_generating, post_blocked,
// quality_check, quality_below_threshold, quality_retry_improved,
// post_queued_for_approval) are written unchanged; the
// generation_held line names the mode hold. scheduler_waiting is no
// longer written by anything (4.25111.87): a scheduler_waiting line
// on a tenant trail dates from before that delivery.
//
// Must be called inside a tenant scope (withTenant or the leased
// workflow envelope). Throws propagate to the caller's envelope.
// ═══════════════════════════════════════════════════════════════

import { createPost, updatePostStatus, logActivity } from "../services/database.js";
import { generatePost, qualityCheck } from "../services/content-generator.js";
import { readMode, automationGate } from "./automation-mode.js";
import { readAutomationSettings } from "./settings.js";

// One publishing sweep, in hours, for the auto-post look-ahead.
// Resolved the way batch-publisher.js resolves its interval
// (BATCH_PUBLISH_INTERVAL_MINUTES, 1..59, default 15) without
// importing it, which would close an import cycle through
// scheduler.js.
function sweepHours() {
  const n = parseInt(process.env.BATCH_PUBLISH_INTERVAL_MINUTES ?? "", 10);
  return (Number.isInteger(n) && n >= 1 && n <= 59 ? n : 15) / 60;
}

function hold(reasonCode, reason) {
  return { action: "hold", reasonCode, reason };
}

export async function runGenerationCycle({ topicId = null, forced = false } = {}) {
  const state = await readMode();
  const settings = await readAutomationSettings();

  // Pause first, as the old tick did, whoever pulled the lever.
  if (state.paused) {
    await logActivity("info", "scheduler_skipped", "Agent is paused");
    return hold("paused", "the agent is paused");
  }

  // The mode gate. A forced cycle is a human act and skips it.
  if (!forced) {
    const gate = automationGate({ loop: "generation", mode: state.mode, paused: false });
    if (!gate.allowed) {
      await logActivity("info", "generation_held", { reasonCode: gate.reasonCode, mode: state.mode });
      return hold(gate.reasonCode, "generation is not automated in this automation state");
    }
  }

  // Step 1 (the review-queue hold) was removed in 4.25111.87; see
  // item 2 in the header. The state of the review queue is not an
  // input to generation. Nothing between the mode gate and the
  // cadence check reads posts.

  // Step 2: cadence check. Under auto-post, look ahead by the review
  // window plus one sweep (the post will wait that long before it
  // can publish); otherwise ask about now, as before.
  const lookAhead = automationGate({ loop: "publishing", mode: state.mode, paused: false }).allowed
    ? settings.reviewWindowHours + sweepHours()
    : 0;
  // canPostNow stays in scheduler.js (its home since the SQLite era,
  // and where the standing suites look for it); scheduler.js imports
  // this module, so the read is lazy to keep the graph acyclic.
  const { canPostNow } = await import("../services/scheduler.js");
  const cadence = await canPostNow(lookAhead);
  if (!cadence.allowed) {
    await logActivity("info", "scheduler_cadence_hold", cadence.reason);
    return hold("cadence", cadence.reason);
  }

  // Step 3: Generate content (includes research phase)
  await logActivity("info", "scheduler_generating", "Generating new post content with research");

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
    return { action: "blocked", reasonCode: "blocked_insufficient_sources", reason: generated.reason, cycleId };
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

  // createPost stores news_context as JSONB, pass the object
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

  // Step 6: queue for review. Every automation state queues; the
  // publishing loop is the only automated path to LinkedIn.
  await updatePostStatus(postId, "pending_approval");
  await logActivity("info", "post_queued_for_approval", { cycleId, postId, title: generated.title });
  return { action: "generated", postId, cycleId, topicId: generated.topicId };
}
