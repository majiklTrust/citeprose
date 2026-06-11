// ═══════════════════════════════════════════════════════════════
// Security Utilities
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";

// ── HTML Escaping ────────────────────────────────────────────

const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[&<>"']/g, c => HTML_ENTITIES[c]);
}

// ── OAuth State ──────────────────────────────────────────────

const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

export function generateOAuthState() {
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.set(state, Date.now());

  for (const [key, ts] of pendingStates) {
    if (Date.now() - ts > STATE_TTL_MS) pendingStates.delete(key);
  }

  return state;
}

export function validateOAuthState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const ts = pendingStates.get(state);
  pendingStates.delete(state);
  return (Date.now() - ts) <= STATE_TTL_MS;
}

// ── Error Handling ───────────────────────────────────────────

export function safeErrorResponse(res, statusCode, logFn, action, err) {
  const ref = Date.now().toString(36);
  const detail = {
    ref,
    error: err.message,
    stack: err.stack?.split("\n").slice(0, 2).join(" | ")
  };

  if (logFn) {
    try { logFn("error", action, detail); } catch { /* logging must not throw */ }
  }

  res.status(statusCode).json({
    error: "An internal error occurred.",
    ref
  });
}

// ── Input Validation ─────────────────────────────────────────

const VALID_TOPICS = new Set([
  "ai-practical-benefit", "ai-guardrails",
  "cybersecurity-incidents", "cybersecurity-advances"
]);

const VALID_STATUSES = new Set([
  "pending_approval", "posted", "rejected", "failed", "approved"
]);

const VALID_MODES = new Set(["auto", "manual"]);

export function isValidTopicId(topicId) {
  return topicId === null || topicId === undefined || VALID_TOPICS.has(topicId);
}

export function isValidStatus(status) {
  return !status || VALID_STATUSES.has(status);
}

export function isValidMode(mode) {
  return VALID_MODES.has(mode);
}

export function parseId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 999999) return null;
  if (String(parsed) !== String(value).trim()) return null;  // reject "123abc"
  return parsed;
}

export function sanitizeInt(value, defaultVal, min = 1, max = 1000) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return defaultVal;
  return Math.max(min, Math.min(max, parsed));
}

export function sanitizeString(str, maxLength = 500) {
  if (typeof str !== "string") return "";
  return str.slice(0, maxLength);
}

// ── URL Safety ───────────────────────────────────────────────
// SSRF protection: validates that a URL is safe to fetch from
// the server. Blocks non-HTTPS, localhost, private IP ranges,
// link-local, and internal hostnames. Used by feed discovery,
// image harvesting, and image upload pipelines.

const PRIVATE_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./
];

export function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "::1") return false;
    if (host.endsWith(".internal") || host.endsWith(".local")) return false;
    for (const re of PRIVATE_RANGES) {
      if (re.test(host)) return false;
    }
    if (host.startsWith("172.")) {
      const octet = parseInt(host.split(".")[1], 10);
      if (octet >= 16 && octet <= 31) return false;
    }
    return true;
  } catch { return false; }
}

// Validates that a URL looks like an image resource.
// Checks HTTPS safety + common image extensions/content hints.
// Does NOT fetch the URL — purely syntactic.
const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|svg)(\?|$)/i;

// Image-capture fix: the old exact-MIME allowlist rejected the
// harvester's own "image/unknown" label and modern types like
// image/avif, while the extension fallback rejected extension-less
// CDN URLs — so most real-world feed images were silently dropped.
// Like a browser, we now honor any declared image/* type; the
// extension test remains only for candidates with no type at all.
// SSRF checks are unchanged — worst-case false positive here is a
// broken thumbnail, not an unsafe fetch.
export function isImageUrl(urlStr, contentType) {
  if (!isSafeUrl(urlStr)) return false;
  // Trust any declared image/* type (see rationale above).
  if (typeof contentType === "string" && contentType.trim().toLowerCase().startsWith("image/")) {
    return true;
  }
  return IMAGE_EXTENSIONS.test(urlStr);
}
