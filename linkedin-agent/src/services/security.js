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
