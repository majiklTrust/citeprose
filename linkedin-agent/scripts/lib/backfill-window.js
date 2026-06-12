// ═══════════════════════════════════════════════════════════════
// scripts/lib/backfill-window.js — backfill day-window resolver
// ═══════════════════════════════════════════════════════════════
// Pure. Resolves the backfill script's 0/1/2 positional arguments
// into a day window:
//
//   (none)       -> { mode: "window", minDays: 0,  maxDays: 160 }
//   ("20")       -> { mode: "window", minDays: 0,  maxDays: 20 }
//   ("20","30")  -> { mode: "range",  minDays: 20, maxDays: 30 }
//   ("30","20")  -> identical to the above (order-independent)
//
// "window" = everything published in the last maxDays.
// "range"  = published between maxDays and minDays ago, INCLUSIVE
//            on both ends (>= / <=).
//
// Arguments must be strict positive digit strings (/^\d+$/, > 0).
// Anything else degrades to the simpler mode rather than throwing:
// an invalid second argument is ignored (single-window behavior);
// an invalid first argument yields the 160-day default.
// ═══════════════════════════════════════════════════════════════

const DEFAULT_DAYS = 160;

function toPosInt(v) {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  const n = parseInt(v, 10);
  return n >= 0 ? n : null;
}

export function resolveWindow(arg1, arg2) {
  const a = toPosInt(arg1);
  if (a === null) {
    return { mode: "window", minDays: 0, maxDays: DEFAULT_DAYS };
  }
  const b = toPosInt(arg2);
  if (b === null) {
    return { mode: "window", minDays: 0, maxDays: a };
  }
  return { mode: "range", minDays: Math.min(a, b), maxDays: Math.max(a, b) };
}
