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
// 4.25111.94: paused follows the mode (owner's ruling). See
// pausedForMode below; the mode writers call it, the readers and
// the loops are unchanged.
//
// 4.25111.96: a paused workspace is PRESENTED as manual. See
// presentedMode below; the two builders of the automation object
// (the automation route, /api/status) call it, so the dashboard's
// radio, header and Force Cycle button show the state the loops
// act on. The readers and the loops are still unchanged.
//
// Fail safe. An absent or unrecognized stored value resolves to
// 'manual' (nothing automated) and is reported once per process per
// tenant. After 46.0 every tenant has a row, so this is a guard,
// not a behavior: the migration's backfill, not this default, is
// what keeps an existing tenant's posture unchanged.
//
// 4.25111.64: the ENABLE_AUTO_POST switch (src/config/automation.js,
// default off). While it is off the auto-post state is not offered
// on this server: availableModes() lists the two lower states, the
// automation route refuses the third, and a tenant whose store still
// says auto-post is TREATED as auto-generate by readMode() (the
// generation half of its choice keeps running, the publishing half
// does not). The stored value is left exactly as it is: the tenant
// chose it, and when the operator turns the switch on it applies
// again with no one having to choose twice. The treatment is
// reported once per process per tenant, on the platform log with
// the tenant and on the tenant's own trail
// (automation_auto_post_unavailable). Routes and loops never read
// the switch; they read the treated state from here.
// ═══════════════════════════════════════════════════════════════

import { ENABLE_AUTO_POST_ENV, isAutoPostEnabled, currentAutoPostFlag } from "../config/automation.js";

export const MODES = Object.freeze(["manual", "auto-generate", "auto-post"]);
export const DEFAULT_MODE = "manual";
// What a stored auto-post is treated as while the switch is off:
// the highest state that does not publish.
const AUTO_POST_TREATED_AS = "auto-generate";

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
//
// 4.25111.64: options.autoPostEnabled, when given as false, treats a
// stored auto-post as AUTO_POST_TREATED_AS and says so (collapsed:
// true, stored: the value in the store). Not given, the
// interpretation is the pure one above, which is what the suites
// and any caller that already knows the switch's answer rely on.
// A corrupted store is never "collapsed": it is the fail-safe
// default whatever the switch says.
//
//   { mode, source: "stored" | "default", raw, stored, collapsed }
export function resolveMode(stored, options = undefined) {
  const switchedOff = !!options && typeof options === "object" && options.autoPostEnabled === false;
  if (isMode(stored)) {
    if (switchedOff && canAutoPublish(stored)) {
      return { mode: AUTO_POST_TREATED_AS, source: "stored", raw: stored, stored, collapsed: true };
    }
    return { mode: stored, source: "stored", raw: stored, stored, collapsed: false };
  }
  return { mode: DEFAULT_MODE, source: "default", raw: describeRaw(stored), stored: null, collapsed: false };
}

