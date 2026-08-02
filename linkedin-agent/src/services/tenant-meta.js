// =================================================================
// src/services/tenant-meta.js - per-tenant readiness flags (2.6.1)
// =================================================================
// A compact bitwise summary of workspace readiness, computed by a
// quick lookup right after a successful authentication (the
// dashboard's first authenticated call is GET /api/status) and
// delivered as status.tenantMeta. The dashboard checks the flag at
// CTA activation time (Generate / Create) to warn BEFORE a content
// generation workflow is invoked without a stored LLM vendor key.
//
// This is a UX affordance, not a security gate. The authoritative
// enforcement stays where it always was: generation fails server
// side without a decryptable credential. Because of that, probe
// FAILURES fail OPEN here (flag reads as present) per the AUDIT F2
// precedent in routes/api.js: a transient read failure must never
// paint a warning over a provisioned tenant's dashboard.
//
// Flag bits (MIRROR SEAM: the same values exist as constants in
// public_templates/index.html; any change to a bit here moves BOTH
// files in the SAME delivery, the one-script-moves-all-lists rule
// that governs the provider enum mirrors):
//   LLM_KEY_PRESENT  1 << 0  the tenant's ACTIVE text vendor has a
//                            stored API key (existence probe only,
//                            nothing is decrypted)
// Future bits append here; consumers must mask, never compare
// equality on the whole integer.
//
// Import discipline: DB modules load lazily so this module imports
// cleanly anywhere (module-loads-DB-free). getTenantMeta must run
// inside a withTenant block; deps are injectable for DB-free tests.
// =================================================================

export const TENANT_FLAG = Object.freeze({
  LLM_KEY_PRESENT: 1 << 0
});

// Pure core: probe results -> flags integer. Hostile or partial
// input contributes nothing: only an OWN-property strict boolean
// true sets a bit, so a string, an array, a truthy non-boolean, or
// a prototype-poisoned object can never mint readiness.
export function computeTenantFlags(probe) {
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) return 0;
  let flags = 0;
  if (Object.prototype.hasOwnProperty.call(probe, "llmKeyPresent") &&
      probe.llmKeyPresent === true) {
    flags |= TENANT_FLAG.LLM_KEY_PRESENT;
  }
  return flags;
}

// ── Default dependencies (lazy: DB modules load on first use) ──

async function defaultGetState(key) {
  const { getAgentState } = await import("./database.js");
  return getAgentState(key);
}

async function defaultHasLlmKey(providerId) {
  const { hasLlmApiKey } = await import("../tenant/credential-store.js");
  return hasLlmApiKey(providerId);
}

async function defaultLog(level, event, detail) {
  const { platformLog } = await import("./platform-log.js");
  return platformLog(level, event, detail);
}

// Resolves the ACTIVE text vendor exactly the way the orchestrator
// does its compatibility default: agent_state llm_provider when
// set, otherwise "anthropic". Model resolution is irrelevant here;
// only the credential row for the active provider matters.
function activeProviderFrom(rawState) {
  const id = typeof rawState === "string" ? rawState.trim() : "";
  return id || "anthropic";
}

// Computes the meta object for the current tenant. Must be called
// inside withTenant(). Never throws: every failure path degrades
// to fail-open flags with a logged event, so /api/status can call
// it unguarded.
export async function getTenantMeta(deps = {}) {
  const d = {
    getState: deps.getState || defaultGetState,
    hasLlmKey: deps.hasLlmKey || defaultHasLlmKey,
    log: deps.log || defaultLog
  };

  let llmProvider = "anthropic";
  let llmKeyPresent;
  try {
    llmProvider = activeProviderFrom(await d.getState("llm_provider"));
    // Existence probe only (SELECT 1). A clean false is the real
    // "no key" answer; a throw is infrastructure or an unknown
    // provider id and fails open below.
    llmKeyPresent = (await d.hasLlmKey(llmProvider)) === true;
  } catch (err) {
    try {
      await d.log("warn", "tenant_meta_probe_failed", {
        provider: llmProvider,
        error: err && err.message ? err.message : String(err)
      });
    } catch { /* the failure path never throws */ }
    llmKeyPresent = true; // fail open: warn UX must not block a provisioned tenant
  }

  return Object.freeze({
    flags: computeTenantFlags({ llmKeyPresent }),
    llmProvider
  });
}
