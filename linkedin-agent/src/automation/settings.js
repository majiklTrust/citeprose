// ═══════════════════════════════════════════════════════════════
// src/automation/settings.js: tenant automation settings
// ═══════════════════════════════════════════════════════════════
// 4.25111.60. The tenant settings the automation loops consult,
// stored as registered agent_state keys (DDL 46.0) and read here,
// in one place, with one set of defaults the routes and the loops
// share. The registry validates the shape on write (integer ^\d+$,
// boolean true or false); getAgentState never reads the registry's
// default_value, so the defaults live here and the DDL carries the
// same numbers for the operator's eyes.
//
//   review_window_hours  hours a queued post must wait before
//                        auto-post may publish it. The business
//                        case: users get time to intersect the
//                        auto-post process before a post goes out.
//                        Default 48. 0 publishes on the next sweep.
//   hold_while_pending   generation waits while any post is awaiting
//                        review (today's manual-mode hold, now a
//                        rule for both automated modes). Default true.
//
// A stored value that fails the shape here (which the registry
// should have refused) falls back to the default and is reported
// once per process per tenant, never silently.
// ═══════════════════════════════════════════════════════════════

export const AUTOMATION_DEFAULTS = Object.freeze({
  reviewWindowHours: 48,
  holdWhilePending: true
});

// Upper bound on the review window a route will accept: one year.
// The registry accepts any non-negative integer; the route is where
// a typo becomes a refusal instead of a post that never publishes.
export const REVIEW_WINDOW_MAX_HOURS = 24 * 366;

export const SETTING_KEYS = Object.freeze({
  reviewWindowHours: "review_window_hours",
  holdWhilePending: "hold_while_pending"
});

// Pure parsers, shared by the reader and the route validation.
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
export function parseHoldWhilePending(raw) {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  return null;
}

const reportedInvalid = new Set();

// Must be called inside a tenant scope. Returns
// { reviewWindowHours, holdWhilePending, sources } where sources
// says per setting whether the value was stored or defaulted.
export async function readAutomationSettings() {
  const { getAgentState, logActivityBestEffort } = await import("../services/database.js");
  const out = { ...AUTOMATION_DEFAULTS, sources: { reviewWindowHours: "default", holdWhilePending: "default" } };
  const rawWindow = await getAgentState(SETTING_KEYS.reviewWindowHours);
  const rawHold = await getAgentState(SETTING_KEYS.holdWhilePending);
  const window = parseReviewWindowHours(rawWindow);
  const hold = parseHoldWhilePending(rawHold);
  if (window !== null) { out.reviewWindowHours = window; out.sources.reviewWindowHours = "stored"; }
  if (hold !== null) { out.holdWhilePending = hold; out.sources.holdWhilePending = "stored"; }
  const invalid = [];
  if (rawWindow !== undefined && window === null) invalid.push({ key: SETTING_KEYS.reviewWindowHours, raw: String(rawWindow).slice(0, 32) });
  if (rawHold !== undefined && hold === null) invalid.push({ key: SETTING_KEYS.holdWhilePending, raw: String(rawHold).slice(0, 32) });
  if (invalid.length) {
    const { currentTenantId } = await import("../db/with-tenant.js");
    const tenantId = currentTenantId();
    const marker = `${tenantId}|${invalid.map((i) => i.key).join(",")}`;
    if (!reportedInvalid.has(marker)) {
      reportedInvalid.add(marker);
      const { platformLog } = await import("../services/platform-log.js");
      platformLog("warn", "automation_settings_invalid_stored", { tenantId, invalid, using: { reviewWindowHours: out.reviewWindowHours, holdWhilePending: out.holdWhilePending } });
      await logActivityBestEffort("warn", "automation_settings_invalid_stored", { invalid, using: { reviewWindowHours: out.reviewWindowHours, holdWhilePending: out.holdWhilePending } });
    }
  }
  return out;
}
