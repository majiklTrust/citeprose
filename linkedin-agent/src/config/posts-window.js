// ═══════════════════════════════════════════════════════════════
// src/config/posts-window.js — posting cadence window resolver
// ═══════════════════════════════════════════════════════════════
// Pure and dependency-free, following the poll-schedule.js pattern.
//
//   POSTS_WINDOW_DAYS         unset/blank/invalid -> 10 (days)
//   MAX_POSTS_PER_WINDOW_DAYS unset/blank/invalid -> 4  (posts)
//
// MAX_POSTS_PER_WINDOW_DAYS replaces the former MAX_POSTS_PER_10_DAYS.
// The legacy name is honored as a fallback so an un-migrated .env
// does not silently change the cap; remove the fallback once every
// environment has been migrated.
//
// Safe direction is always "a sane default cadence", never a NaN
// that disables or breaks the cap check.
// ═══════════════════════════════════════════════════════════════

export function getPostsWindowDays() {
  const n = parseInt(process.env.POSTS_WINDOW_DAYS || "10", 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export function getMaxPostsPerWindowDays() {
  const raw = process.env.MAX_POSTS_PER_WINDOW_DAYS
    ?? process.env.MAX_POSTS_PER_10_DAYS;
  const n = parseInt(raw || "4", 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}