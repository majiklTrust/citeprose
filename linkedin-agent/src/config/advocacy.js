// ═══════════════════════════════════════════════════════════════
// src/config/advocacy.js, advocacy content tunables
// ═══════════════════════════════════════════════════════════════
// Follows the posts-window.js pattern: env-overridable getters
// with a hardcoded floor as the zero-configuration default. The
// safe direction is always a sane cap, never NaN.
//
//   ADVOCACY_MAX_HASHTAGS  unset/blank/invalid -> 12
//
// The cap bounds how many hashtags a member variant carries after
// filtering; it exists so a hostile or malformed source post
// cannot flood variants with unbounded tags.
// ═══════════════════════════════════════════════════════════════

export function getAdvocacyMaxHashtags() {
  const n = parseInt(process.env.ADVOCACY_MAX_HASHTAGS || "12", 10);
  return Number.isFinite(n) && n > 0 ? n : 12;
}
