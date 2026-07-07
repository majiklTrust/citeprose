// =================================================================
// src/services/linkedin-token.js, proactive token renewal (FR-CC-03)
// =================================================================
// The 2.1.0 base has NO refresh flow: tokens die and renewal is a
// manual re-run of /auth/linkedin. This service closes that gap.
//
// Model:
//   - The OAuth callback stores linkedin_refresh_token (encrypted,
//     per tenant) and writes linkedin_token_expires_at plus
//     linkedin_refresh_expires_at (epoch seconds) into agent_state.
//   - A cron (config: TOKEN_REFRESH_CRON) walks active tenants; a
//     tenant whose access token expires inside the buffer window
//     (config: TOKEN_REFRESH_BUFFER_HOURS) is refreshed via the
//     refresh_token grant. Rotated refresh tokens replace the
//     stored one atomically inside the same withTenant transaction.
//   - Failures are classified (FR-CC-01): an expired/invalid
//     refresh token logs linkedin_token_expired; a scope problem
//     logs linkedin_scope_denied. Distinct actions, never one
//     generic auth error. A failing tenant never aborts the batch.
//   - When the REFRESH token itself is past expiry, no call is
//     made: the tenant needs full re-authorization, and that state
//     is logged loudly as linkedin_reauthorization_required.
//
// Pure decision logic (shouldRefreshNow) is exported for the test
// suite; wiring stays thin. No token value ever reaches a log.
// =================================================================

// Import discipline (LLM-layer precedent): DB-touching modules
// (with-tenant, platform-db, credential-store, database,
// linkedin-api) arrive via lazy dynamic import inside the functions
// that need them, so this module LOADS with no database environment
// and the pure decision core is testable DB-free.
import { classifyLinkedInFailure, liError, LI_ERROR_CODES } from "./linkedin-errors.js";
import { getTokenRefreshCronRaw, getTokenRefreshBufferHours } from "../config/analytics.js";
import { resolvePollSchedule } from "../config/poll-schedule.js";
import { platformLog } from "./platform-log.js";

// ── Pure decision core ────────────────────────────────────────
// Given epoch-second expiries and "now", decide the action:
//   refresh          access token inside the buffer window
//   skip             plenty of runway, do nothing
//   reauthorize      refresh token itself expired (or unknown while
//                    the access token is due): a grant call cannot
//                    succeed, a human must re-run /auth/linkedin
// Unknown access expiry with a live refresh token refreshes once to
// establish bookkeeping rather than guessing.
export function shouldRefreshNow({ accessExpiresAt, refreshExpiresAt, nowSeconds, bufferHours }) {
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  const buffer = (Number.isFinite(bufferHours) ? bufferHours : 0) * 3600;
  const refreshDead = Number.isFinite(refreshExpiresAt) && refreshExpiresAt <= now;
  const accessDue = !Number.isFinite(accessExpiresAt) || accessExpiresAt <= now + buffer;

  if (refreshDead) return { action: "reauthorize", reason: "refresh token expired" };
  if (!accessDue) return { action: "skip", reason: "access token outside buffer window" };
  return { action: "refresh", reason: Number.isFinite(accessExpiresAt)
    ? "access token inside buffer window"
    : "access expiry unknown, establishing bookkeeping" };
}

