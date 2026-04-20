// ═══════════════════════════════════════════════════════════════
// src/tenant/resolver.js — Express middleware: auth → tenant
// ═══════════════════════════════════════════════════════════════
// Runs AFTER requireAuth. Reads req.user.sub and req.user.provider,
// looks up the membership in the platform tables, and attaches
// req.tenant. Returns 403 if no user or no membership found.
//
// Usage in Express app setup:
//   import { createTenantResolver } from './tenant/resolver.js';
//   app.use('/api', requireAuth, createTenantResolver());
//
// req.tenant shape after resolution:
//   { id, slug, name, status, role, created_at, updated_at }
// ═══════════════════════════════════════════════════════════════

import { findTenantByAuthIdentity } from "./platform-db.js";

export function createTenantResolver() {
  return async function tenantResolver(req, res, next) {
    // No authenticated user — cannot resolve tenant
    if (!req.user || !req.user.sub) {
      res.status(403).json({ error: "Authentication required for tenant resolution" });
      return;
    }

    // Determine the auth provider. The middleware upstream may
    // set req.user.provider explicitly, or we can infer it from
    // the sub prefix (auth0|..., google-oauth2|..., etc.).
    const provider = req.user.provider || inferProvider(req.user.sub);
    if (!provider) {
      res.status(403).json({ error: "Unable to determine auth provider" });
      return;
    }

    // Look up the membership → tenant mapping
    const tenant = await findTenantByAuthIdentity(provider, req.user.sub);
    if (!tenant) {
      res.status(403).json({ error: "No tenant membership for this identity" });
      return;
    }

    req.tenant = tenant;
    next();
  };
}

// Infer auth provider from the sub string prefix.
// Auth0 subs look like "auth0|abc123" or "google-oauth2|abc123".
// WorkOS subs look like "user_01H...".
// Returns null if unrecognizable — caller handles the error.
function inferProvider(sub) {
  if (!sub || typeof sub !== "string") return null;
  if (sub.startsWith("auth0|") || sub.startsWith("google-oauth2|")) {
    return "auth0";
  }
  if (sub.startsWith("user_")) {
    return "workos";
  }
  return null;
}
