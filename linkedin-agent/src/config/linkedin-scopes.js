// =================================================================
// src/config/linkedin-scopes.js, OAuth scope single source of truth
// =================================================================
// The full set of confirmed, granted LinkedIn scopes (13). Per
// FR-CC-03, authorization requests the same confirmed scopes and
// never a reduced default set; end users receive the abilities the
// token allows. Keeping this list in one dependency-free module
// makes it the single source of truth, keeps it testable without
// the vendor HTTP client, and gives per-tenant OAuth work a clean
// seam later.
//
// Grouped for readability only. LinkedIn ignores order.
// =================================================================

export const LINKEDIN_OAUTH_SCOPES = Object.freeze([
  // Identity (OIDC)
  "openid",
  "profile",
  "email",
  "r_basicprofile",
  "r_1st_connections_size",
  // Member posting
  "w_member_social",
  // Organization read and posting
  "r_organization_social",
  "w_organization_social",
  "r_organization_admin",
  "rw_organization_admin",
  // Advertising
  "r_ads",
  "rw_ads",
  "r_ads_reporting"
]);

// Space-delimited scope string for the OAuth "scope" parameter.
export function getLinkedInScopeString() {
  return LINKEDIN_OAUTH_SCOPES.join(" ");
}

// The MEMBER personal-connection scope set (TD-2, corrected model:
// per connection type, not per role). Every member personal
// connection, any role including owner, consents to exactly this
// minimal set: identity plus personal posting plus the reach
// metric. Ads and organization scopes stay on the tenant
// connection only; a member never grants abilities their advocacy
// participation cannot use.
export const LINKEDIN_MEMBER_OAUTH_SCOPES = Object.freeze([
  "openid",
  "profile",
  "email",
  "r_basicprofile",
  "r_1st_connections_size",
  "w_member_social"
]);

export function getLinkedInMemberScopeString() {
  return LINKEDIN_MEMBER_OAUTH_SCOPES.join(" ");
}
