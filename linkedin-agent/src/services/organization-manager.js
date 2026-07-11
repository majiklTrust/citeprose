// =================================================================
// Organization Manager: per-tenant access flag for the Phase 1 +
// Phase 2 capability set (Analytics + Advocacy).
// =================================================================
// The setting lives in agent_state under the schema-registered key
// 'organization_manager' (enum: enabled | disabled, DDL 32).
//
// Semantics, deliberately asymmetric with future capability flags:
//   absent value        -> enabled  (existing tenants grandfathered)
//   'enabled'           -> enabled
//   'disabled' literal  -> disabled (the only value that turns off)
//   read failure        -> enabled  (a kill-switch must not break
//                                    the platform it protects)
// Requires tenant context (reads through the RLS-scoped client).
// =================================================================

import { platformLog } from "./platform-log.js";

export const ORGANIZATION_MANAGER_DISABLED_CODE = "ORGANIZATION_MANAGER_DISABLED";

export async function isOrganizationManagerEnabled() {
  try {
    const { getAgentState } = await import("./database.js");
    const value = await getAgentState("organization_manager");
    return value !== "disabled";
  } catch {
    return true;
  }
}

// Router-level guard for the analytics and advocacy APIs. Mounted
// with router.use() so every capability route inherits it; runs
// after resolveTenant, so tenant context is already established.
export async function requireOrganizationManager(req, res, next) {
  // The agent_state read is tenant-scoped: it MUST run inside
  // withTenant. Middleware executes before any handler establishes
  // context, so the guard establishes its own. Without this, the
  // read throws, the catch fails toward enabled, and the gate is
  // silently a no-op (the defect that shipped in 2.2.29).
  let enabled = true;
  try {
    const { withTenant } = await import("../db/with-tenant.js");
    enabled = await withTenant(req.tenant.id, () => isOrganizationManagerEnabled());
  } catch (err) {
    platformLog("error", "organization_manager_gate_error", { error: err.message });
  }
  if (enabled) return next();
  platformLog("info", "organization_manager_blocked", { path: req.path });
  return res.status(403).json({
    error: "Organization Manager is disabled for this workspace",
    code: ORGANIZATION_MANAGER_DISABLED_CODE
  });
}
