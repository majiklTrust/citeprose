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
      linkedinProfile: tokenStatus.valid ? tokenStatus.name : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Posts ─────────────────────────────────────────────────────

router.get("/api/posts", (req, res) => {
  const limit = parseInt(req.query.limit || "50");
  const status = req.query.status;

  const posts = status ? getPostsByStatus(status) : getAllPosts(limit);
  res.json({ posts });
});

router.get("/api/posts/:id", (req, res) => {
  const post = getPost(parseInt(req.params.id));
  if (!post) return res.status(404).json({ error: "Post not found" });
  res.json({ post });
});

// ── Approval Flow ────────────────────────────────────────────

router.post("/api/posts/:id/approve", async (req, res) => {
  try {
    const result = await approvePost(parseInt(req.params.id));
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/posts/:id/reject", (req, res) => {
  try {
    rejectPost(parseInt(req.params.id), req.body.reason || "");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Mode Control ─────────────────────────────────────────────

router.post("/api/mode", (req, res) => {
  const { mode } = req.body;
  if (!["auto", "manual"].includes(mode)) {
    return res.status(400).json({ error: "Mode must be 'auto' or 'manual'" });
  }
  setAgentState("mode", mode);
  res.json({ mode });
});

router.post("/api/pause", (req, res) => {
  const { paused } = req.body;
  setAgentState("paused", String(!!paused));
  res.json({ paused: !!paused });
});

router.post("/api/corroboration", (req, res) => {
  const { enabled } = req.body;
  const value = enabled === false ? "disabled" : "enabled";
  setAgentState("corroboration", value);
  logActivity("info", "corroboration_toggled", { corroboration: value });
  res.json({ corroboration: value });
});

// ── Manual Triggers ──────────────────────────────────────────

router.post("/api/generate-preview", async (req, res) => {
  try {
    const topicId = req.body.topicId || null;
    const generated = await generatePost(topicId);

    if (generated.blocked) {
      return res.json({ blocked: true, reason: generated.reason, topicId: generated.topicId, angle: generated.angle });
    }

    const quality = await qualityCheck(generated.content, generated.researchSummary);
    res.json({ post: generated, quality });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/save-preview", (req, res) => {
  try {
    const { topicId, title, content, hashtags, angle, sourcesUsed, researchSummary, quality } = req.body;

    if (!topicId || !title || !content) {
      return res.status(400).json({ error: "Missing required fields: topicId, title, content" });
    }

    const storedContext = JSON.stringify({
      angle: angle || "",
      sourcesUsed: sourcesUsed || [],
      researchSummary: researchSummary || null,
      qualityScores: quality?.scores,
      factualFlags: quality?.factual_flags
    });

    const postId = createPost({
      topicId,
      title,
      content,
      hashtags: hashtags || [],
      newsContext: storedContext
    });

    updatePostStatus(postId, "pending_approval");
    logActivity("info", "preview_saved_to_queue", { postId, title });

    res.json({ success: true, postId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/force-cycle", async (req, res) => {
  try {
    const topicId = req.body.topicId || null;
    await forceCycle(topicId);
    res.json({ success: true, message: "Scheduler cycle executed", topicId: topicId || "auto" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Research & News Monitor ──────────────────────────────────

router.get("/api/research/stats", (req, res) => {
  try {
    const stats = getArticleStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/research/articles", (req, res) => {
  try {
    const topicId = req.query.topic;
    const maxAge = parseInt(req.query.maxAge || "14");
    const limit = parseInt(req.query.limit || "20");

    if (!topicId) {
      return res.status(400).json({ error: "topic query parameter required" });
    }

    const articles = getArticlesForTopic(topicId, maxAge, limit);
    res.json({ articles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/research/poll", async (req, res) => {
  try {
    const newArticles = await pollAllFeeds();
    res.json({ success: true, newArticles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Activity Log ─────────────────────────────────────────────

router.get("/api/logs", (req, res) => {
  const limit = parseInt(req.query.limit || "100");
  const logs = getActivityLog(limit);
  res.json({ logs });
});

// ── LinkedIn Auth ────────────────────────────────────────────

router.get("/api/linkedin/status", async (req, res) => {
  const status = await validateToken().catch(() => ({ valid: false }));
  res.json(status);
});

export default router;
