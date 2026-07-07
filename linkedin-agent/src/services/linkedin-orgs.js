// =================================================================
// src/services/linkedin-orgs.js, organization discovery (ACLs)
// =================================================================
// Discovers which LinkedIn organization pages the connected member
// administers, via GET /rest/organizationAcls?q=roleAssignee.
// The response is untrusted vendor input: the pure mapper
// (mapAdministeredOrgs) accepts only entries that are ADMINISTRATOR,
// APPROVED, carry a well-formed organization URN, AND name the
// connected person as roleAssignee. The roleAssignee check is the
// security property: a token can never get a foreign organization
// attached to this tenant because the vendor payload said so.
//
// Import discipline: config and errors only (both pure). The fetch
// takes injected deps like the analytics client, so the module is
// testable DB-free and network-free.
// =================================================================

import { getLinkedInRestBase, getLinkedInApiVersion, getAnalyticsTimeoutMs } from "../config/analytics.js";
import { LI_ERROR_CODES, liError, classifyLinkedInFailure } from "./linkedin-errors.js";
import { isOrganizationUrn } from "./linkedin-analytics.js";

const PERSON_URN_RE = /^urn:li:person:[A-Za-z0-9_-]+$/;

export function isPersonUrn(urn) {
  return typeof urn === "string" && PERSON_URN_RE.test(urn);
}

// -- Pure mapper -------------------------------------------------
// Returns [{ orgUrn }] for entries this person administers.
// Junk entries are skipped, never thrown on; a payload without an
// elements array is a typed endpoint error (schema violation).
export function mapAdministeredOrgs(raw, personUrn) {
  if (!isPersonUrn(personUrn)) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "organization discovery requires the connected person URN");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.elements)) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "organizationAcls response missing elements array");
  }
  const orgs = [];
  const seen = new Set();
  for (const entry of raw.elements) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.role !== "ADMINISTRATOR") continue;
    if (entry.state !== "APPROVED") continue;
    if (entry.roleAssignee !== personUrn) continue;
    if (!isOrganizationUrn(entry.organization)) continue;
    if (seen.has(entry.organization)) continue;
    seen.add(entry.organization);
    orgs.push({ orgUrn: entry.organization });
  }
  return orgs;
}

// -- URL builder -------------------------------------------------
export function buildOrgAclsUrl(base = getLinkedInRestBase()) {
  return `${base}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`;
}

// -- Egress guard (same policy as the analytics client) ----------
function assertOrgsUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "organization discovery URL is not a valid URL");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "organization discovery refuses non-https egress");
  }
  if (parsed.username || parsed.password) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "organization discovery refuses URL-embedded credentials");
  }
}

// -- Fetch -------------------------------------------------------
// deps: { fetchImpl, base, apiVersion, timeoutMs } all optional.
export async function fetchAdministeredOrgs(accessToken, personUrn, deps = {}) {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw liError(LI_ERROR_CODES.NOT_CONNECTED, "organization discovery requires an access token");
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const base = deps.base || getLinkedInRestBase();
  const apiVersion = deps.apiVersion || getLinkedInApiVersion();
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : getAnalyticsTimeoutMs();

  const url = buildOrgAclsUrl(base);
  assertOrgsUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": apiVersion,
        "X-Restli-Protocol-Version": "2.0.0"
      },
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw liError(LI_ERROR_CODES.NETWORK, "organization discovery network failure", {
      endpoint: "/organizationAcls", cause: err?.name || "fetch_failed"
    });
  }
  clearTimeout(timer);

  if (!response.ok) {
    let body = "";
    try { body = await response.text(); } catch { body = ""; }
    throw classifyLinkedInFailure(response.status, body, "/organizationAcls");
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "organizationAcls returned unparseable JSON", {
      endpoint: "/organizationAcls", status: response.status
    });
  }
  return mapAdministeredOrgs(json, personUrn);
}