// The states this server offers right now: the three, or the two
// that do not publish while the ENABLE_AUTO_POST switch is off. A
// fresh array each call; the switch is read each call.
export function availableModes() {
  const enabled = isAutoPostEnabled();
  return MODES.filter((m) => enabled || !canAutoPublish(m));
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

// 4.25111.94 (owner's ruling, 2026-09-13): the paused flag FOLLOWS
// the mode. Choosing manual pauses the agent; choosing either
// automated state resumes it. Every writer of the mode (the
// automation route, the legacy shim, the registration seed) writes
// agent_state 'paused' from this function in the same transaction,
// so a mode change can never leave a workspace automated-but-paused.
// The value is the registry's boolean text ('true' / 'false').
//
// paused stays readable as its own key (readMode) and the loops
// still honor it first: a platform admin's "Set Agent Paused" or a
// direct write is an operator override that holds until the next
// mode change or the next override.
export function pausedForMode(mode) {
  return mode === "manual" ? "true" : "false";
}

// 4.25111.96 (defect D2, 2026-09-13): the state a person is SHOWN.
// The rule above makes pause and manual one lever, so a workspace
// whose paused flag is true behaves as manual whatever its stored
// mode says (both loops hold on the pause first, Force Cycle ends
// with "the agent is paused"). Until now the automation object
// reported the stored mode, so a workspace an operator had paused
// through "Set Agent Paused" showed AUTO-GENERATE with a live Force
// Cycle button that did nothing visible. The automation object now
// reports this function's answer as `mode` (storedMode still carries
// the store), the dashboard shows MANUAL, the button is disabled,
// and choosing AUTO-GENERATE resumes the workspace through the
// writers above. Reading presents; it never writes: the store is
// changed only by a mode choice or an operator.
//
// Only the boolean true pauses (readMode returns a boolean); any
// other value presents the mode as it is. Loops and gates do not
// call this: they read paused and mode separately, as before.
export function presentedMode(state) {
  return state && state.paused === true ? "manual" : state && state.mode;
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
//
// 4.25111.64: applies the ENABLE_AUTO_POST switch (read here on
// every call, never cached) and returns what the caller needs to
// say so: storedMode (the value in the store, null when it is not a
// canonical one), autoPostEnabled, and collapsed (true when a stored
// auto-post is being treated as auto-generate). The switch's own
// resolution is reported once per process (info when valid, warn
// when the value is not one of the four words) so an operator can
// read from the platform log whether automated publishing is on and
// why; a treated tenant is reported once per process per tenant.
//
//   { mode, source, raw, paused, storedMode, autoPostEnabled, collapsed }

const reportedDefaults = new Set();
const reportedTreated = new Set();
let reportedSwitch = false;

async function tenantIdOrNull() {
  const { currentTenantId } = await import("../db/with-tenant.js");
  try { return currentTenantId(); } catch { return null; }
}

async function reportSwitchOnce() {
  if (reportedSwitch) return;
  reportedSwitch = true;
  const flag = currentAutoPostFlag();
  const { platformLog } = await import("../services/platform-log.js");
  if (flag.valid) {
    platformLog("info", "auto_post_switch_resolved", { variable: ENABLE_AUTO_POST_ENV, enabled: flag.enabled, source: flag.source });
  } else {
    platformLog("warn", "auto_post_switch_invalid", { variable: ENABLE_AUTO_POST_ENV, raw: flag.raw, enabled: false, accepted: "yes, true, no, false" });
  }
}

export async function readMode() {
  const { getAgentState, logActivityBestEffort } = await import("../services/database.js");
  const stored = await getAgentState("mode");
  const autoPostEnabled = isAutoPostEnabled();
  await reportSwitchOnce();
  const resolved = resolveMode(stored, { autoPostEnabled });
  const pausedRaw = await getAgentState("paused");
  const paused = pausedRaw === "true";
  if (resolved.source === "default") {
    const tenantId = await tenantIdOrNull();
    const key = String(tenantId);
    if (!reportedDefaults.has(key)) {
      reportedDefaults.add(key);
      const { platformLog } = await import("../services/platform-log.js");
      platformLog("warn", "automation_mode_invalid_stored", { tenantId, raw: resolved.raw, using: resolved.mode });
      await logActivityBestEffort("warn", "automation_mode_invalid_stored", { raw: resolved.raw, using: resolved.mode });
    }
  }
  if (resolved.collapsed) {
    const tenantId = await tenantIdOrNull();
    const key = String(tenantId);
    if (!reportedTreated.has(key)) {
      reportedTreated.add(key);
      const { platformLog } = await import("../services/platform-log.js");
      const details = { stored: resolved.stored, using: resolved.mode, reason: "auto_post_disabled" };
      platformLog("warn", "automation_auto_post_unavailable", { tenantId, ...details });
      await logActivityBestEffort("warn", "automation_auto_post_unavailable", details);
    }
  }
  return {
    mode: resolved.mode, source: resolved.source, raw: resolved.raw, paused,
    storedMode: resolved.stored, autoPostEnabled, collapsed: resolved.collapsed
  };
}
