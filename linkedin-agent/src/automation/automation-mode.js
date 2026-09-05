// ═══════════════════════════════════════════════════════════════
// src/automation/automation-mode.js: the automation state
// ═══════════════════════════════════════════════════════════════
// 4.25111.60. The agent's automation state is one of three modes
// stored on agent_state key 'mode', a ladder where each level
// includes the one below it:
//
//   manual         nothing automated. A human presses a CTA to
//                  generate and a CTA to publish.
//   auto-generate  the agent generates on its own into the approval
//                  queue; a human publishes.
//   auto-post      the agent generates on its own and publishes the
//                  oldest queued post on its own after the review
//                  window.
//
// This module is the ONLY place the mode strings are interpreted.
// Every loop and route imports from here; nothing else compares a
// mode value to a literal or reads the key on its own (the design
// suite scans for exactly that). "Mode" is the stored setting;
// "automation state" is the same thing described by what it does
// for the user, which is the wording anything user-facing uses.
//
// Vocabulary history (DDL 46.0). Stored 'manual' used to mean
// generate-and-hold, which is now 'auto-generate'; stored 'auto'
// meant generate-and-publish, now 'auto-post'; the new 'manual'
// existed nowhere before. The old strings are not stored aliases
// (a stored value has one meaning); fromLegacy() translates them
// for the untouched two-way dashboard toggle, and toLegacy()
// projects the canonical value back for the same toggle to render.
// Both go away with the dashboard control delivery.
//
// Fail safe. An absent or unrecognized stored value resolves to
// 'manual' (nothing automated) and is reported once per process per
// tenant. After 46.0 every tenant has a row, so this is a guard,
// not a behavior: the migration's backfill, not this default, is
// what keeps an existing tenant's posture unchanged.
// ═══════════════════════════════════════════════════════════════

export const MODES = Object.freeze(["manual", "auto-generate", "auto-post"]);
export const DEFAULT_MODE = "manual";

const LEGACY_TO_CANONICAL = Object.freeze({ manual: "auto-generate", auto: "auto-post" });
const MODE_SET = new Set(MODES);

// True only for one of the three canonical strings, exactly.
export function isMode(value) {
  return typeof value === "string" && MODE_SET.has(value);
}

// Interprets a stored value. Canonical values are returned as
// stored; anything else (absent row, legacy string, corrupted
// value, wrong type) resolves to the fail-safe default with
// source "default" so the caller can report it.
export function resolveMode(stored) {
  if (isMode(stored)) return { mode: stored, source: "stored", raw: stored };
  return { mode: DEFAULT_MODE, source: "default", raw: describeRaw(stored) };
}

function describeRaw(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.length > 64 ? value.slice(0, 64) + "..." : value;
  if (typeof value === "symbol" || typeof value === "function") return typeof value;
  try { return JSON.stringify(value).slice(0, 64); } catch { return typeof value; }
}

// The ladder. auto-generate and auto-post generate; only auto-post
// publishes. Anything that is not a canonical mode has neither.
export function canAutoGenerate(mode) {
  return mode === "auto-generate" || mode === "auto-post";
}
export function canAutoPublish(mode) {
  return mode === "auto-post";
}

// Legacy translation for the two-way toggle: 'manual' (the old
// generate-and-hold) is 'auto-generate', 'auto' is 'auto-post'.
// ONLY the two legacy strings translate. A canonical value is null
// here on purpose: 'manual' is both an old string and a new one,
// and the only caller (the /api/mode shim) speaks the old
// vocabulary exclusively, so a canonical value arriving there is a
// caller mixing vocabularies and is refused. Anything else is null,
// never a guess.
export function fromLegacy(value) {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(LEGACY_TO_CANONICAL, value)) {
    return LEGACY_TO_CANONICAL[value];
  }
  return null;
}

// Projection for the untouched dashboard: it knows AGENTIC ('auto')
// and MANUAL ('manual'). auto-post is the agentic state; the other
// two, and anything unrecognized, render as manual.
export function toLegacy(mode) {
  return mode === "auto-post" ? "auto" : "manual";
}

// The gate both loops pass through first. Pause wins over mode:
// an operator's pause stops everything whatever the tenant chose.
// Unknown loop names, unknown modes, and a pause flag that is not
// a boolean all fail closed.
//
//   { allowed: true, reasonCode: null }
//   { allowed: false, reasonCode: "paused" | "mode_manual" | "mode_no_publish" | "invalid_gate" }
export function automationGate(input) {
  const loop = input && typeof input === "object" ? input.loop : undefined;
  const mode = input && typeof input === "object" ? input.mode : undefined;
  const paused = input && typeof input === "object" ? input.paused : undefined;
  if (typeof paused !== "boolean" || (loop !== "generation" && loop !== "publishing") || !isMode(mode)) {
    return { allowed: false, reasonCode: "invalid_gate" };
  }
  if (paused) return { allowed: false, reasonCode: "paused" };
  if (loop === "generation") {
    return canAutoGenerate(mode) ? { allowed: true, reasonCode: null } : { allowed: false, reasonCode: "mode_manual" };
  }
  return canAutoPublish(mode) ? { allowed: true, reasonCode: null } : { allowed: false, reasonCode: "mode_no_publish" };
}

// ── Reading the stored state ─────────────────────────────────
// Must be called inside a tenant scope. Returns the resolved mode
// plus the paused flag, and reports an absent or unrecognized
// stored value once per process per tenant (platform log, with the
// tenant, and a best-effort warn on the tenant's own trail).

const reportedDefaults = new Set();

export async function readMode() {
  const { getAgentState, logActivityBestEffort } = await import("../services/database.js");
  const stored = await getAgentState("mode");
  const resolved = resolveMode(stored);
  const pausedRaw = await getAgentState("paused");
  const paused = pausedRaw === "true";
  if (resolved.source === "default") {
    const { currentTenantId } = await import("../db/with-tenant.js");
    let tenantId = null;
    try { tenantId = currentTenantId(); } catch { tenantId = null; }
    const key = String(tenantId);
    if (!reportedDefaults.has(key)) {
      reportedDefaults.add(key);
      const { platformLog } = await import("../services/platform-log.js");
      platformLog("warn", "automation_mode_invalid_stored", { tenantId, raw: resolved.raw, using: resolved.mode });
      await logActivityBestEffort("warn", "automation_mode_invalid_stored", { raw: resolved.raw, using: resolved.mode });
    }
  }
  return { mode: resolved.mode, source: resolved.source, raw: resolved.raw, paused };
}
