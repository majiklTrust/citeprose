// ═══════════════════════════════════════════════════════════════
// automation-api.js: the automation state and its settings
// ═══════════════════════════════════════════════════════════════
// 4.25111.60. Mounted at /api/automation, ahead of api.js (whose
// existence guard 404s any /api/* path it does not itself register),
// wired like the other feature routers: authenticated, tenant
// scoped, read-only outside good standing, no-store.
//
//   POST /api/automation/mode      { mode }  canonical vocabulary only
//   PUT  /api/automation/settings  { reviewWindowHours?, holdWhilePending? }
//   GET  /api/automation/state     the automation object /api/status carries
//
// Writes need change_mode (the same permission the two-way toggle
// has always needed; rules and slots will ride the same one). The
// stored value is always canonical; the legacy vocabulary is the
// business of the /api/mode shim in api.js and never accepted here.
// Every write leaves an attributed trail line and a platform log
// row with the tenant.
//
// 4.25111.64: the ENABLE_AUTO_POST switch. A state the server does
// not offer right now (auto-post while the switch is off) is refused
// with 400 AUTO_POST_DISABLED, through the interpreter's
// availableModes() so this file never names a mode. The refusal
// writes nothing, and is logged (a client asked for a state the
// operator has switched off; the dashboard never offers it). The
// state object carries autoPostEnabled, which the dashboard reads
// from GET /state to decide whether the auto-post choice exists on
// the page at all, and storedMode, so an operator can see a store
// that says auto-post being treated as auto-generate.
// ═══════════════════════════════════════════════════════════════

import { suspendedWriteGuard } from "../services/entitlements.js";
import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { setAgentState, logActivity, logActivityBestEffort } from "../services/database.js";
import { MODES, isMode, readMode, canAutoGenerate, canAutoPublish, availableModes } from "../automation/automation-mode.js";
import { readAutomationSettings, parseReviewWindowHours, parseHoldWhilePending, SETTING_KEYS, REVIEW_WINDOW_MAX_HOURS } from "../automation/settings.js";

const router = Router();

const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();

router.use(requireAuth);
router.use(resolveTenant);
// Payments ruling (3): outside good standing the tenant is read-only.
router.use(suspendedWriteGuard());
// Tenant-derived state is never cacheable.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// The automation object, read inside a tenant scope.
async function automationObject() {
  const state = await readMode();
  const settings = await readAutomationSettings();
  return {
    mode: state.mode,
    generation: canAutoGenerate(state.mode),
    publishing: canAutoPublish(state.mode),
    paused: state.paused,
    source: state.source,
    reviewWindowHours: settings.reviewWindowHours,
    holdWhilePending: settings.holdWhilePending,
    autoPostEnabled: state.autoPostEnabled,
    storedMode: state.storedMode
  };
}

function logRouteError(req, err, action) {
  platformLog("error", "api_error", {
    path: req.originalUrl || req.path, method: req.method, action,
    tenantId: req.tenant ? req.tenant.id : null, sub: req.user ? req.user.sub : null, error: err.message
  });
}

router.get("/state", async (req, res) => {
  try {
    const automation = await withTenant(req.tenant.id, automationObject);
    res.json({ automation });
  } catch (err) {
    logRouteError(req, err, "automation_state");
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/mode", requirePermission("change_mode"), async (req, res) => {
  try {
    const mode = req.body && typeof req.body === "object" ? req.body.mode : undefined;
    if (!isMode(mode)) {
      return res.status(400).json({ error: `mode must be one of ${MODES.join(", ")}`, code: "INVALID_MODE" });
    }
    if (!availableModes().includes(mode)) {
      // Offered nowhere on this server right now. The dashboard never
      // shows the choice, so this answers clients only, in the same
      // voice as INVALID_MODE above.
      platformLog("info", "automation_mode_refused", { tenantId: req.tenant.id, requested: mode, reason: "auto_post_disabled", sub: req.user?.sub || null });
      await withTenant(req.tenant.id, () => logActivityBestEffort("info", "automation_mode_refused", { requested: mode, reason: "auto_post_disabled" }, req.user?.sub || null));
      return res.status(400).json({ error: `${mode} is not enabled on this server`, code: "AUTO_POST_DISABLED" });
    }
    const automation = await withTenant(req.tenant.id, async () => {
      const before = await readMode();
      await setAgentState("mode", mode);
      await logActivity("info", "automation_mode_changed", { from: before.mode, to: mode, via: "automation_api" }, req.user?.sub || null);
      return automationObject();
    });
    platformLog("info", "automation_mode_changed", { tenantId: req.tenant.id, to: mode, via: "automation_api", sub: req.user?.sub || null });
    res.json({ automation });
  } catch (err) {
    logRouteError(req, err, "automation_mode");
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// Settings are accepted as JSON numbers and booleans only: a numeric
// string is refused here even though the store keeps text, so a
// client cannot smuggle "12abc" or " 12" past the registry's shape.
router.put("/settings", requirePermission("change_mode"), async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const changes = {};
    if (Object.prototype.hasOwnProperty.call(body, "reviewWindowHours")) {
      const v = body.reviewWindowHours;
      const parsed = typeof v === "number" ? parseReviewWindowHours(v) : null;
      if (parsed === null) {
        return res.status(400).json({ error: `reviewWindowHours must be an integer from 0 to ${REVIEW_WINDOW_MAX_HOURS}`, code: "INVALID_SETTING", setting: "reviewWindowHours" });
      }
      changes.reviewWindowHours = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(body, "holdWhilePending")) {
      const v = body.holdWhilePending;
      const parsed = typeof v === "boolean" ? parseHoldWhilePending(v) : null;
      if (parsed === null) {
        return res.status(400).json({ error: "holdWhilePending must be true or false", code: "INVALID_SETTING", setting: "holdWhilePending" });
      }
      changes.holdWhilePending = parsed;
    }
    if (Object.keys(changes).length === 0) {
      return res.status(400).json({ error: "nothing to set: provide reviewWindowHours and/or holdWhilePending", code: "INVALID_SETTING" });
    }
    const automation = await withTenant(req.tenant.id, async () => {
      const before = await readAutomationSettings();
      if (changes.reviewWindowHours !== undefined) await setAgentState(SETTING_KEYS.reviewWindowHours, String(changes.reviewWindowHours));
      if (changes.holdWhilePending !== undefined) await setAgentState(SETTING_KEYS.holdWhilePending, String(changes.holdWhilePending));
      await logActivity("info", "automation_settings_changed", {
        changes, before: { reviewWindowHours: before.reviewWindowHours, holdWhilePending: before.holdWhilePending }
      }, req.user?.sub || null);
      return automationObject();
    });
    platformLog("info", "automation_settings_changed", { tenantId: req.tenant.id, changes, sub: req.user?.sub || null });
    res.json({ automation });
  } catch (err) {
    logRouteError(req, err, "automation_settings");
    res.status(500).json({ error: "An internal error occurred" });
  }
});

export default router;
