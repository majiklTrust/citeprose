// ═══════════════════════════════════════════════════════════════
// src/services/angle-select.js — content angle selection
// ═══════════════════════════════════════════════════════════════
// Pure, DB-free helpers that decide which content angle drives a
// generation. Two paths:
//   auto    — no angle requested: selectContentAngle() rotates among
//             the topic's content_angles (this is the pre-existing
//             logic MOVED verbatim from content-generator.js).
//   chosen  — the caller requested an angle: it must be an EXISTING
//             member of topic.content_angles (full, normalized
//             match). Arbitrary free text is rejected (fail-closed);
//             ad-hoc angles are a separate, gated feature.
//
// Zero Trust note: `requested` may originate in req.body. It is
// only ever used as a lookup key against trusted stored values, and
// a successful match returns the CANONICAL stored angle — caller
// input never flows into the prompt.
// ═══════════════════════════════════════════════════════════════

// Requests longer than any plausible stored angle are rejected
// before comparison (cheap DoS/abuse guard at the boundary).
const MAX_REQUEST_LENGTH = 500;

// ── selectContentAngle ───────────────────────────────────────
// Auto-rotation among the topic's angles, avoiding angles whose
// wording dominates recent posts on the same topic. Moved verbatim
// from content-generator.js — behavior unchanged.
export function selectContentAngle(topic, recentPosts) {
  const angles = topic.content_angles || [];
  if (angles.length === 0) return "General discussion";

  const recentSameTopic = recentPosts
    .filter(p => p.topic_id === topic.slug)
    .slice(0, 5);

  const usedAngles = new Set();
  for (const post of recentSameTopic) {
    for (let i = 0; i < angles.length; i++) {
      const angleWords = angles[i].toLowerCase().split(/\s+/);
      const postWords = post.content.toLowerCase();
      const matchCount = angleWords.filter(w => w.length > 4 && postWords.includes(w)).length;
      if (matchCount >= 3) usedAngles.add(i);
    }
  }

  const availableIndices = angles
    .map((_, i) => i)
    .filter(i => !usedAngles.has(i));

  const pool = availableIndices.length > 0
    ? availableIndices
    : angles.map((_, i) => i);

  const idx = pool[Math.floor(Math.random() * pool.length)];
  return angles[idx];
}

// ── findExistingAngle ────────────────────────────────────────
// Returns the canonical stored angle when `requested` is a full
// (trimmed, case-insensitive, whitespace-collapsed) match for a
// member of topic.content_angles; otherwise null. Non-string
// entries in the stored list are skipped safely. Substrings and
// superstrings never match.
function normalize(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function findExistingAngle(topic, requested) {
  if (typeof requested !== "string") return null;
  if (requested.length > MAX_REQUEST_LENGTH) return null;
  const wanted = normalize(requested);
  if (wanted.length === 0) return null;
  const angles = (topic && topic.content_angles) || [];
  for (const a of angles) {
    if (typeof a !== "string") continue;
    if (normalize(a) === wanted) return a; // canonical stored value
  }
  return null;
}

// ── resolveAngle ─────────────────────────────────────────────
// The single decision point a generation must pass through:
//   no request (null/undefined/empty) -> auto-rotate:
//       { ok: true, angle, selected: false }
//   request matches an existing angle -> honored canonically:
//       { ok: true, angle, selected: true }
//   anything else -> rejected (fail-closed):
//       { ok: false, reason }
export function resolveAngle(topic, requested, recentPosts) {
  const isEmpty = requested === null || requested === undefined ||
    (typeof requested === "string" && requested.trim().length === 0);

  if (isEmpty) {
    return { ok: true, angle: selectContentAngle(topic, recentPosts || []), selected: false };
  }
  const canonical = findExistingAngle(topic, requested);
  if (canonical !== null) {
    return { ok: true, angle: canonical, selected: true };
  }
  return { ok: false, reason: "Requested angle is not one of this topic's existing content angles" };
}
