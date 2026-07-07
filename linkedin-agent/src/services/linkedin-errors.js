// =================================================================
// src/services/linkedin-errors.js, typed LinkedIn failure taxonomy
// =================================================================
// FR-CC-01: token expiry and scope denial are DIFFERENT failure
// modes and are never collapsed into one generic auth error. Every
// LinkedIn call in the analytics and token workstreams surfaces an
// LinkedInApiError with a code from LI_ERROR_CODES; callers branch
// on codes, never on message text, and routes map codes to HTTP.
//
// Leaf module: no imports. details stays log-safe: status, a hard-
// capped body snippet, and identifiers only. NEVER a token, NEVER
// request headers.
// =================================================================

export const LI_ERROR_CODES = Object.freeze({
  TOKEN_EXPIRED: "LINKEDIN_TOKEN_EXPIRED",     // 401: expired/revoked/invalid token
  SCOPE_DENIED: "LINKEDIN_SCOPE_DENIED",       // 403: grant lacks the permission
  RATE_LIMITED: "LINKEDIN_RATE_LIMITED",       // 429
  ENDPOINT_ERROR: "LINKEDIN_ENDPOINT_ERROR",   // other 4xx/5xx, schema/version errors
  NETWORK: "LINKEDIN_NETWORK",                 // timeout, DNS, TLS, abort
  NOT_CONNECTED: "LINKEDIN_NOT_CONNECTED"      // no stored credential for the tenant
});

const KNOWN = new Set(Object.values(LI_ERROR_CODES));
const BODY_SNIPPET_MAX = 200;

export class LinkedInApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LinkedInApiError";
    this.code = KNOWN.has(code) ? code : LI_ERROR_CODES.ENDPOINT_ERROR;
    this.details = details && typeof details === "object" ? details : {};
  }
}

export function liError(code, message, details) {
  return new LinkedInApiError(code, message, details);
}

export function isLinkedInApiError(err) {
  return err instanceof LinkedInApiError;
}

// Classify an HTTP failure from a LinkedIn endpoint into the
// taxonomy. bodyText is capped before it can reach any log line.
export function classifyLinkedInFailure(httpStatus, bodyText, endpoint = "") {
  const status = Number.isInteger(httpStatus) ? httpStatus : 0;
  const snippet = typeof bodyText === "string" ? bodyText.slice(0, BODY_SNIPPET_MAX) : "";
  const details = { status, endpoint: String(endpoint).slice(0, 120), bodySnippet: snippet };

  if (status === 401) {
    return new LinkedInApiError(LI_ERROR_CODES.TOKEN_EXPIRED,
      "LinkedIn rejected the access token (expired, revoked, or invalid)", details);
  }
  if (status === 403) {
    return new LinkedInApiError(LI_ERROR_CODES.SCOPE_DENIED,
      "LinkedIn denied the call: the granted scopes do not permit it", details);
  }
  if (status === 429) {
    return new LinkedInApiError(LI_ERROR_CODES.RATE_LIMITED,
      "LinkedIn rate limit reached for this endpoint", details);
  }
  return new LinkedInApiError(LI_ERROR_CODES.ENDPOINT_ERROR,
    `LinkedIn endpoint returned HTTP ${status}`, details);
}
