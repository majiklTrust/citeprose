// ═══════════════════════════════════════════════════════════════
// API Routes — Dashboard backend endpoints
// ═══════════════════════════════════════════════════════════════

import { Router } from "express";
import {
  getPostStats,
  getAllPosts,
  getPostsByStatus,
  getAgentState,
  setAgentState,
  getActivityLog,
  getPost,
  createPost,
  updatePostStatus,
  logActivity
} from "../services/database.js";
import {
  approvePost,
  rejectPost,
  canPostNow,
  forceCycle
} from "../services/scheduler.js";
import { generatePost, qualityCheck } from "../services/content-generator.js";
import { validateToken } from "../services/linkedin-api.js";
import { getArticleStats, getArticlesForTopic, pollAllFeeds } from "../services/news-monitor.js";
import {
  safeErrorResponse,
  isValidTopicId,
  isValidStatus,
  isValidMode,
  sanitizeInt,
  sanitizeString,
  parseId
} from "../services/security.js";

const router = Router();

// ── Dashboard Data ───────────────────────────────────────────

router.get("/api/status", async (req, res) => {
  try {
    const stats = getPostStats();
    const mode = getAgentState("mode");
    const paused = getAgentState("paused");
    const corroboration = getAgentState("corroboration") || "enabled";
    const cadence = canPostNow();
    const tokenStatus = await validateToken().catch(() => ({ valid: false, reason: "Check failed" }));

    let researchStats = null;
    try {
      researchStats = getArticleStats();
    } catch { /* monitor may not be initialized yet */ }

    res.json({
      mode,
      paused: paused === "true",
      corroboration,
      cadence,
      stats,
      researchStats,
      linkedinConnected: tokenStatus.valid,
      linkedinProfile: tokenStatus.valid ? tokenStatus.name : null,
      logLimit: sanitizeInt(process.env.DASHBOARD_LOG_LIMIT, 40, 10, 500)
    });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_status_error", err);
  }
});

// ── Posts ─────────────────────────────────────────────────────

router.get("/api/posts", (req, res) => {
  try {
    const limit = sanitizeInt(req.query.limit, 50, 1, 200);
    const status = req.query.status;

    if (status && !isValidStatus(status)) {
      return res.status(400).json({ error: "Invalid status parameter." });
    }

    const posts = status ? getPostsByStatus(status) : getAllPosts(limit);
    res.json({ posts });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_posts_list_error", err);
  }
});

router.get("/api/posts/:id", (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid post ID." });

    const post = getPost(id);
    if (!post) return res.status(404).json({ error: "Post not found." });
    res.json({ post });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_post_get_error", err);
  }
});

// ── Approval Flow ────────────────────────────────────────────

router.post("/api/posts/:id/approve", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid post ID." });

    const result = await approvePost(id);
    res.json({ success: true, result });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_post_approve_error", err);
  }
});

router.post("/api/posts/:id/reject", (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid post ID." });

    const reason = sanitizeString(req.body.reason || "", 500);
    rejectPost(id, reason);
    res.json({ success: true });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_post_reject_error", err);
  }
});

// ── Mode Control ─────────────────────────────────────────────

router.post("/api/mode", (req, res) => {
  try {
    const { mode } = req.body;
    if (!isValidMode(mode)) {
      return res.status(400).json({ error: "Mode must be 'auto' or 'manual'." });
    }
    setAgentState("mode", mode);
    res.json({ mode });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_mode_error", err);
  }
});

router.post("/api/pause", (req, res) => {
  try {
    const { paused } = req.body;
    setAgentState("paused", String(!!paused));
    res.json({ paused: !!paused });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_pause_error", err);
  }
});

router.post("/api/corroboration", (req, res) => {
  try {
    const { enabled } = req.body;
    const value = enabled === false ? "disabled" : "enabled";
    setAgentState("corroboration", value);
    logActivity("info", "corroboration_toggled", { corroboration: value });
    res.json({ corroboration: value });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_corroboration_error", err);
  }
});

