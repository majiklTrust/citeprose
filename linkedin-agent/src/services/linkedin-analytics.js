// =================================================================
// src/services/linkedin-analytics.js, versioned REST metrics client
// =================================================================
// Reads organization share statistics (per published post) and
// follower demographic statistics through LinkedIn's versioned
// REST surface, per the signed-off advisory to route metrics under
// r_organization_admin (organizationalEntityShareStatistics and
// organizationalFollowerStatistics).
//
// Boundaries:
//   - Base URL and LinkedIn-Version come from src/config/analytics
//     only; nothing here carries an endpoint literal.
//   - https is enforced before any call (loopback http tolerated
//     for a local mock during testing, mirroring src/llm/security).
//   - Failures classify through linkedin-errors (FR-CC-01); a raw
//     vendor body is truncated before it can reach a log.
//   - Values are returned EXACTLY as LinkedIn supplied them; a
//     missing field maps to null, never 0 (FR-CC-07 / FR-P1-07).
//   - No token is ever logged or attached to an error.
//
// Restli 2.0 note: the share URN travels inside a List() literal
// with the URN percent-encoded; one post per call keeps encoding
// simple and rate behavior predictable. deps.fetchImpl is
// injectable for the test suite.
// =================================================================

import {
  getLinkedInRestBase, getLinkedInApiVersion, getAnalyticsTimeoutMs
} from "../config/analytics.js";
import { classifyLinkedInFailure, liError, LI_ERROR_CODES } from "./linkedin-errors.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

function assertAnalyticsUrl(urlString) {
  let url;
  try { url = new URL(urlString); } catch {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "Analytics URL is not parseable");
  }
  const httpsOk = url.protocol === "https:";
  const loopbackOk = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (!httpsOk && !loopbackOk) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "Analytics scheme not permitted",
      { host: url.host });
  }
  if (url.username || url.password) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "Analytics URL carries credentials",
      { host: url.host });
  }
  return url;
}

// A post URN must be exactly a share or ugcPost URN; anything else
// (spaces, quotes, injection attempts, junk rows) fails closed.
const POST_URN_RE = /^urn:li:(share|ugcPost):[A-Za-z0-9_-]+$/;
export function isPublishedPostUrn(urn) {
  return typeof urn === "string" && POST_URN_RE.test(urn);
}
const ORG_URN_RE = /^urn:li:organization:[A-Za-z0-9_-]+$/;
export function isOrganizationUrn(urn) {
  return typeof urn === "string" && ORG_URN_RE.test(urn);
}

// ── URL builders (pure, exported for the test suite) ──────────
export function buildShareStatsUrl(orgUrn, postUrn, base = getLinkedInRestBase()) {
  if (!isOrganizationUrn(orgUrn)) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "Invalid organization URN");
  }
  if (!isPublishedPostUrn(postUrn)) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "Invalid post URN");
  }
  const facet = postUrn.startsWith("urn:li:ugcPost:") ? "ugcPosts" : "shares";
  const entity = encodeURIComponent(orgUrn);
  const listArg = `List(${encodeURIComponent(postUrn)})`;
  return `${base}/organizationalEntityShareStatistics`
    + `?q=organizationalEntity&organizationalEntity=${entity}&${facet}=${listArg}`;
}

export function buildFollowerStatsUrl(orgUrn, base = getLinkedInRestBase()) {
  if (!isOrganizationUrn(orgUrn)) {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR, "Invalid organization URN");
  }
  return `${base}/organizationalFollowerStatistics`
    + `?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}`;
}

// ── Response mappers (pure, exported for the test suite) ──────
// Exact-value discipline: read the documented field, keep null when
// absent, never coerce a missing count into 0.
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function mapShareStatistics(raw) {
  const el = raw && Array.isArray(raw.elements) ? raw.elements[0] : null;
  const t = el && typeof el === "object" ? el.totalShareStatistics : null;
  if (!t || typeof t !== "object") {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR,
      "Share statistics response carried no totalShareStatistics");
  }
  return {
    impressions: numOrNull(t.impressionCount),
    clicks: numOrNull(t.clickCount),
    likes: numOrNull(t.likeCount),
    comments: numOrNull(t.commentCount),
    shares: numOrNull(t.shareCount)
  };
}

function facetCount(entry) {
  const fc = entry && typeof entry === "object" ? entry.followerCounts : null;
  const organic = numOrNull(fc?.organicFollowerCount) ?? 0;
  const paid = numOrNull(fc?.paidFollowerCount) ?? 0;
  return organic + paid;
}

export function mapFollowerStatistics(raw) {
  const el = raw && Array.isArray(raw.elements) ? raw.elements[0] : null;
  if (!el || typeof el !== "object") {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR,
      "Follower statistics response carried no elements");
  }
  const rows = [];
  const push = (facet, arr, entityField) => {
    if (!Array.isArray(arr)) return;
    for (const entry of arr) {
      const entity = entry && typeof entry[entityField] === "string" ? entry[entityField] : null;
      if (!entity) continue;
      rows.push({ facet, entity, label: null, followerCount: facetCount(entry) });
    }
  };
  push("industry", el.followerCountsByIndustry, "industry");
  push("seniority", el.followerCountsBySeniority, "seniority");
  push("geo", el.followerCountsByGeoCountry || el.followerCountsByGeo, "geo");
  return rows;
}

// ── HTTP core ─────────────────────────────────────────────────
async function liGet(urlString, accessToken, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const timeoutMs = deps.timeoutMs || getAnalyticsTimeoutMs();
  const url = assertAnalyticsUrl(urlString);
  const endpoint = url.pathname;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": deps.apiVersion || getLinkedInApiVersion(),
        "X-Restli-Protocol-Version": "2.0.0"
      },
      signal: controller.signal
    });
  } catch (err) {
    throw liError(LI_ERROR_CODES.NETWORK,
      err?.name === "AbortError"
        ? "LinkedIn analytics call timed out"
        : "LinkedIn analytics network call failed",
      { endpoint, cause: err?.name || "Error" });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let bodyText = "";
    try { bodyText = await res.text(); } catch { /* body unavailable */ }
    throw classifyLinkedInFailure(res.status, bodyText, endpoint);
  }
  try {
    return await res.json();
  } catch {
    throw liError(LI_ERROR_CODES.ENDPOINT_ERROR,
      "LinkedIn analytics returned unparseable JSON", { endpoint });
  }
}

// ── Public surface ────────────────────────────────────────────
export async function fetchShareStatistics(accessToken, orgUrn, postUrn, deps = {}) {
  const raw = await liGet(buildShareStatsUrl(orgUrn, postUrn, deps.base), accessToken, deps);
  return mapShareStatistics(raw);
}

export async function fetchFollowerStatistics(accessToken, orgUrn, deps = {}) {
  const raw = await liGet(buildFollowerStatsUrl(orgUrn, deps.base), accessToken, deps);
  return mapFollowerStatistics(raw);
}