function toEpochSeconds(stateValue) {
  const n = parseInt(String(stateValue ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Per-tenant refresh (runs INSIDE withTenant) ───────────────
// deps are injectable for the test suite; production uses defaults.
export async function refreshTenantToken(deps = {}) {
  const d = {
    bufferHours: getTokenRefreshBufferHours(),
    nowSeconds: Math.floor(Date.now() / 1000),
    tenantId: null,
    ...deps
  };
  // DB-touching defaults load lazily; injected test deps skip them.
  if (!d.getRefreshToken || !d.hasRefreshToken || !d.store) {
    const cs = await import("../tenant/credential-store.js");
    d.getRefreshToken = d.getRefreshToken || cs.getLinkedInRefreshToken;
    d.hasRefreshToken = d.hasRefreshToken || cs.hasLinkedInRefreshToken;
    d.store = d.store || cs.storeCredential;
  }
  if (!d.getState || !d.setState || !d.log) {
    const db = await import("./database.js");
    d.getState = d.getState || db.getAgentState;
    d.setState = d.setState || db.setAgentState;
    d.log = d.log || db.logActivity;
  }
  if (!d.refreshGrant || !d.invalidateCache) {
    const la = await import("./linkedin-api.js");
    d.refreshGrant = d.refreshGrant || la.refreshAccessToken;
    d.invalidateCache = d.invalidateCache || la.invalidateTokenCache;
  }

  if (!(await d.hasRefreshToken())) {
    return { status: "no_refresh_token" };
  }

  const accessExpiresAt = toEpochSeconds(await d.getState("linkedin_token_expires_at"));
  const refreshExpiresAt = toEpochSeconds(await d.getState("linkedin_refresh_expires_at"));
  const decision = shouldRefreshNow({
    accessExpiresAt, refreshExpiresAt,
    nowSeconds: d.nowSeconds, bufferHours: d.bufferHours
  });

  if (decision.action === "skip") {
    return { status: "skipped", reason: decision.reason };
  }
  if (decision.action === "reauthorize") {
    await d.log("error", "linkedin_reauthorization_required", {
      reason: decision.reason, refreshExpiresAt
    });
    return { status: "reauthorization_required" };
  }

  // refresh
  let tokens;
  try {
    const refreshToken = await d.getRefreshToken();
    tokens = await d.refreshGrant(refreshToken);
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data ? JSON.stringify(err.response.data) : "";
    const classified = Number.isInteger(status)
      ? classifyLinkedInFailure(status, body, "oauth/accessToken")
      : liError(LI_ERROR_CODES.NETWORK, "LinkedIn token refresh network failure",
          { cause: err?.name || "Error" });
    // Distinct actions per FR-CC-01: expiry vs scope vs the rest.
    const action = classified.code === LI_ERROR_CODES.TOKEN_EXPIRED
      ? "linkedin_token_expired"
      : classified.code === LI_ERROR_CODES.SCOPE_DENIED
        ? "linkedin_scope_denied"
        : "linkedin_token_refresh_failed";
    // OAuth endpoint bodies can echo grant material; log the
    // classification only, never the body. No token, ever.
    await d.log("error", action, {
      code: classified.code,
      status: classified.details.status ?? null,
      endpoint: classified.details.endpoint || "oauth/accessToken"
    });
    return { status: "failed", code: classified.code };
  }

  if (!tokens || typeof tokens.accessToken !== "string" || tokens.accessToken.length === 0) {
    await d.log("error", "linkedin_token_refresh_failed", {
      code: LI_ERROR_CODES.ENDPOINT_ERROR, reason: "grant returned no access token"
    });
    return { status: "failed", code: LI_ERROR_CODES.ENDPOINT_ERROR };
  }

  // Persist inside the SAME transaction the caller opened: the new
  // access token, the rotated refresh token when LinkedIn returns
  // one, and both expiry bookmarks.
  await d.store("linkedin_access_token", tokens.accessToken);
  if (typeof tokens.refreshToken === "string" && tokens.refreshToken.length > 0) {
    await d.store("linkedin_refresh_token", tokens.refreshToken);
  }
  if (Number.isFinite(tokens.expiresIn)) {
    await d.setState("linkedin_token_expires_at", String(d.nowSeconds + tokens.expiresIn));
  }
  if (Number.isFinite(tokens.refreshTokenExpiresIn)) {
    await d.setState("linkedin_refresh_expires_at", String(d.nowSeconds + tokens.refreshTokenExpiresIn));
  }
  if (d.tenantId) d.invalidateCache(d.tenantId);

  await d.log("info", "linkedin_token_refreshed", {
    expiresInSeconds: tokens.expiresIn ?? null,
    refreshTokenRotated: !!tokens.refreshToken
  });
  return { status: "refreshed" };
}

// ── Batch over active tenants ─────────────────────────────────
export async function runTokenRefreshBatch() {
  let tenants = [];
  try {
    const { listActiveTenants } = await import("../tenant/platform-db.js");
    tenants = await listActiveTenants();
  } catch (err) {
    platformLog("error", "token_refresh_tenant_list_failed", { error: err.message });
    return { refreshed: 0, failed: 0, skipped: 0 };
  }
  const { withTenant } = await import("../db/with-tenant.js");
  const summary = { refreshed: 0, failed: 0, skipped: 0 };
  for (const tenant of tenants) {
    try {
      const result = await withTenant(tenant.id, () =>
        refreshTenantToken({ tenantId: tenant.id })
      );
      if (result.status === "refreshed") summary.refreshed++;
      else if (result.status === "failed" || result.status === "reauthorization_required") summary.failed++;
      else summary.skipped++;
    } catch (err) {
      summary.failed++;
      platformLog("error", "token_refresh_tenant_failed", {
        tenant: tenant.slug, error: err.message
      });
    }
  }
  return summary;
}

// ── Cron wiring ───────────────────────────────────────────────
export async function startTokenRefresher() {
  const { default: cron } = await import("node-cron");
  const schedule = resolvePollSchedule(getTokenRefreshCronRaw());
  if (!schedule.valid) {
    platformLog("warn", "token_refresh_cron_invalid", {
      rejected: schedule.rejected, using: schedule.expression
    });
  }
  platformLog("info", "token_refresher_started", {
    schedule: schedule.expression, source: schedule.source,
    bufferHours: getTokenRefreshBufferHours()
  });
  cron.schedule(schedule.expression, async () => {
    const summary = await runTokenRefreshBatch();
    platformLog("info", "token_refresh_batch_complete", summary);
  });
  // Initial sweep so a restart never waits a full period while a
  // token sits inside the buffer window.
  runTokenRefreshBatch()
    .then((summary) => platformLog("info", "token_refresh_initial_sweep", summary))
    .catch((err) => platformLog("error", "token_refresh_initial_sweep_failed", { error: err.message }));
}