// ── Manual Triggers ──────────────────────────────────────────

router.post("/api/generate-preview", async (req, res) => {
  try {
    const topicId = req.body.topicId || null;

    if (topicId && !isValidTopicId(topicId)) {
      return res.status(400).json({ error: "Invalid topic ID." });
    }

    const generated = await generatePost(topicId);

    if (generated.blocked) {
      return res.json({ blocked: true, reason: generated.reason, topicId: generated.topicId, angle: generated.angle });
    }

    const quality = await qualityCheck(generated.content, generated.researchSummary);
    res.json({ post: generated, quality });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_generate_preview_error", err);
  }
});

router.post("/api/save-preview", (req, res) => {
  try {
    const { topicId, title, content, hashtags, angle, sourcesUsed, researchSummary, quality, cycleId } = req.body;

    if (!topicId || !title || !content) {
      return res.status(400).json({ error: "Missing required fields: topicId, title, content." });
    }

    if (!isValidTopicId(topicId)) {
      return res.status(400).json({ error: "Invalid topic ID." });
    }

    const safeTitle = sanitizeString(title, 200);
    const safeContent = sanitizeString(content, 5000);

    const storedContext = JSON.stringify({
      cycleId: sanitizeString(cycleId || "", 16),
      angle: sanitizeString(angle || "", 500),
      sourcesUsed: Array.isArray(sourcesUsed) ? sourcesUsed.slice(0, 20) : [],
      researchSummary: researchSummary || null,
      qualityScores: quality?.scores,
      factualFlags: quality?.factual_flags
    });

    const postId = createPost({
      topicId,
      title: safeTitle,
      content: safeContent,
      hashtags: Array.isArray(hashtags) ? hashtags.slice(0, 10) : [],
      newsContext: storedContext
    });

    updatePostStatus(postId, "pending_approval");
    logActivity("info", "preview_saved_to_queue", { postId, title: safeTitle });

    res.json({ success: true, postId });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_save_preview_error", err);
  }
});

router.post("/api/force-cycle", async (req, res) => {
  try {
    const topicId = req.body.topicId || null;

    if (topicId && !isValidTopicId(topicId)) {
      return res.status(400).json({ error: "Invalid topic ID." });
    }

    await forceCycle(topicId);
    res.json({ success: true, message: "Scheduler cycle executed." });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_force_cycle_error", err);
  }
});

// ── Research & News Monitor ──────────────────────────────────

router.get("/api/research/stats", (req, res) => {
  try {
    const stats = getArticleStats();
    res.json(stats);
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_research_stats_error", err);
  }
});

router.get("/api/research/articles", (req, res) => {
  try {
    const topicId = req.query.topic;

    if (!topicId) {
      return res.status(400).json({ error: "topic query parameter required." });
    }
    if (!isValidTopicId(topicId)) {
      return res.status(400).json({ error: "Invalid topic ID." });
    }

    const maxAge = sanitizeInt(req.query.maxAge, 14, 1, 90);
    const limit = sanitizeInt(req.query.limit, 20, 1, 100);

    const articles = getArticlesForTopic(topicId, maxAge, limit);
    res.json({ articles });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_research_articles_error", err);
  }
});

router.post("/api/research/poll", async (req, res) => {
  try {
    const newArticles = await pollAllFeeds();
    res.json({ success: true, newArticles });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_research_poll_error", err);
  }
});

// ── Activity Log ─────────────────────────────────────────────

router.get("/api/logs", (req, res) => {
  try {
    const limit = sanitizeInt(req.query.limit, 100, 1, 500);
    const logs = getActivityLog(limit);
    res.json({ logs });
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_logs_error", err);
  }
});

// ── LinkedIn Auth ────────────────────────────────────────────

router.get("/api/linkedin/status", async (req, res) => {
  try {
    const status = await validateToken().catch(() => ({ valid: false }));
    res.json(status);
  } catch (err) {
    safeErrorResponse(res, 500, logActivity, "api_linkedin_status_error", err);
  }
});

export default router;
