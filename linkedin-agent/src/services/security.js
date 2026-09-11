// ═══════════════════════════════════════════════════════════════
// Security Utilities
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";
// 4.25111.60: the automation state vocabulary is owned by the
// interpreter; isValidMode delegates so the two can never drift.
import { TIERS } from "../config/entitlements.js";
import { isMode } from "../automation/automation-mode.js";

// ── HTML Escaping ────────────────────────────────────────────

const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[&<>"']/g, c => HTML_ENTITIES[c]);
}

// ── OAuth State ──────────────────────────────────────────────

const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

// Post-flow return targets are ALLOWLISTED local paths only. Any
// other value (absolute URLs, protocol-relative //host, traversal)
// collapses to the dashboard, so the OAuth flow can never become
// an open redirect.
// 4.25111.78: the purchase door (/checkout/<tier>, one exact entry
// per tier) and the return from Stripe (/checkout/return) join the
// list, still exact-match: no query, no prefix, no pattern.
const RETURN_TO_ALLOWLIST = [
  "/app", "/app/", "/app/linkedin/", "/app/advocacy/", "/app/analytics/",
  "/checkout/return", ...TIERS.map((t) => "/checkout/" + t)
];

export function sanitizeReturnTo(value) {
  const v = String(value || "");
  return RETURN_TO_ALLOWLIST.includes(v) ? v : "/app";
}

export function generateOAuthState(returnTo) {
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.set(state, { ts: Date.now(), returnTo: sanitizeReturnTo(returnTo) });

  for (const [key, entry] of pendingStates) {
    if (Date.now() - entry.ts > STATE_TTL_MS) pendingStates.delete(key);
  }

  return state;
}

// Returns false for an invalid or expired state; on success returns
// a truthy record carrying the sanitized return target, so existing
// boolean call sites keep working unchanged.
export function validateOAuthState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if ((Date.now() - entry.ts) > STATE_TTL_MS) return false;
  return { ok: true, returnTo: entry.returnTo || "/app" };
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

export function isValidTopicId(topicId) {
  return topicId === null || topicId === undefined || VALID_TOPICS.has(topicId);
}

export function isValidStatus(status) {
  return !status || VALID_STATUSES.has(status);
}

export function isValidMode(mode) {
  return isMode(mode);
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
