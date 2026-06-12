// ═══════════════════════════════════════════════════════════════
// src/config/poll-schedule.js — FEED_POLL_CRON resolver
// ═══════════════════════════════════════════════════════════════
// Pure and dependency-free. Resolves the feed polling schedule:
//
//   FEED_POLL_CRON unset/blank  -> "0 * * * *" (hourly, default)
//   valid 5-field expression    -> honored (source: "env")
//   anything invalid            -> default + valid:false so the
//                                  caller logs LOUDLY
//
// Safe direction is always "feeds keep polling hourly", never
// "feeds silently stop". The validator is self-contained and
// supports NUMERIC cron syntax only: * , - / with per-field
// ranges (minute 0-59, hour 0-23, day 1-31, month 1-12, dow 0-7).
// Name forms (MON, JAN) are treated as invalid by design — they
// fall back to the default with a visible log, not a crash.
//
// Examples:
//   FEED_POLL_CRON="*/30 * * * *"   every 30 minutes
//   FEED_POLL_CRON="*/5 * * * *"    every 5 minutes (testing)
//   FEED_POLL_CRON="15 * * * *"     hourly at :15 (phase shift)
//   FEED_POLL_CRON="0 9-17 * * 1-5" hourly, business hours Mon-Fri
// ═══════════════════════════════════════════════════════════════

const DEFAULT_SCHEDULE = "0 * * * *";
const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const PART_RE = /^(\*|(\d{1,2})(-(\d{1,2}))?)(\/(\d{1,2}))?$/;

function validField(field, [lo, hi]) {
  for (const part of field.split(",")) {
    const m = PART_RE.exec(part);
    if (!m) return false;
    if (m[6] !== undefined && parseInt(m[6], 10) === 0) return false; // step /0
    if (m[1] === "*") continue;
    const n = parseInt(m[2], 10);
    if (n < lo || n > hi) return false;
    if (m[4] !== undefined) {
      const end = parseInt(m[4], 10);
      if (end < lo || end > hi || end < n) return false;
    }
  }
  return true;
}

function isValidCron(expr) {
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => validField(f, FIELD_RANGES[i]));
}

// Sanitized, capped echo of a rejected value — safe to log.
function rejectedEcho(raw) {
  return String(raw).replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 60).trim();
}

export function resolvePollSchedule(envValue) {
  // Unset: only undefined (env var absent) or a blank string.
  if (envValue === undefined) {
    return { expression: DEFAULT_SCHEDULE, source: "default", valid: true };
  }
  // Explicit non-string values (incl. null) are not "unset" —
  // fall back loudly so a programming error is visible.
  if (typeof envValue !== "string") {
    return { expression: DEFAULT_SCHEDULE, source: "default", valid: false, rejected: rejectedEcho(envValue) };
  }
  const raw = envValue.trim();
  if (raw === "") {
    return { expression: DEFAULT_SCHEDULE, source: "default", valid: true };
  }
  if (isValidCron(raw)) {
    return { expression: raw, source: "env", valid: true };
  }
  return { expression: DEFAULT_SCHEDULE, source: "default", valid: false, rejected: rejectedEcho(raw) };
}
