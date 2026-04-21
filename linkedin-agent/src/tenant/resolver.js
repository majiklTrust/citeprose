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

import { findTenantByAuthIdentity, findPendingInviteByEmail, claimInvite } from "./platform-db.js";

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

    // ── Path 1: Existing membership ──────────────────────────
    const tenant = await findTenantByAuthIdentity(provider, req.user.sub);
    if (tenant) {
      req.tenant = tenant;
      return next();
    }

    // ── Path 2: Invite claim ─────────────────────────────────
    // No membership found. Before returning 403, check if the
    // user's email matches a pending invite. If so, create a
    // membership from the invite and proceed.
    //
    // req.user.email comes from Auth0's userinfo endpoint via
    // the session cookie. It may be null for some social logins.
    const email = req.user.email;
    if (email) {
      try {
        const invite = await findPendingInviteByEmail(email);
        if (invite) {
          const claimed = await claimInvite(invite.id, provider, req.user.sub);
          if (claimed) {
            req.tenant = claimed;
            req.inviteClaimed = true;
            return next();
          }
        }
      } catch {
        // Claim failed — fall through to 403.
        // Do not expose the error to the client.
      }
    }

    res.status(403).json({ error: "No tenant membership for this identity" });
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
