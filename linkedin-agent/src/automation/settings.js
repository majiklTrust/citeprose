// ═══════════════════════════════════════════════════════════════
// src/automation/settings.js: tenant automation settings
// ═══════════════════════════════════════════════════════════════
// 4.25111.60. The tenant settings the automation loops consult,
// stored as registered agent_state keys (DDL 46.0) and read here,
// in one place, with one set of defaults the routes and the loops
// share. The registry validates the shape on write (integer ^\d+$);
// getAgentState never reads the registry's default_value, so the
// defaults live here and the DDL carries the same numbers for the
// operator's eyes.
//
//   review_window_hours  hours a queued post must wait before
//                        auto-post may publish it. The business
//                        case: users get time to intersect the
//                        auto-post process before a post goes out.
//                        Default 48. 0 publishes on the next sweep.
//                        This is the ONLY hold in the automation
//                        system, and it holds publishing, never
//                        generation.
//
// 4.25111.87: hold_while_pending is retired. The .60 delivery had
// registered it as a second setting ("generation waits while any
// post is awaiting review", default true, both automated modes).
// Owner's ruling (2026-09-12): nothing holds generation on the state
// of the review queue. The key is gone from this module, from the
// routes (which now refuse the name), from the status payloads, and
// from the registry (DDL 49.0 deletes the row and any stored
// values). RETIRED_SETTING_KEYS names it so the route can answer a
// client that still sends it with a specific refusal instead of a
// generic one.
//
// A stored value that fails the shape here (which the registry
// should have refused) falls back to the default and is reported
// once per process per tenant, never silently.
// ═══════════════════════════════════════════════════════════════

export const AUTOMATION_DEFAULTS = Object.freeze({
  reviewWindowHours: 48
});

// Upper bound on the review window a route will accept: one year.
// The registry accepts any non-negative integer; the route is where
// a typo becomes a refusal instead of a post that never publishes.
export const REVIEW_WINDOW_MAX_HOURS = 24 * 366;

export const SETTING_KEYS = Object.freeze({
  reviewWindowHours: "review_window_hours"
});

// Setting names this module once accepted and no longer does. A
// request naming one is refused by the route with the reason, so a
// client built against an older version learns why, not merely that.
export const RETIRED_SETTING_KEYS = Object.freeze({
  holdWhilePending: "retired in 4.25111.87: generation is never held on the state of the review queue; the review window (reviewWindowHours) is the only hold and it applies to auto-post publishing"
});

// Pure parser, shared by the reader and the route validation.
export function parseReviewWindowHours(raw) {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 && raw <= REVIEW_WINDOW_MAX_HOURS ? raw : null;
  }
  if (typeof raw === "string" && /^\d{1,6}$/.test(raw)) {
    const n = parseInt(raw, 10);
    return n <= REVIEW_WINDOW_MAX_HOURS ? n : null;
  }
  return null;
}

const reportedInvalid = new Set();

// Must be called inside a tenant scope. Returns
// { reviewWindowHours, sources } where sources says per setting
// whether the value was stored or defaulted.
export async function readAutomationSettings() {
  const { getAgentState, logActivityBestEffort } = await import("../services/database.js");
  const out = { ...AUTOMATION_DEFAULTS, sources: { reviewWindowHours: "default" } };
  const rawWindow = await getAgentState(SETTING_KEYS.reviewWindowHours);
  const window = parseReviewWindowHours(rawWindow);
  if (window !== null) { out.reviewWindowHours = window; out.sources.reviewWindowHours = "stored"; }
  const invalid = [];
  if (rawWindow !== undefined && window === null) invalid.push({ key: SETTING_KEYS.reviewWindowHours, raw: String(rawWindow).slice(0, 32) });
  if (invalid.length) {
    const { currentTenantId } = await import("../db/with-tenant.js");
    const tenantId = currentTenantId();
    const marker = `${tenantId}|${invalid.map((i) => i.key).join(",")}`;
    if (!reportedInvalid.has(marker)) {
      reportedInvalid.add(marker);
      const { platformLog } = await import("../services/platform-log.js");
      platformLog("warn", "automation_settings_invalid_stored", { tenantId, invalid, using: { reviewWindowHours: out.reviewWindowHours } });
      await logActivityBestEffort("warn", "automation_settings_invalid_stored", { invalid, using: { reviewWindowHours: out.reviewWindowHours } });
    }
  }
  return out;
}
