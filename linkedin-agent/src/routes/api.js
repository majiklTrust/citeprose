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
  getPost
} from "../services/database.js";
import {
  approvePost,
  rejectPost,
  canPostNow,
  forceCycle
} from "../services/scheduler.js";
import { generatePost, qualityCheck } from "../services/content-generator.js";
import { validateToken } from "../services/linkedin-api.js";

const router = Router();

// ── Dashboard Data ───────────────────────────────────────────

router.get("/api/status", async (req, res) => {
  try {
    const stats = getPostStats();
    const mode = getAgentState("mode");
    const paused = getAgentState("paused");
    const cadence = canPostNow();
    const tokenStatus = await validateToken().catch(() => ({ valid: false, reason: "Check failed" }));

    res.json({
      mode,
      paused: paused === "true",
      cadence,
      stats,
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

// ── Manual Triggers ──────────────────────────────────────────

router.post("/api/generate-preview", async (req, res) => {
  try {
    const generated = await generatePost();
    const quality = await qualityCheck(generated.content);
    res.json({ post: generated, quality });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/force-cycle", async (req, res) => {
  try {
    await forceCycle();
    res.json({ success: true, message: "Scheduler cycle executed" });
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
