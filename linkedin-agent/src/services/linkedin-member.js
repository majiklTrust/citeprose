// =================================================================
// src/services/linkedin-member.js, member OAuth URL + reach fetch
// =================================================================
// The member leg of the single OAuth flow (TD-2): same app
// credentials, same registered redirect URI, the MEMBER scope set
// (6), and a signed member state. Also fetches the member's
// first-degree connections size (FR-P2-05 input) from the v2 API.
//
// Import discipline: config and errors only at top level; app
// credential getters load lazily; the fetch takes injected deps so
// everything here is testable DB-free and network-free.
// =================================================================

import { LINKEDIN_MEMBER_OAUTH_SCOPES } from "../config/linkedin-scopes.js";
import { getLinkedInV2Base, getAnalyticsTimeoutMs } from "../config/analytics.js";
import { LI_ERROR_CODES, liError, classifyLinkedInFailure } from "./linkedin-errors.js";

const LINKEDIN_AUTH = "https://www.linkedin.com/oauth/v2";

// deps: { clientId, redirectUri } injectable for tests; defaults
// resolve through the tenant-first app-credential layer (TD-1), so
// this MUST run inside withTenant when a tenant override exists.
export async function buildMemberAuthorizationUrl(state, deps = {}) {
  if (typeof state !== "string" || state.length === 0) {
    throw new Error("member authorization requires a signed state");
  }
  let clientId = deps.clientId;
  let redirectUri = deps.redirectUri;
  if (!clientId || !redirectUri) {
    const app = await import("./linkedin-app-credentials.js");
    clientId = clientId || await app.getTenantLinkedInClientId();
    redirectUri = redirectUri || await app.getTenantLinkedInRedirectUri();
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: LINKEDIN_MEMBER_OAUTH_SCOPES.join(" "),
    state
  });
  return `${LINKEDIN_AUTH}/authorization?${params}`;
}

// -- Egress guard (same policy as the analytics client) ----------
function assertMemberUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "member API URL is not a valid URL");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "member API refuses non-https egress");
  }
  if (parsed.username || parsed.password) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "member API refuses URL-embedded credentials");
  }
}

// First-degree connections size via GET /v2/connections?q=viewer
// with count=0: the answer rides paging.total. Returns a
// non-negative integer, or null when the payload does not carry a
// usable total (unknown is never coerced to zero, FR-CC-07 spirit).
export function mapConnectionsSize(raw) {
  const total = raw && typeof raw === "object" && raw.paging && typeof raw.paging === "object"
    ? raw.paging.total
    : undefined;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? Math.floor(total) : null;
}

export async function fetchConnectionsSize(accessToken, deps = {}) {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw liError(LI_ERROR_CODES.NOT_CONNECTED, "connections size requires the member access token");
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const base = deps.base || getLinkedInV2Base();
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : getAnalyticsTimeoutMs();

  const url = `${base}/connections?q=viewer&start=0&count=0`;
  assertMemberUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0"
      },
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw liError(LI_ERROR_CODES.NETWORK, "connections size network failure", {
      endpoint: "/connections", cause: err?.name || "fetch_failed"
    });
  }
  clearTimeout(timer);

  if (!response.ok) {
    let body = "";
    try { body = await response.text(); } catch { body = ""; }
    throw classifyLinkedInFailure(response.status, body, "/connections");
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "connections response unparseable", {
      endpoint: "/connections", status: response.status
    });
  }
  return mapConnectionsSize(json);
}

// -- Basic profile (name + headline, r_basicprofile) --------------
// TD-4 inputs, captured best-effort at connect time. Unknown maps
// to null, never an empty-string identity.
export function mapBasicProfile(raw) {
  if (!raw || typeof raw !== "object") return { name: null, headline: null };
  const first = typeof raw.localizedFirstName === "string" ? raw.localizedFirstName.trim() : "";
  const last = typeof raw.localizedLastName === "string" ? raw.localizedLastName.trim() : "";
  const name = `${first} ${last}`.trim();
  const headline = typeof raw.localizedHeadline === "string" && raw.localizedHeadline.trim().length > 0
    ? raw.localizedHeadline.trim() : null;
  return { name: name.length > 0 ? name : null, headline };
}

export async function fetchBasicProfile(accessToken, deps = {}) {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw liError(LI_ERROR_CODES.NOT_CONNECTED, "basic profile requires the member access token");
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const base = deps.base || getLinkedInV2Base();
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : getAnalyticsTimeoutMs();

  const url = `${base}/me?projection=(localizedFirstName,localizedLastName,localizedHeadline)`;
  assertMemberUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0"
      },
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw liError(LI_ERROR_CODES.NETWORK, "basic profile network failure", {
      endpoint: "/me", cause: err?.name || "fetch_failed"
    });
  }
  clearTimeout(timer);

  if (!response.ok) {
    let body = "";
    try { body = await response.text(); } catch { body = ""; }
    throw classifyLinkedInFailure(response.status, body, "/me");
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "basic profile response unparseable", {
      endpoint: "/me", status: response.status
    });
  }
  return mapBasicProfile(json);
}
