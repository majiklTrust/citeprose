// =================================================================
// src/services/publish-target.js, publish author target resolution
// =================================================================
// One home for the personal-vs-organization authorship decision.
// Resolution precedence, highest first:
//   1. per-post override        (posts.publish_target column)
//   2. per-tenant setting       (agent_state key "publish_target")
//   3. environment default      (LINKEDIN_PUBLISH_TARGET)
//   4. "personal"               (the platform's historical default)
//
// The pure core (resolvePublishTarget) is testable with no
// environment. The async getter reads tenant state via lazy dynamic
// import (LLM-layer precedent) so this module loads DB-free.
// Only exact values pass validation; anything else is treated as
// unset at that layer and resolution falls through. Fail-safe is
// "personal": the platform never publishes as the organization
// because of a malformed value.
// =================================================================

const VALID_TARGETS = Object.freeze(["personal", "organization"]);

export function isValidPublishTarget(value) {
  return typeof value === "string" && VALID_TARGETS.includes(value);
}

// Pure resolution core. Every layer is validated independently;
// an invalid layer is skipped, never coerced.
export function resolvePublishTarget({ override, tenantSetting, envValue } = {}) {
  if (isValidPublishTarget(override)) return override;
  if (isValidPublishTarget(tenantSetting)) return tenantSetting;
  if (typeof envValue === "string" && isValidPublishTarget(envValue.trim().toLowerCase())) {
    return envValue.trim().toLowerCase();
  }
  return "personal";
}

// Tenant-aware getter. Runs inside withTenant when a tenant setting
// should apply; outside tenant context the state read is skipped
// and resolution falls through to the environment default, which
// preserves pre-toggle behavior exactly.
export async function getPublishTarget(deps = {}) {
  let tenantSetting = null;
  try {
    let getState = deps.getState;
    if (!getState) {
      const db = await import("./database.js");
      getState = db.getAgentState;
    }
    tenantSetting = await getState("publish_target");
  } catch {
    tenantSetting = null;
  }
  return resolvePublishTarget({
    override: null,
    tenantSetting,
    envValue: process.env.LINKEDIN_PUBLISH_TARGET
  });
}
