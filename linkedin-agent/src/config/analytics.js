// =================================================================
// src/config/analytics.js, Phase 1 analytics configuration
// =================================================================
// The ONE module in the analytics workstream allowed to carry
// literals (mirrors src/llm/model-profiles.js and config/research.js).
// Every default below is env-overridable via the named variable and
// validated on read; invalid values fall back LOUDLY to the default,
// never crash, never silently zero.
//
// Nothing in src/services or src/routes may hold these numbers or
// URLs directly; the hc scanners enforce that boundary.
// =================================================================

function intEnv(name, def, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[config/analytics] ${name}="${String(raw).slice(0, 40)}" invalid, using default ${def}`);
    return def;
  }
  return n;
}

// LinkedIn versioned REST base. https enforced at the client layer.
export function getLinkedInRestBase() {
  const raw = (process.env.LINKEDIN_REST_BASE || "").trim();
  return raw !== "" ? raw.replace(/\/+$/, "") : "https://api.linkedin.com/rest";
}

// Monthly API version header value (LinkedIn-Version). Versions
// sunset on a rolling schedule (Q2 2026 release notes), so this is
// operator-tunable configuration, never a code literal elsewhere.
export function getLinkedInApiVersion() {
  const raw = (process.env.LINKEDIN_API_VERSION || "").trim();
  if (/^\d{6}$/.test(raw)) return raw;
  if (raw !== "") {
    console.warn(`[config/analytics] LINKEDIN_API_VERSION="${raw.slice(0, 12)}" invalid (want YYYYMM), using default`);
  }
  return "202606";
}

// Per-vendor-call timeout for analytics endpoints.
// v2 API base (userinfo, connections). Literal lives here per the
// no-hardcoding rule; env-overridable like the REST base.
export function getLinkedInV2Base() {
  const raw = (process.env.LINKEDIN_V2_BASE || "https://api.linkedin.com/v2").trim();
  return raw.replace(/\/+$/, "");
}

export function getAnalyticsTimeoutMs() {
  return intEnv("ANALYTICS_TIMEOUT_MS", 15000, { min: 1000, max: 120000 });
}

// Max posts examined per tenant per sync pass (newest first).
export function getAnalyticsBatchSize() {
  return intEnv("ANALYTICS_SYNC_BATCH", 50, { min: 1, max: 500 });
}

// Delay between per-post stats calls (rate-limit courtesy).
export function getAnalyticsCallDelayMs() {
  return intEnv("ANALYTICS_CALL_DELAY_MS", 400, { min: 0, max: 10000 });
}

// Cron for the scheduled sync; validated by resolvePollSchedule at
// the call site. Default: every 6 hours.
export function getAnalyticsSyncCronRaw() {
  const raw = process.env.ANALYTICS_SYNC_CRON;
  return raw === undefined || String(raw).trim() === "" ? "0 */6 * * *" : raw;
}

// Cron for the token refresh check. Default: every 6 hours.
export function getTokenRefreshCronRaw() {
  const raw = process.env.TOKEN_REFRESH_CRON;
  return raw === undefined || String(raw).trim() === "" ? "30 */6 * * *" : raw;
}

// Refresh the access token this many hours BEFORE expiry.
export function getTokenRefreshBufferHours() {
  return intEnv("TOKEN_REFRESH_BUFFER_HOURS", 168, { min: 1, max: 24 * 60 });
}

// Reporting window defaults and caps (dashboard queries).
export function getDefaultWindowDays() {
  return intEnv("ANALYTICS_DEFAULT_WINDOW_DAYS", 30, { min: 1, max: 365 });
}
export function getMaxWindowDays() {
  return intEnv("ANALYTICS_MAX_WINDOW_DAYS", 365, { min: 1, max: 1095 });
}

// Narrative synthesis output cap and dataset cap (FR-P1-06).
export function getNarrativeMaxOutputTokens() {
  return intEnv("ANALYTICS_NARRATIVE_MAX_TOKENS", 900, { min: 100, max: 4000 });
}
export function getNarrativeDatasetCap() {
  return intEnv("ANALYTICS_NARRATIVE_DATASET_CAP", 60, { min: 5, max: 500 });
}

// Strict number policing for narratives (default OFF, mirrors
// METRIC_FIDELITY_STRICT). Citation-token integrity always applies.
export function isNarrativeStrict() {
  return String(process.env.ANALYTICS_NARRATIVE_STRICT || "").trim() === "1";
}
